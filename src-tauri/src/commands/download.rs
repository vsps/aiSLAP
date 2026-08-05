use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn download_to_path(url: String, target: String) -> AppResult<()> {
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::Msg(format!("fetch: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!(
            "HTTP {} downloading {url}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Msg(format!("read body: {e}")))?;
    let target = PathBuf::from(&target);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("part");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

/// Write a UTF-8 string verbatim to `target`, creating parent dirs. Used for
/// non-media outputs (e.g. SAM3 image embeddings) that have no URL to fetch.
#[tauri::command]
pub fn write_text_file(target: String, contents: String) -> AppResult<()> {
    let target = PathBuf::from(&target);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, contents.as_bytes())?;
    Ok(())
}
