use std::path::PathBuf;

use serde_json::Value;

use crate::commands::visible::visible_set_remove_path_or_prefix;
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::write_json_atomic;

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
pub fn image_delete(image_path: String) -> AppResult<()> {
    let p = PathBuf::from(&image_path);
    // delete primary file, sidecar JSON, and any `.thumb.png` sibling.
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?
        .to_string();
    let dir = p.parent().ok_or_else(|| AppError::Msg("no parent".into()))?;
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
    visible_set_remove_path_or_prefix(&p, false)?;
    Ok(())
}

#[tauri::command]
pub async fn column_delete(column_path: String) -> AppResult<()> {
    run_blocking(move || {
        let p = PathBuf::from(&column_path);
        if p.is_dir() {
            std::fs::remove_dir_all(&p)?;
        }
        visible_set_remove_path_or_prefix(&p, true)?;
        Ok(())
    })
    .await
}

fn metadata_path_for(p: &PathBuf) -> AppResult<PathBuf> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?;
    let dir = p.parent().ok_or_else(|| AppError::Msg("no parent".into()))?;
    Ok(dir.join(format!("{stem}.json")))
}
