use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::fsutil::{project_root_for, rel_of};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::write_json_atomic;

/// Drop a deleted file (or everything under a deleted directory) from the
/// local asset index, so tag queries don't keep returning it. Best-effort and
/// silent outside a project — the index is rebuildable either way.
async fn purge_index(path: &Path, is_dir: bool) {
    let Ok(root) = project_root_for(path) else {
        return;
    };
    let Some(rel) = rel_of(path, &root) else {
        return;
    };
    if let Err(e) = crate::db::assets_purge(&root, &rel, is_dir).await {
        tracing::warn!("index purge failed for {rel}: {e}");
    }
}

#[tauri::command]
pub fn image_metadata_read(image_path: String) -> AppResult<Option<Value>> {
    let p = PathBuf::from(&image_path);
    let meta = metadata_path_for(&p)?;
    if !meta.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&meta)?;
    let value: Value = serde_json::from_str(&text)?;
    Ok(Some(value))
}

#[tauri::command]
pub fn image_metadata_write(image_path: String, metadata: Value) -> AppResult<()> {
    let p = PathBuf::from(&image_path);
    let meta = metadata_path_for(&p)?;
    write_json_atomic(&meta, &metadata)
}

#[tauri::command]
pub async fn image_delete(image_path: String) -> AppResult<()> {
    let p = PathBuf::from(&image_path);
    run_blocking(move || image_delete_impl(PathBuf::from(&image_path))).await?;
    purge_index(&p, false).await;
    Ok(())
}

fn image_delete_impl(p: PathBuf) -> AppResult<()> {
    // delete primary file, sidecar JSON, and any `.thumb.png` sibling.
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?
        .to_string();
    let dir = p
        .parent()
        .ok_or_else(|| AppError::Msg("no parent".into()))?;
    if p.exists() {
        std::fs::remove_file(&p)?;
    }
    let sidecar = dir.join(format!("{stem}.json"));
    if sidecar.exists() {
        if let Err(e) = std::fs::remove_file(&sidecar) {
            tracing::warn!("sidecar delete failed: {e}");
        }
    }
    let thumb = dir.join(format!("{stem}.thumb.png"));
    if thumb.exists() {
        if let Err(e) = std::fs::remove_file(&thumb) {
            tracing::warn!("thumb delete failed: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn column_delete(column_path: String) -> AppResult<()> {
    let p = PathBuf::from(&column_path);
    run_blocking({
        let p = p.clone();
        move || {
            if p.is_dir() {
                std::fs::remove_dir_all(&p)?;
            }
            Ok(())
        }
    })
    .await?;
    purge_index(&p, true).await;
    Ok(())
}

fn metadata_path_for(p: &PathBuf) -> AppResult<PathBuf> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?;
    let dir = p
        .parent()
        .ok_or_else(|| AppError::Msg("no parent".into()))?;
    Ok(dir.join(format!("{stem}.json")))
}
