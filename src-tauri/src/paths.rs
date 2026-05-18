use std::path::PathBuf;

use crate::error::{AppError, AppResult};

const APP_DIR_NAME: &str = "aiSLAP";

pub fn appdata_dir() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir available".into()))?;
    let dir = base.join(APP_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn config_path() -> AppResult<PathBuf> {
    Ok(appdata_dir()?.join("config.json"))
}

pub fn app_state_path() -> AppResult<PathBuf> {
    Ok(appdata_dir()?.join("app-state.json"))
}

pub fn env_path() -> AppResult<PathBuf> {
    Ok(appdata_dir()?.join(".env"))
}

pub fn presets_path() -> AppResult<PathBuf> {
    Ok(appdata_dir()?.join("presets.json"))
}

/// Locate `models/` — either sibling of the installed binary, or repo-root `models/`
/// while developing. We try a few candidates.
pub fn models_dir() -> AppResult<PathBuf> {
    // CWD first (dev mode, `pnpm tauri dev` runs from repo root).
    let cwd = std::env::current_dir()?;
    for candidate in [
        cwd.join("models"),
        cwd.join("..").join("models"),
        cwd.join("..").join("..").join("models"),
    ] {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    // Next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let next = dir.join("models");
            if next.is_dir() {
                return Ok(next);
            }
        }
    }
    Err(AppError::Msg(
        "models directory not found (looked in cwd/models, parent/models, exe/models)".into(),
    ))
}
