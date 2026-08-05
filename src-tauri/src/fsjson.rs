//! Shared JSON file I/O: reads in two flavours (lenient and strict) and atomic
//! writes via a `.json.tmp` rename. Used by config, sidecars, and the
//! pending-submissions log.
//!
//! **Which read to use.** [`read_json_or_default`] is right when a default is a
//! genuinely sane answer and the caller only *reads* — a missing `config.json`
//! means "no config yet". It is wrong for read-modify-write, because the value
//! it invents gets written straight back over whatever was really on disk. Use
//! [`read_json_strict`] there.

use std::path::Path;

use crate::error::AppResult;

/// Missing or corrupt file → `T::default()`. Only safe for pure reads: see the
/// module docs.
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

/// Missing file → `Ok(None)`; unreadable or unparseable → `Err`.
///
/// This exists because read-modify-write on top of a lenient read is a
/// data-loss path, not merely a lenient one. `project.json` carries the
/// project id, title, creation date, the migration flag and the entire tag
/// vocabulary; if a partial write or an editor mangles it, defaulting on read
/// and saving on write replaces all of that with an empty document, and the
/// only trace is a `warn!` nobody sees. Failing loudly leaves the damaged file
/// on disk where it can still be recovered.
///
/// On a parse failure the original is first copied aside as
/// `<name>.corrupt-<timestamp>`, so the recovery does not depend on the user
/// noticing the error before something else rewrites the file.
pub(crate) fn read_json_strict<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> AppResult<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    match serde_json::from_str::<T>(&text) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
            let backup = path.with_extension(format!("corrupt-{stamp}"));
            match std::fs::copy(path, &backup) {
                Ok(_) => tracing::error!(
                    "corrupt JSON at {} — preserved a copy at {}",
                    path.display(),
                    backup.display()
                ),
                Err(copy_err) => tracing::error!(
                    "corrupt JSON at {} and the backup copy also failed: {copy_err}",
                    path.display()
                ),
            }
            Err(e.into())
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
