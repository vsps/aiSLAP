//! Project / sequence / shot lifecycle: open, create, rename (with sidecar
//! path cascade), version allocation, prompt-history appends, the project
//! script, and per-shot sidecar fields.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use crate::commands::fsutil::{
    as_str, list_dirs, sanitize, version_number, version_prefix_for, PROJECT_SIDECAR,
    SEQUENCE_SIDECAR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::gallery::scan_shot_columns;
use crate::commands::visible::visible_set_rename_prefix;
use crate::commands::fsutil::project_root_for;
use crate::domain::{
    GalleryColumn, ProjectSidecar, PromptEntry, SequenceSidecar, ShotSidecar,
};
use crate::error::{AppError, AppResult};
use crate::fsjson::{
    ensure_dir, read_json_or_default as read_sidecar, write_json_atomic as write_sidecar_atomic,
};

// ---------- Project / sequence / shot open + create ----------

#[tauri::command]
pub fn project_open(project_path: String) -> AppResult<Vec<String>> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    // Reject folders that are clearly sequences or shots, not projects.
    if root.join(SEQUENCE_SIDECAR).exists() || root.join(SHOT_SIDECAR).exists() {
        return Err(AppError::Msg("NOT A PROJECT FOLDER".into()));
    }
    // Auto-create project.json on first open (new project or migration).
    let sidecar_path = root.join(PROJECT_SIDECAR);
    if !sidecar_path.exists() {
        let title = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project")
            .to_string();
        write_sidecar_atomic(
            &sidecar_path,
            &ProjectSidecar {
                title,
                created: Utc::now().to_rfc3339(),
                visible: vec![],
                version_prefix: "gen".into(),
            },
        )?;
    }
    let dirs = list_dirs(&root)?;
    Ok(dirs.iter().map(|p| as_str(p)).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceOpenResult {
    pub shots: Vec<String>,
    pub sidecar: SequenceSidecar,
}

#[tauri::command]
pub fn sequence_open(sequence_path: String) -> AppResult<SequenceOpenResult> {
    let root = PathBuf::from(&sequence_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {sequence_path}")));
    }
    let sidecar: SequenceSidecar = read_sidecar(&root.join(SEQUENCE_SIDECAR))?;
    let dirs = list_dirs(&root)?;
    let shots = dirs
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n != SRC_DIR)
                .unwrap_or(false)
        })
        .map(|p| as_str(&p))
        .collect();
    Ok(SequenceOpenResult { shots, sidecar })
}

#[tauri::command]
pub fn sequence_create(project_path: String, name: String) -> AppResult<String> {
    let target = PathBuf::from(&project_path).join(sanitize(&name));
    ensure_dir(&target)?;
    let sidecar_path = target.join(SEQUENCE_SIDECAR);
    if !sidecar_path.exists() {
        write_sidecar_atomic(
            &sidecar_path,
            &SequenceSidecar {
                name: name.clone(),
                prompt_history: vec![],
            },
        )?;
    }
    Ok(as_str(&target))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotOpenResult {
    pub columns: Vec<GalleryColumn>,
    pub sidecar: ShotSidecar,
}

#[tauri::command]
pub fn shot_open(shot_path: String) -> AppResult<ShotOpenResult> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let sidecar: ShotSidecar = read_sidecar(&root.join(SHOT_SIDECAR))?;
    let columns = scan_shot_columns(&root)?;
    Ok(ShotOpenResult { columns, sidecar })
}

#[tauri::command]
pub fn shot_create(sequence_path: String, name: String) -> AppResult<String> {
    let target = PathBuf::from(&sequence_path).join(sanitize(&name));
    ensure_dir(&target)?;
    let prefix = version_prefix_for(&target);
    ensure_dir(&target.join(format!("{}001", prefix)))?;
    let sidecar_path = target.join(SHOT_SIDECAR);
    if !sidecar_path.exists() {
        write_sidecar_atomic(
            &sidecar_path,
            &ShotSidecar {
                name,
                prompt_history: vec![],
                clip_media_path: None,
                version_selects: Default::default(),
                version_comments: Default::default(),
            },
        )?;
    }
    Ok(as_str(&target))
}

// ---------- Rename (with sidecar path cascade) ----------

/// Recursively walk every `*.json` file under `dir`, invoking `cb` with each path.
/// Errors from a single file are surfaced (no swallowing) — callers can choose
/// to wrap with `.ok()` if best-effort semantics are wanted.
fn walk_json_files(dir: &Path, cb: &mut dyn FnMut(&Path) -> AppResult<()>) -> AppResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            walk_json_files(&p, cb)?;
        } else if p.extension().and_then(|s| s.to_str()) == Some("json") {
            cb(&p)?;
        }
    }
    Ok(())
}

/// Recursively rewrite any string value in `v` whose contents start with
/// `old_prefix + "/"` (or equal `old_prefix` exactly) to use `new_prefix`.
/// Returns true if anything changed.
fn rewrite_paths_in_value(
    v: &mut serde_json::Value,
    old_prefix: &str,
    new_prefix: &str,
) -> bool {
    let mut changed = false;
    match v {
        serde_json::Value::String(s) => {
            if s == old_prefix {
                *s = new_prefix.to_string();
                changed = true;
            } else if s.starts_with(old_prefix)
                && s.as_bytes().get(old_prefix.len()) == Some(&b'/')
            {
                *s = format!("{}{}", new_prefix, &s[old_prefix.len()..]);
                changed = true;
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                if rewrite_paths_in_value(item, old_prefix, new_prefix) {
                    changed = true;
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                if rewrite_paths_in_value(val, old_prefix, new_prefix) {
                    changed = true;
                }
            }
        }
        _ => {}
    }
    changed
}

/// Walk every `*.json` under `root` and prefix-rewrite any absolute-path strings.
/// Files that don't parse as JSON are skipped. Files that don't change are not
/// rewritten. `old_prefix` / `new_prefix` should be forward-slash absolute paths
/// without trailing slashes (the standard format `as_str` produces).
fn rewrite_path_strings_in_subtree(
    root: &Path,
    old_prefix: &str,
    new_prefix: &str,
) -> AppResult<()> {
    walk_json_files(root, &mut |path| {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => return Ok(()),
        };
        let mut value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        if rewrite_paths_in_value(&mut value, old_prefix, new_prefix) {
            let bytes = serde_json::to_vec_pretty(&value)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, path)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn sequence_rename(sequence_path: String, new_name: String) -> AppResult<String> {
    rename_subtree(&sequence_path, &new_name, /* is_sequence */ true)
}

#[tauri::command]
pub fn shot_rename(shot_path: String, new_name: String) -> AppResult<String> {
    rename_subtree(&shot_path, &new_name, /* is_sequence */ false)
}

/// Rename a sequence or shot folder and keep every reference to it valid.
/// Phases: (1) rename the folder on disk; (2) rewrite the absolute path stored
/// inside each JSON sidecar in the subtree so they point at the new location;
/// (3) remap the project's visible-set entries from the old prefix to the new.
fn rename_subtree(old_path: &str, new_name: &str, is_sequence: bool) -> AppResult<String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Msg("New name cannot be empty.".into()));
    }
    let sanitized = sanitize(trimmed);
    if sanitized.is_empty() {
        return Err(AppError::Msg("New name has no usable characters.".into()));
    }
    let old = PathBuf::from(old_path);
    if !old.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {old_path}")));
    }
    let current_base = old
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if sanitized == current_base {
        // No-op rename — return the existing path so callers can navigate uniformly.
        return Ok(as_str(&old));
    }
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Msg(format!("no parent for {old_path}")))?;
    let new_path = parent.join(&sanitized);
    if new_path.exists() {
        return Err(AppError::Msg(format!(
            "A folder named '{sanitized}' already exists."
        )));
    }

    let old_prefix = as_str(&old);
    let new_prefix = as_str(&new_path);

    // The Rust-side rename. Atomic on the same filesystem.
    std::fs::rename(&old, &new_path)?;

    // 1) Update the renamed folder's own sidecar `name` field. Best-effort —
    //    if the sidecar is missing or unreadable we still want the rename to
    //    succeed; the user can fix it later.
    if is_sequence {
        let sidecar_path = new_path.join(SEQUENCE_SIDECAR);
        if let Ok(mut sidecar) = read_sidecar::<SequenceSidecar>(&sidecar_path) {
            sidecar.name = trimmed.to_string();
            let _ = write_sidecar_atomic(&sidecar_path, &sidecar);
        }
    } else {
        let sidecar_path = new_path.join(SHOT_SIDECAR);
        if let Ok(mut sidecar) = read_sidecar::<ShotSidecar>(&sidecar_path) {
            sidecar.name = trimmed.to_string();
            let _ = write_sidecar_atomic(&sidecar_path, &sidecar);
        }
    }

    // 2) Cascade-rewrite every absolute path inside JSON sidecars under the
    //    renamed subtree (shot.json clip_media_path, timeline.json clip
    //    shotPaths, image metadata sidecars).
    rewrite_path_strings_in_subtree(&new_path, &old_prefix, &new_prefix)?;

    // 3) Rewrite the project.json visible[] prefix entries.
    if let Ok(project_root) = project_root_for(&new_path) {
        if let (Some(old_rel), Some(new_rel)) = (
            old.strip_prefix(&project_root).ok().map(as_str),
            new_path.strip_prefix(&project_root).ok().map(as_str),
        ) {
            let _ = visible_set_rename_prefix(&project_root, &old_rel, &new_rel);
        }
    }

    Ok(new_prefix)
}

// ---------- Versions ----------

#[tauri::command]
pub fn version_create_next(shot_path: String) -> AppResult<String> {
    let root = PathBuf::from(&shot_path);
    let mut max_n = 0u32;
    if let Ok(it) = std::fs::read_dir(&root) {
        for e in it.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if let Some(n) = version_number(name) {
                    if n > max_n {
                        max_n = n;
                    }
                }
            }
        }
    }
    let next = format!("{}{:03}", version_prefix_for(&root), max_n + 1);
    ensure_dir(&root.join(&next))?;
    Ok(next)
}

#[tauri::command]
pub fn shot_version_select_set(
    shot_path: String,
    version: String,
    filename: Option<String>,
) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let sidecar_path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&sidecar_path)?;
    match filename {
        Some(f) if !f.is_empty() => {
            sidecar.version_selects.insert(version, f);
        }
        _ => {
            sidecar.version_selects.remove(&version);
        }
    }
    write_sidecar_atomic(&sidecar_path, &sidecar)?;
    Ok(sidecar)
}

// ---------- Prompt history ----------

#[tauri::command]
pub fn sequence_prompt_append(sequence_path: String, prompt: String) -> AppResult<SequenceSidecar> {
    let root = PathBuf::from(&sequence_path);
    let path = root.join(SEQUENCE_SIDECAR);
    let mut sidecar: SequenceSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(prompt.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt,
            prompts: None,
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_prompt_append(shot_path: String, prompt: String) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(prompt.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt,
            prompts: None,
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_prompts_append(shot_path: String, prompts: Vec<String>) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    let combined = prompts.join("\n\n");
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(combined.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt: combined,
            prompts: Some(prompts),
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

// ---------- Project script ----------

const SCRIPT_FILE: &str = "script.md";
const DEFAULT_SCRIPT: &str = "# Sequence 1\n\n## Shot 1\n\n## Shot 2\n\n## Shot 3\n";

#[tauri::command]
pub fn script_read(project_path: String) -> AppResult<String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let p = root.join(SCRIPT_FILE);
    if !p.exists() {
        std::fs::write(&p, DEFAULT_SCRIPT)?;
        return Ok(DEFAULT_SCRIPT.to_string());
    }
    Ok(std::fs::read_to_string(&p)?)
}

#[tauri::command]
pub fn script_write(project_path: String, content: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    std::fs::write(root.join(SCRIPT_FILE), content)?;
    Ok(())
}

// ---------- Misc dirs ----------

#[tauri::command]
pub fn dir_ensure(path: String) -> AppResult<()> {
    ensure_dir(&PathBuf::from(path))
}

#[tauri::command]
pub fn dirs_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).is_dir()).collect()
}

// ---------- Project / shot sidecar fields ----------

/// Read the project's configured version-folder prefix (defaults to "gen"
/// for projects without the field set).
#[tauri::command]
pub fn project_version_prefix_get(project_path: String) -> AppResult<String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let sidecar: ProjectSidecar =
        read_sidecar(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
    Ok(if sidecar.version_prefix.is_empty() {
        "gen".into()
    } else {
        sidecar.version_prefix
    })
}

/// Set the project's version-folder prefix. Accepts ASCII letters plus `_`/`-`
/// only (must start with a letter). Existing folders are not renamed; only
/// newly-minted version folders use the new prefix.
#[tauri::command]
pub fn project_version_prefix_set(project_path: String, prefix: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let trimmed = prefix.trim().to_string();
    let valid = !trimmed.is_empty()
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-');
    if !valid {
        return Err(AppError::Msg(
            "Prefix must start with a letter and contain only letters, `_`, or `-`."
                .into(),
        ));
    }
    let path = root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_sidecar(&path)?;
    sidecar.version_prefix = trimmed;
    write_sidecar_atomic(&path, &sidecar)
}

#[tauri::command]
pub fn shot_clip_media_set(shot_path: String, media_path: Option<String>) -> AppResult<()> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    sidecar.clip_media_path = media_path;
    write_sidecar_atomic(&path, &sidecar)
}

/// Set or clear the short comment associated with a version folder. Trimmed
/// empty input removes the entry; the version folder itself is never renamed.
#[tauri::command]
pub fn shot_version_comment_set(
    shot_path: String,
    version: String,
    comment: Option<String>,
) -> AppResult<()> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    let trimmed = comment.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        sidecar.version_comments.remove(&version);
    } else {
        sidecar.version_comments.insert(version, trimmed);
    }
    write_sidecar_atomic(&path, &sidecar)
}
