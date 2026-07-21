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
    let (out, db_rename) =
        run_blocking(move || rename_subtree(&sequence_path, &new_name, /* is_sequence */ true))
            .await?;
    apply_db_rename(db_rename).await;
    Ok(out)
}

#[tauri::command]
pub async fn shot_rename(shot_path: String, new_name: String) -> AppResult<String> {
    let (out, db_rename) =
        run_blocking(move || rename_subtree(&shot_path, &new_name, /* is_sequence */ false))
            .await?;
    apply_db_rename(db_rename).await;
    Ok(out)
}

/// (project_root, old_rel, new_rel) for the DB's rel_path prefix rewrite —
/// computed by `rename_subtree` (sync, mid-rename) and applied by the async
/// command wrapper afterward, mirroring image.rs's `RelinkInfo`/`apply_relinks`.
type DbRenamePrefix = (PathBuf, String, String);

async fn apply_db_rename(info: Option<DbRenamePrefix>) {
    if let Some((root, old_rel, new_rel)) = info {
        if let Err(e) = crate::db::asset_rename_prefix(&root, &old_rel, &new_rel).await {
            tracing::warn!("asset rename-prefix failed for {old_rel} -> {new_rel}: {e}");
        }
    }
}

/// Rename a sequence or shot folder and keep every reference to it valid.
/// Phases: (1) rename the folder on disk; (2) rewrite the absolute path stored
/// inside each JSON sidecar in the subtree so they point at the new location;
/// (3) remap the project's visible-set entries from the old prefix to the new.
fn rename_subtree(
    old_path: &str,
    new_name: &str,
    is_sequence: bool,
) -> AppResult<(String, Option<DbRenamePrefix>)> {
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
        return Ok((as_str(&old), None));
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

    // 3) Rewrite the project.json visible[] prefix entries, and hand back the
    //    same old/new rel prefixes for the DB's rel_path rewrite (step 4,
    //    applied by the async command wrapper — this fn is sync).
    let mut db_rename = None;
    if let Ok(project_root) = project_root_for(&new_path) {
        if let (Some(old_rel), Some(new_rel)) = (
            old.strip_prefix(&project_root).ok().map(as_str),
            new_path.strip_prefix(&project_root).ok().map(as_str),
        ) {
            if let Err(e) = visible_set_rename_prefix(&project_root, &old_rel, &new_rel) {
                tracing::warn!("visible-set prefix rename failed: {e}");
            }
            db_rename = Some((project_root, old_rel, new_rel));
        }
    }

    Ok((new_prefix, db_rename))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::fsutil::PROJECT_SIDECAR;
    use crate::db::{self, AssetRecord};
    use crate::domain::ProjectSidecar;
    use std::fs;

    fn test_project() -> (PathBuf, String) {
        let project_id = format!("test-rename-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(&project_id);
        fs::create_dir_all(&root).unwrap();
        let sidecar = ProjectSidecar {
            project_id: project_id.clone(),
            ..Default::default()
        };
        write_json_atomic(&root.join(PROJECT_SIDECAR), &sidecar).unwrap();
        (root, project_id)
    }

    fn cleanup(root: &Path, project_id: &str) {
        let _ = fs::remove_dir_all(root);
        if let Ok(dir) = crate::paths::appdata_dir() {
            let _ = fs::remove_file(dir.join("db").join(format!("{project_id}.db")));
        }
    }

    #[tokio::test]
    async fn shot_rename_rewrites_the_indexed_assets_rel_path_prefix() {
        let (root, project_id) = test_project();
        let shot_dir = root.join("seq1").join("shot1");
        fs::create_dir_all(&shot_dir).unwrap();

        db::asset_upsert(
            &root,
            AssetRecord {
                id: "asset-1".to_string(),
                rel_path: "seq1/shot1/gen001/img.png".to_string(),
                kind: "image".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let new_path = shot_rename(as_str(&shot_dir), "shot1-renamed".to_string())
            .await
            .unwrap();
        assert!(new_path.ends_with("shot1-renamed"));

        let row = db::asset_lookup(&root, Some("asset-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.rel_path, "seq1/shot1-renamed/gen001/img.png");

        cleanup(&root, &project_id);
    }
}
