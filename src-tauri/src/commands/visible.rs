//! The project's "visible set" (starred/favorite images) stored in
//! `project.json`. Entries are forward-slash paths relative to project root.

use std::collections::HashSet;
use std::path::Path;

use crate::commands::fsutil::{as_str, project_root_for, relativize, PROJECT_SIDECAR};
use crate::domain::ProjectSidecar;
use crate::error::AppResult;
use crate::fsjson::{read_json_or_default, write_json_atomic};

pub(crate) fn load_visible_set(project_root: &Path) -> AppResult<HashSet<String>> {
    let sidecar: ProjectSidecar = read_json_or_default(&project_root.join(PROJECT_SIDECAR))?;
    Ok(sidecar.visible.into_iter().collect())
}

pub(crate) fn save_visible_set(project_root: &Path, visible: &HashSet<String>) -> AppResult<()> {
    let path = project_root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_json_or_default(&path)?;
    let mut v: Vec<String> = visible.iter().cloned().collect();
    v.sort();
    sidecar.visible = v;
    write_json_atomic(&path, &sidecar)
}

/// Rewrite the prefix of every entry in the project's visible set. Entries
/// whose value equals `old_rel` (exact) or starts with `old_rel + "/"` are
/// rewritten to use `new_rel`. Best-effort: no-op if there's no project root.
pub(crate) fn visible_set_rename_prefix(
    project_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> AppResult<()> {
    let old_clean = old_rel.trim_end_matches('/').to_string();
    let new_clean = new_rel.trim_end_matches('/').to_string();
    if old_clean == new_clean {
        return Ok(());
    }
    let mut set = load_visible_set(project_root)?;
    let prefix = format!("{}/", old_clean);
    let mut changed = false;
    let entries: Vec<String> = set.iter().cloned().collect();
    for entry in entries {
        if entry == old_clean {
            set.remove(&entry);
            set.insert(new_clean.clone());
            changed = true;
        } else if entry.starts_with(&prefix) {
            set.remove(&entry);
            let suffix = &entry[prefix.len()..];
            set.insert(format!("{}/{}", new_clean, suffix));
            changed = true;
        }
    }
    if changed {
        save_visible_set(project_root, &set)?;
    }
    Ok(())
}

/// Remove an image (or all images under a directory) from the project's visible
/// set. Best-effort: silently skips if the path is outside any project.
pub fn visible_set_remove_path_or_prefix(path: &Path, is_dir_prefix: bool) -> AppResult<()> {
    let root = match project_root_for(path) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let target = match path
        .strip_prefix(&root)
        .ok()
        .map(as_str)
        .or_else(|| relativize(path, &root))
    {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut set = load_visible_set(&root)?;
    let before = set.len();
    if is_dir_prefix {
        let prefix = format!("{}/", target.trim_end_matches('/'));
        set.retain(|p| !p.starts_with(&prefix));
    } else {
        set.remove(&target);
    }
    if set.len() != before {
        save_visible_set(&root, &set)?;
    }
    Ok(())
}
