use crate::domain::{AppState, Config};
use crate::error::AppResult;
use crate::fsjson::{read_json_or_default, write_json_atomic};
use crate::paths;

// ----- config.json -----

#[tauri::command]
pub fn config_load() -> AppResult<Config> {
    read_json_or_default(&paths::config_path()?)
}

#[tauri::command]
pub fn config_save(config: Config) -> AppResult<()> {
    write_json_atomic(&paths::config_path()?, &config)
}

// ----- app-state.json -----

#[tauri::command]
pub fn app_state_load() -> AppResult<AppState> {
    read_json_or_default(&paths::app_state_path()?)
}

#[tauri::command]
pub fn app_state_save(state: AppState) -> AppResult<()> {
    write_json_atomic(&paths::app_state_path()?, &state)
}

// ----- presets.json -----

#[tauri::command]
pub fn presets_load() -> AppResult<serde_json::Value> {
    let path = paths::presets_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({ "presets": [] }));
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            tracing::warn!("corrupt presets JSON at {}: {e} — using default", path.display());
            Ok(serde_json::json!({ "presets": [] }))
        }
    }
}

#[tauri::command]
pub fn presets_save(data: serde_json::Value) -> AppResult<()> {
    write_json_atomic(&paths::presets_path()?, &data)
}

// ----- .env (provider keys) -----

/// Map a provider name to its env-var key. Unknown providers fall back to
/// `<UPPER>_API_KEY` so callers don't have to teach this file every provider.
fn env_var_for(provider: &str) -> String {
    match provider {
        "fal" => "FAL_KEY".to_string(),
        "replicate" => "REPLICATE_API_TOKEN".to_string(),
        "turso_url" => "TURSO_DATABASE_URL".to_string(),
        "turso_token" => "TURSO_AUTH_TOKEN".to_string(),
        other => format!("{}_API_KEY", other.to_uppercase()),
    }
}

/// Turso credentials for the sync layer (`db/mod.rs`), stored via the same
/// `provider_key_get/set("turso_url"|"turso_token", ...)` calls SettingsDialog
/// uses for every other provider key. `None` when either half is unset —
/// the DB layer treats that as "not configured" and stays local-only.
pub(crate) fn turso_config() -> AppResult<Option<(String, String)>> {
    let url = read_env_var(&env_var_for("turso_url"))?;
    let token = read_env_var(&env_var_for("turso_token"))?;
    if url.is_empty() || token.is_empty() {
        return Ok(None);
    }
    Ok(Some((url, token)))
}

fn read_env_var(name: &str) -> AppResult<String> {
    let path = paths::env_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    let text = std::fs::read_to_string(path)?;
    let prefix = format!("{name}=");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix(&prefix) {
            return Ok(rest.trim_matches('"').to_string());
        }
    }
    Ok(String::new())
}

fn write_env_var(name: &str, value: &str) -> AppResult<()> {
    let path = paths::env_path()?;
    let prefix = format!("{name}=");
    let mut lines: Vec<String> = if path.exists() {
        std::fs::read_to_string(&path)?
            .lines()
            .filter(|l| !l.trim_start().starts_with(&prefix))
            .map(String::from)
            .collect()
    } else {
        Vec::new()
    };
    if !value.is_empty() {
        lines.push(format!("{name}={value}"));
    }
    let mut content = lines.join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
pub fn provider_key_get(provider: String) -> AppResult<String> {
    let name = env_var_for(&provider);
    read_env_var(&name)
}

#[tauri::command]
pub fn provider_key_set(provider: String, key: String) -> AppResult<()> {
    let name = env_var_for(&provider);
    write_env_var(&name, &key)
}

// Legacy wrappers — kept so existing TS callers don't churn.
#[tauri::command]
pub fn fal_key_get() -> AppResult<String> {
    read_env_var("FAL_KEY")
}

#[tauri::command]
pub fn fal_key_set(key: String) -> AppResult<()> {
    write_env_var("FAL_KEY", &key)
}
