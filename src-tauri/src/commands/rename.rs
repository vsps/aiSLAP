//! Sequence/shot rename: folder rename on disk plus the sidecar path cascade
//! (JSON path rewrites in the subtree, visible-set prefix remap).

use std::path::{Path, PathBuf};

use crate::commands::fsutil::{as_str, project_root_for, sanitize, SEQUENCE_SIDECAR, SHOT_SIDECAR};
use crate::commands::visible::visible_set_rename_prefix;
use crate::domain::{SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{
    read_json_or_default as read_sidecar, write_json_atomic,
    write_json_atomic as write_sidecar_atomic,
};

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
            write_json_atomic(path, &value)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn sequence_rename(sequence_path: String, new_name: String) -> AppResult<String> {
    run_blocking(move || rename_subtree(&sequence_path, &new_name, /* is_sequence */ true)).await
}

#[tauri::command]
pub async fn shot_rename(shot_path: String, new_name: String) -> AppResult<String> {
    run_blocking(move || rename_subtree(&shot_path, &new_name, /* is_sequence */ false)).await
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
            if let Err(e) = write_sidecar_atomic(&sidecar_path, &sidecar) {
                tracing::warn!("sequence sidecar name update failed: {e}");
            }
        }
    } else {
        let sidecar_path = new_path.join(SHOT_SIDECAR);
        if let Ok(mut sidecar) = read_sidecar::<ShotSidecar>(&sidecar_path) {
            sidecar.name = trimmed.to_string();
            if let Err(e) = write_sidecar_atomic(&sidecar_path, &sidecar) {
                tracing::warn!("shot sidecar name update failed: {e}");
            }
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
            if let Err(e) = visible_set_rename_prefix(&project_root, &old_rel, &new_rel) {
                tracing::warn!("visible-set prefix rename failed: {e}");
            }
        }
    }

    Ok(new_prefix)
}
