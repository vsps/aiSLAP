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
    if outputs
        .iter()
        .any(|o| o.data_type.eq_ignore_ascii_case("MODEL_3D"))
    {
        return "model3d".into();
    }
    let any_video = outputs
        .iter()
        .any(|o| o.data_type.eq_ignore_ascii_case("VIDEO"));
    if any_video {
        "video".into()
    } else {
        "image".into()
    }
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
                if np
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
                {
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

/// The registry ships as a bundle resource, and `models_load` skips anything it
/// cannot read or parse — silently, by design, so one bad file never stops the
/// app booting. The cost of that choice is that a malformed model simply
/// disappears from the picker, and the only signal is the `models: N` count in
/// the status bar. These tests are the guard: they turn "a model vanished from
/// a release build" into a failing PR.
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn models_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .join("models")
    }

    #[test]
    fn every_shipped_model_file_parses_and_declares_nodes() {
        let files = collect_model_files(&models_root()).expect("models/ is readable");
        assert!(
            files.len() >= 20,
            "expected the registry to be discovered, found {} files",
            files.len()
        );

        for path in files {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{} is unreadable: {e}", path.display()));
            let file: ModelFile = serde_json::from_str(&text).unwrap_or_else(|e| {
                panic!(
                    "{} does not parse — it would silently vanish from the picker: {e}",
                    path.display()
                )
            });

            // A file whose nodes fail to deserialize takes the *whole file*
            // with it, so an empty node list is almost always a mistake.
            assert!(
                !file.nodes.is_empty(),
                "{} declares no nodes",
                path.display()
            );
            // Empty family/category load fine but render as unlabelled picker
            // entries — a silent misbehaviour rather than an error.
            assert!(
                !file.family.trim().is_empty(),
                "{} has an empty family",
                path.display()
            );
            assert!(
                !file.category.trim().is_empty(),
                "{} has an empty category",
                path.display()
            );

            let mut seen = HashSet::new();
            for node in &file.nodes {
                for (field, value) in [
                    ("id", &node.id),
                    ("name", &node.name),
                    ("endpoint", &node.endpoint),
                ] {
                    assert!(
                        !value.trim().is_empty(),
                        "{}: node {:?} has an empty {field}",
                        path.display(),
                        node.id
                    );
                }
                assert!(
                    seen.insert(node.id.clone()),
                    "{} declares node id {:?} twice",
                    path.display(),
                    node.id
                );
            }
        }
    }

    /// `kind` is inferred from outputs when omitted, and every shipped file
    /// omits it — so a 3D model that forgets its `MODEL_3D` output silently
    /// renders as an image. Pin the inference and the fact it is load-bearing.
    #[test]
    fn kind_inference_is_load_bearing_for_every_shipped_node() {
        let out = |dt: &str| ModelOutput {
            name: "out".into(),
            data_type: dt.into(),
            api_field: "images".into(),
        };

        assert_eq!(infer_kind(&[out("MODEL_3D")], &None), "model3d");
        assert_eq!(infer_kind(&[out("VIDEO")], &None), "video");
        assert_eq!(infer_kind(&[out("IMAGE")], &None), "image");
        assert_eq!(infer_kind(&[], &None), "image");
        // MODEL_3D wins over VIDEO regardless of order.
        assert_eq!(
            infer_kind(&[out("VIDEO"), out("MODEL_3D")], &None),
            "model3d"
        );
        // A declared kind always wins.
        assert_eq!(infer_kind(&[out("IMAGE")], &Some("video".into())), "video");

        let files = collect_model_files(&models_root()).expect("models/ is readable");
        let mut declared = 0usize;
        for path in &files {
            let text = std::fs::read_to_string(path).expect("readable");
            let file: ModelFile = serde_json::from_str(&text).expect("parses");
            declared += file.nodes.iter().filter(|n| n.kind.is_some()).count();
        }
        assert_eq!(
            declared, 0,
            "a model file started declaring `kind`; docs/model-registry.md says none do"
        );
    }

    /// start/end become exclusive and element becomes named unless the file
    /// opts out. The UI relies on this rather than special-casing each model.
    #[test]
    fn ref_role_defaults_are_annotated() {
        let role = |r: &str| RefRoleSpec {
            role: r.into(),
            api_field: "image_url".into(),
            max: None,
            exclusive: None,
            named: None,
        };
        let annotated = annotate_roles(Some(vec![
            role("start"),
            role("end"),
            role("element"),
            role("source"),
        ]))
        .expect("some");

        assert_eq!(annotated[0].exclusive, Some(true), "start is exclusive");
        assert_eq!(annotated[1].exclusive, Some(true), "end is exclusive");
        assert_eq!(annotated[2].named, Some(true), "element is named");
        assert_eq!(annotated[3].exclusive, None, "source is untouched");
        assert_eq!(annotated[3].named, None, "source is untouched");

        // An explicit value always wins over the default.
        let mut opted_out = role("start");
        opted_out.exclusive = Some(false);
        let annotated = annotate_roles(Some(vec![opted_out])).expect("some");
        assert_eq!(annotated[0].exclusive, Some(false));
    }

    #[test]
    fn batch_field_is_inferred_from_the_known_api_field_names() {
        let param = |api_field: &str| serde_json::json!({ "api_field": api_field });

        for name in ["num_images", "num_samples", "n", "batch_size"] {
            assert_eq!(
                infer_batch_field(&[param(name)], &None),
                Some(name.to_string()),
                "{name} should be recognised as a batch field"
            );
        }
        // Anything else is silently not a batch field — declare it explicitly.
        assert_eq!(infer_batch_field(&[param("count")], &None), None);
        assert_eq!(
            infer_batch_field(&[param("count")], &Some("count".into())),
            Some("count".into())
        );
    }
}
