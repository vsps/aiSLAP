use std::path::PathBuf;

use serde_json::Value;

use crate::commands::visible::visible_set_remove_path_or_prefix;
use crate::error::{AppError, AppResult};

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
    let tmp = meta.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&metadata)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &meta)?;
    Ok(())
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
        let _ = std::fs::remove_file(&sidecar);
    }
    let thumb = dir.join(format!("{stem}.thumb.png"));
    if thumb.exists() {
        let _ = std::fs::remove_file(&thumb);
    }
    visible_set_remove_path_or_prefix(&p, false)?;
    Ok(())
}

#[tauri::command]
pub fn column_delete(column_path: String) -> AppResult<()> {
    let p = PathBuf::from(&column_path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p)?;
    }
    visible_set_remove_path_or_prefix(&p, true)?;
    Ok(())
}

fn metadata_path_for(p: &PathBuf) -> AppResult<PathBuf> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?;
    let dir = p.parent().ok_or_else(|| AppError::Msg("no parent".into()))?;
    Ok(dir.join(format!("{stem}.json")))
}
