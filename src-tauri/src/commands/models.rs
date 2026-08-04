use serde::Deserialize;
use serde_json::Value;

use crate::domain::{ModelEntry, ModelInput, ModelNode, ModelOutput, RefRoleSpec};
use crate::error::AppResult;
use crate::paths;

// Shape of the on-disk model file (family-level wrapper).
#[derive(Debug, Deserialize)]
struct ModelFile {
    #[serde(default)]
    family: String,
    #[serde(default)]
    category: String,
    /// Optional top-level provider; nodes inherit unless they override.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    nodes: Vec<RawNode>,
}

#[derive(Debug, Deserialize)]
struct RawNode {
    id: String,
    name: String,
    endpoint: String,
    #[serde(default)]
    inputs: Vec<ModelInput>,
    #[serde(default)]
    outputs: Vec<ModelOutput>,
    #[serde(default)]
    ref_roles: Option<Vec<RefRoleSpec>>,
    #[serde(default)]
    parameters: Vec<Value>,
    // Optional forward-compat: if a model file starts declaring these, pass through.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    batch_field: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

fn infer_kind(outputs: &[ModelOutput], declared: &Option<String>) -> String {
    if let Some(k) = declared {
        return k.clone();
    }
    if outputs.iter().any(|o| o.data_type.eq_ignore_ascii_case("MODEL_3D")) {
        return "model3d".into();
    }
    let any_video = outputs.iter().any(|o| o.data_type.eq_ignore_ascii_case("VIDEO"));
    if any_video { "video".into() } else { "image".into() }
}

fn infer_batch_field(parameters: &[Value], declared: &Option<String>) -> Option<String> {
    if let Some(b) = declared {
        return Some(b.clone());
    }
    for p in parameters {
        let api_field = p.get("api_field").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(api_field, "num_images" | "num_samples" | "n" | "batch_size") {
            return Some(api_field.to_string());
        }
    }
    None
}

/// Annotate ref_roles with exclusive/named defaults so the UI doesn't need to know every
/// legacy model. start/end → exclusive; "element" → named.
fn annotate_roles(roles: Option<Vec<RefRoleSpec>>) -> Option<Vec<RefRoleSpec>> {
    roles.map(|rs| {
        rs.into_iter()
            .map(|mut r| {
                if r.exclusive.is_none() && (r.role == "start" || r.role == "end") {
                    r.exclusive = Some(true);
                }
                if r.named.is_none() && r.role == "element" {
                    r.named = Some(true);
                }
                r
            })
            .collect()
    })
}

/// Walk `dir` and return JSON files at the top level plus one level deep.
/// Subfolders are organisational (typically `<provider>/`); deeper nesting is
/// ignored to keep the layout legible.
fn collect_model_files(dir: &std::path::Path) -> AppResult<Vec<std::path::PathBuf>> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut top: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    top.sort_by_key(|e| e.file_name());
    for entry in top {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            let mut nested: Vec<_> = match std::fs::read_dir(&path) {
                Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
                Err(_) => continue,
            };
            nested.sort_by_key(|e| e.file_name());
            for ne in nested {
                let np = ne.path();
                if !np.is_file() {
                    continue;
                }
                if np.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false) {
                    out.push(np);
                }
            }
        } else if path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn models_load(app: tauri::AppHandle) -> AppResult<Vec<ModelEntry>> {
    let dir = paths::models_dir(&app)?;
    tracing::info!("loading models from {}", dir.display());
    let mut entries = Vec::new();

    let files = collect_model_files(&dir)?;

    for path in files {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let file: ModelFile = match serde_json::from_str(&text) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for raw in file.nodes {
            let kind = infer_kind(&raw.outputs, &raw.kind);
            let batch_field = infer_batch_field(&raw.parameters, &raw.batch_field);
            let provider = raw.provider.clone().or_else(|| file.provider.clone());
            let node = ModelNode {
                id: raw.id,
                name: raw.name,
                endpoint: raw.endpoint,
                kind,
                inputs: raw.inputs,
                outputs: raw.outputs,
                ref_roles: annotate_roles(raw.ref_roles),
                parameters: raw.parameters,
                batch_field,
                provider,
            };
            entries.push(ModelEntry {
                family: file.family.clone(),
                category: file.category.clone(),
                node,
            });
        }
    }

    Ok(entries)
}
