use std::path::PathBuf;

use tauri::Manager;

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

pub fn pending_path() -> AppResult<PathBuf> {
    Ok(appdata_dir()?.join("pending.json"))
}

/// Locate `models/`: the repo copy while developing, otherwise the one bundled
/// as a Tauri resource.
///
/// Where a bundled resource lands is platform-specific, which is why the
/// resolver has to be asked rather than guessed: next to the binary on Windows,
/// but `<app>.app/Contents/Resources/` on macOS (the binary lives in
/// `Contents/MacOS/`) and `/usr/lib/<app>/` for a Linux deb. A Finder-launched
/// .app also gets `/` as its working directory, so the dev candidates below
/// can't stand in for it.
pub fn models_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let mut tried: Vec<PathBuf> = Vec::new();

    // CWD first (dev mode, `npm run tauri dev` runs from the repo root) so
    // edits to models/*.json are picked up without a rebuild.
    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [
            cwd.join("models"),
            cwd.join("..").join("models"),
            cwd.join("..").join("..").join("models"),
        ] {
            if candidate.is_dir() {
                return Ok(candidate);
            }
            tried.push(candidate);
        }
    }

    // Bundled resource dir — the packaged-app answer on every platform.
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("models");
        if candidate.is_dir() {
            return Ok(candidate);
        }
        tried.push(candidate);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Next to the binary (Windows installs).
            let next = dir.join("models");
            if next.is_dir() {
                return Ok(next);
            }
            tried.push(next);
            // Belt and braces for a macOS bundle whose resource dir didn't
            // resolve: Contents/MacOS/../Resources/models.
            if let Some(contents) = dir.parent() {
                let mac = contents.join("Resources").join("models");
                if mac.is_dir() {
                    return Ok(mac);
                }
                tried.push(mac);
            }
        }
    }

    Err(AppError::Msg(format!(
        "models directory not found — looked in: {}",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}
