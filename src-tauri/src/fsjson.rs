//! Shared JSON file I/O: lenient reads (missing/corrupt file → default) and
//! atomic writes via a `.json.tmp` rename. Used by config, sidecars, and the
//! pending-submissions log.

use std::path::Path;

use crate::error::AppResult;

pub(crate) fn read_json_or_default<T: Default + serde::de::DeserializeOwned>(
    path: &Path,
) -> AppResult<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let text = std::fs::read_to_string(path)?;
    match serde_json::from_str::<T>(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            tracing::warn!("corrupt JSON at {}: {e} — using default", path.display());
            Ok(T::default())
        }
    }
}

pub(crate) fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub(crate) fn ensure_dir(path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}
