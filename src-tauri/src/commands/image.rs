//! Image file operations: copy/move/rename of the media "triple" (primary +
//! `.json` sidecar + `.thumb.png`), version-stack moves, base64 PNG saves,
//! and Explorer reveal.

use std::path::{Path, PathBuf};

use crate::commands::fsutil::{
    as_str, is_media_ext, next_version_name, project_root_for, rel_of, relativize, sidecar_path,
    thumb_path, validate_filename_stem, TransferMode, SEL_DIR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::visible::{visible_set_rekey, visible_set_rekey_one};
use crate::domain::ShotSidecar;
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{ensure_dir, read_json_or_default, write_json_atomic};

#[derive(Clone, Copy)]
enum CollisionPolicy {
    Overwrite,
    Error,
}

fn sibling_paths(p: &Path) -> AppResult<(String, String, PathBuf, PathBuf)> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?
        .to_string();
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no filename".into()))?
        .to_string();
    // Bail if there's no parent — keeps the returned sidecar/thumb paths valid.
    p.parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    Ok((stem, filename, sidecar_path(p), thumb_path(p)))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let na = a.canonicalize().ok();
    let nb = b.canonicalize().ok();
    if let (Some(x), Some(y)) = (na, nb) {
        return x == y;
    }
    as_str(a) == as_str(b)
}

fn transfer_one(mode: TransferMode, src: &Path, dest: &Path) -> std::io::Result<()> {
    match mode {
        TransferMode::Copy => std::fs::copy(src, dest).map(|_| ()),
        TransferMode::Move => move_one(src, dest),
    }
}

fn move_one(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            std::fs::copy(src, dest)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn transfer_triple_to_dir(
    src: &Path,
    dest_dir: &Path,
    mode: TransferMode,
    policy: CollisionPolicy,
) -> AppResult<PathBuf> {
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(src))));
    }
    if !dest_dir.is_dir() {
        ensure_dir(dest_dir)?;
    }
    let src_dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    if same_dir(src_dir, dest_dir) {
        return Err(AppError::Msg(
            "source and destination are the same directory".into(),
        ));
    }
    let (_stem, filename, src_sidecar, src_thumb) = sibling_paths(src)?;
    let dest_primary = dest_dir.join(&filename);
    if dest_primary.exists() && matches!(policy, CollisionPolicy::Error) {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {filename}")));
    }
    transfer_one(mode, src, &dest_primary)?;
    // Sidecar/thumb are best-effort companions; skip silently if unnamed.
    if let (true, Some(name)) = (src_sidecar.exists(), src_sidecar.file_name()) {
        if let Err(e) = transfer_one(mode, &src_sidecar, &dest_dir.join(name)) {
            tracing::warn!("sidecar {} failed: {e}", mode.label());
        }
    }
    if let (true, Some(name)) = (src_thumb.exists(), src_thumb.file_name()) {
        if let Err(e) = transfer_one(mode, &src_thumb, &dest_dir.join(name)) {
            tracing::warn!("thumb {} failed: {e}", mode.label());
        }
    }
    Ok(dest_primary)
}

#[tauri::command]
pub fn ref_copy_to_global_src(shot_path: String, source_path: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let project_dir = PathBuf::from(&shot_path)
        .parent()
        .and_then(|s| s.parent())
        .ok_or_else(|| AppError::Msg("no project parent".into()))?
        .join(SRC_DIR);
    ensure_dir(&project_dir)?;
    let dest = transfer_triple_to_dir(
        &src,
        &project_dir,
        TransferMode::Copy,
        CollisionPolicy::Overwrite,
    )?;
    Ok(as_str(&dest))
}

#[tauri::command]
pub async fn image_copy_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    run_blocking(move || image_copy_to_dir_impl(source_path, dest_dir)).await
}

fn image_copy_to_dir_impl(source_path: String, dest_dir: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = transfer_triple_to_dir(&src, &dest, TransferMode::Copy, CollisionPolicy::Error)?;
    // If source is visible, mark the copy visible too.
    if let Ok(root) = project_root_for(&src) {
        let src_rel = relativize(&src, &root);
        let dest_rel = relativize(&out, &root);
        visible_set_rekey_one(&root, TransferMode::Copy, src_rel, dest_rel)?;
    }
    Ok(as_str(&out))
}

#[tauri::command]
pub async fn image_move_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    run_blocking(move || image_move_to_dir_impl(source_path, dest_dir)).await
}

fn image_move_to_dir_impl(source_path: String, dest_dir: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = transfer_triple_to_dir(&src, &dest, TransferMode::Move, CollisionPolicy::Error)?;
    // Re-key the visible entry if the source was visible. src no longer
    // exists on disk; rel_of falls back to a plain prefix strip of the
    // pre-move path string.
    if let Ok(root) = project_root_for(&out) {
        let src_rel = rel_of(&src, &root);
        let dest_rel = rel_of(&out, &root);
        visible_set_rekey_one(&root, TransferMode::Move, src_rel, dest_rel)?;
    }
    Ok(as_str(&out))
}

#[tauri::command]
pub fn image_rename(source_path: String, new_stem: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {source_path}")));
    }
    let trimmed = new_stem.trim();
    validate_filename_stem(trimmed)?;
    let (old_stem, _filename, old_sidecar, old_thumb) = sibling_paths(&src)?;
    if trimmed == old_stem {
        return Err(AppError::Msg("name unchanged".into()));
    }
    let dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let new_filename = match &ext {
        Some(e) if !e.is_empty() => format!("{trimmed}.{e}"),
        _ => trimmed.to_string(),
    };
    let new_primary = dir.join(&new_filename);
    let new_sidecar = dir.join(format!("{trimmed}.json"));
    let new_thumb = dir.join(format!("{trimmed}.thumb.png"));
    if new_primary.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {new_filename}")));
    }
    if old_sidecar.exists() && new_sidecar.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {trimmed}.json")));
    }
    if old_thumb.exists() && new_thumb.exists() {
        return Err(AppError::Msg(format!(
            "FILENAME_EXISTS: {trimmed}.thumb.png"
        )));
    }
    std::fs::rename(&src, &new_primary)?;
    if old_sidecar.exists() {
        if let Err(e) = std::fs::rename(&old_sidecar, &new_sidecar) {
            tracing::warn!("sidecar rename failed: {e}");
        }
    }
    if old_thumb.exists() {
        if let Err(e) = std::fs::rename(&old_thumb, &new_thumb) {
            tracing::warn!("thumb rename failed: {e}");
        }
    }
    // Re-key visible entry if present.
    if let Ok(root) = project_root_for(&new_primary) {
        let old_rel = rel_of(&src, &root);
        let new_rel = rel_of(&new_primary, &root);
        visible_set_rekey_one(&root, TransferMode::Move, old_rel, new_rel)?;
    }
    Ok(as_str(&new_primary))
}

/// Move (or copy) every image file (plus its sidecar/thumb) from
/// `src_shot/src_version/` into `dst_shot/dst_version/`. When `dst_version` is
/// None or empty, the next version on `dst_shot` is allocated.
/// Returns the destination version's absolute path.
#[tauri::command]
pub async fn version_stack_move(
    src_shot: String,
    src_version: String,
    dst_shot: String,
    dst_version: Option<String>,
    copy: bool,
) -> AppResult<String> {
    run_blocking(move || {
        version_stack_move_impl(src_shot, src_version, dst_shot, dst_version, copy)
    })
    .await
}

fn version_stack_move_impl(
    src_shot: String,
    src_version: String,
    dst_shot: String,
    dst_version: Option<String>,
    copy: bool,
) -> AppResult<String> {
    let src_dir = PathBuf::from(&src_shot).join(&src_version);
    if !src_dir.is_dir() {
        return Err(AppError::Msg(format!(
            "not a directory: {}",
            as_str(&src_dir)
        )));
    }

    let dst_root = PathBuf::from(&dst_shot);
    let dst_version_name = match dst_version {
        Some(v) if !v.is_empty() => v,
        _ => next_version_name(&dst_root),
    };
    let dst_dir = dst_root.join(&dst_version_name);
    ensure_dir(&dst_dir)?;

    let same = match (src_dir.canonicalize(), dst_dir.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return Ok(as_str(&dst_dir));
    }

    // Collect the media files (skip thumbs/json — they move as siblings).
    let mut moves: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(&src_dir)? {
        let entry = e?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let filename = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if filename.ends_with(".thumb.png") {
            continue;
        }
        if !is_media_ext(&p) {
            continue;
        }
        moves.push(p);
    }

    // Capture rel paths before the source files disappear, so we can update the
    // visible set after the moves succeed.
    let project_root = project_root_for(&dst_dir).ok();
    let mut rel_pairs: Vec<(String, String)> = Vec::new();
    if let Some(root) = project_root.as_ref() {
        for src in &moves {
            let filename = match src.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let src_rel = rel_of(src, root);
            let dst_abs = dst_dir.join(&filename);
            let dst_rel = rel_of(&dst_abs, root);
            if let (Some(s), Some(d)) = (src_rel, dst_rel) {
                rel_pairs.push((s, d));
            }
        }
    }

    let mode = if copy {
        TransferMode::Copy
    } else {
        TransferMode::Move
    };
    for src in &moves {
        transfer_triple_to_dir(src, &dst_dir, mode, CollisionPolicy::Error)?;
    }

    // Update the visible set: a move re-keys src -> dst; a copy adds dst
    // alongside src (the source file is still there and still visible).
    if let Some(root) = project_root.as_ref() {
        visible_set_rekey(root, mode, &rel_pairs)?;
    }

    // Clearing the source's pinned select only makes sense for a move — a
    // copy leaves the source stack (and its select) untouched.
    if !copy {
        let src_sidecar_path = PathBuf::from(&src_shot).join(SHOT_SIDECAR);
        if src_sidecar_path.exists() {
            let mut sidecar: ShotSidecar = read_json_or_default(&src_sidecar_path)?;
            if sidecar.version_selects.remove(&src_version).is_some() {
                write_json_atomic(&src_sidecar_path, &sidecar)?;
            }
        }
    }

    Ok(as_str(&dst_dir))
}

// ---------- SEL (Selects) ----------

/// Copy an image (and its .json sidecar) into the shot's SEL folder.
#[tauri::command]
pub async fn image_copy_to_sel(shot_path: String, source_path: String) -> AppResult<String> {
    run_blocking(move || sel_transfer_impl(shot_path, source_path, TransferMode::Copy)).await
}

/// Move an image (and its .json sidecar) into the shot's SEL folder.
#[tauri::command]
pub async fn image_move_to_sel(shot_path: String, source_path: String) -> AppResult<String> {
    run_blocking(move || sel_transfer_impl(shot_path, source_path, TransferMode::Move)).await
}

fn sel_transfer_impl(
    shot_path: String,
    source_path: String,
    mode: TransferMode,
) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(&src))));
    }
    let shot = PathBuf::from(&shot_path);
    let sel_dir = shot.join(SEL_DIR);
    ensure_dir(&sel_dir)?;
    let dest = transfer_triple_to_dir(&src, &sel_dir, mode, CollisionPolicy::Error)?;
    if let Ok(root) = project_root_for(&dest) {
        let src_rel = rel_of(&src, &root);
        let dest_rel = rel_of(&dest, &root);
        if let (Some(s), Some(d)) = (src_rel, dest_rel) {
            visible_set_rekey_one(&root, mode, Some(s), Some(d))?;
        }
    }
    Ok(as_str(&dest))
}

/// Export all SEL folders from the project to a destination directory.
/// `mode`: "preserve" mirrors the project folder structure (dest/SEQ/SHOT/SEL/);
/// "dump" flattens everything into one folder with "seq_shot_" filename prefix.
#[tauri::command]
pub async fn export_selects(
    project_path: String,
    dest_dir: String,
    mode: String,
) -> AppResult<u32> {
    run_blocking(move || export_selects_impl(project_path, dest_dir, mode)).await
}

fn export_selects_impl(project_path: String, dest_dir: String, mode: String) -> AppResult<u32> {
    let project = PathBuf::from(&project_path);
    let dest = PathBuf::from(&dest_dir);
    if !project.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    if !dest.is_dir() {
        ensure_dir(&dest)?;
    }

    let preserve = mode == "preserve";
    let mut copied: u32 = 0;

    // Walk: project / sequence / shot / SEL
    for seq_entry in std::fs::read_dir(&project)? {
        let seq_entry = seq_entry?;
        let seq_path = seq_entry.path();
        if !seq_path.is_dir() {
            continue;
        }
        let seq_name = match seq_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if seq_name.starts_with('.') || seq_name.starts_with('$') || seq_name == SRC_DIR {
            continue;
        }

        for shot_entry in std::fs::read_dir(&seq_path)? {
            let shot_entry = shot_entry?;
            let shot_path = shot_entry.path();
            if !shot_path.is_dir() {
                continue;
            }
            let shot_name = match shot_path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if shot_name.starts_with('.') || shot_name.starts_with('$') || shot_name == SRC_DIR {
                continue;
            }

            let sel_path = shot_path.join(SEL_DIR);
            if !sel_path.is_dir() {
                continue;
            }

            // Found a SEL folder — copy its contents.
            for file_entry in std::fs::read_dir(&sel_path)? {
                let file_entry = file_entry?;
                let src_file = file_entry.path();
                if !src_file.is_file() {
                    continue;
                }
                let fname = match src_file.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if fname.ends_with(".thumb.png") {
                    continue;
                }
                if !is_media_ext(&src_file) && !fname.ends_with(".json") {
                    continue;
                }

                let dst_file = if preserve {
                    let d = dest.join(&seq_name).join(&shot_name).join(SEL_DIR);
                    ensure_dir(&d)?;
                    d.join(&fname)
                } else {
                    dest.join(format!("{seq_name}_{shot_name}_{fname}"))
                };

                std::fs::copy(&src_file, &dst_file)?;
                copied += 1;
            }
        }
    }

    Ok(copied)
}

#[tauri::command]
pub fn save_png_base64(path: String, data_base64: String) -> AppResult<()> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(&data_base64)
        .map_err(|e| AppError::Msg(format!("base64 decode: {e}")))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }
    std::fs::write(&p, &bytes)?;
    Ok(())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    // Open the containing folder. For regular drives this navigates to the
    // folder; for virtual/cloud filesystems (Google Drive, etc.) `/select`
    // is not supported by Explorer, but opening the folder itself works.
    let target = if p.is_dir() {
        p
    } else {
        p.parent().map(|d| d.to_path_buf()).unwrap_or(p)
    };
    let native = target.to_string_lossy().replace('/', "\\");
    std::process::Command::new("explorer")
        .arg(&native)
        .spawn()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}
