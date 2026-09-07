use std::path::{Path, PathBuf};

use crate::domain::Config;
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

/// The user's configured ffmpeg binary, or empty when they haven't set one.
/// See `resolve_ffmpeg` for what a caller actually does with this.
///
/// Lives here rather than in `fsutil` because it reads `config.json`, which is
/// this module's business. `tags.rs` and `image.rs` each carried a
/// byte-identical private copy.
pub(crate) fn configured_ffmpeg_path() -> String {
    read_json_or_default::<Config>(&paths::config_path().unwrap_or_default())
        .map(|c| c.ffmpeg_path)
        .unwrap_or_default()
}

/// Resolve a configured ffmpeg path down to a binary we can actually exec.
///
/// The stored string is normally an absolute path picked with the Settings
/// dialog's file browser, and that wins outright when it still points at a
/// real file — pinning a specific build (a custom codec set, say) has to keep
/// working regardless of what else is installed. Everything past that is
/// fallback, tried in order:
///
/// 1. The same path with the *other* platform's extension convention —
///    `ffmpeg.exe` with the suffix stripped, or a bare `ffmpeg` with `.exe`
///    appended on Windows. This is the literal bug that prompted this
///    function: a path containing `ffmpeg.exe` kept failing to resolve on
///    macOS, because nothing before this ever normalized the extension.
/// 2. The platform's own binary name (`ffmpeg` everywhere but Windows,
///    `ffmpeg.exe` there) on `PATH` — what an empty field's "(optional)"
///    label has always implied, but which nothing ever actually attempted.
/// 3. A short list of install locations a login shell's `PATH` would carry
///    but a GUI launch often doesn't — see `EXTRA_SEARCH_DIRS`.
///
/// `None` means genuinely not found anywhere reasonable; every caller already
/// knows how to degrade for that (skip a thumbnail, leave a probe empty,
/// surface an error naming the path that was tried).
pub(crate) fn resolve_ffmpeg(configured: &str) -> Option<PathBuf> {
    let path_dirs = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect::<Vec<_>>())
        .unwrap_or_default();
    resolve_ffmpeg_among(configured, &path_dirs, EXTRA_SEARCH_DIRS)
}

/// The searching half of `resolve_ffmpeg`, with its two directory lists taken
/// as parameters instead of read from the real environment — so a test can
/// hand it a temp directory instead of depending on whatever happens to be on
/// this machine's `PATH` (which, on a machine set up to develop this app, is
/// ffmpeg itself, making the "not found" cases otherwise untestable here).
fn resolve_ffmpeg_among(
    configured: &str,
    path_dirs: &[PathBuf],
    extra_dirs: &[&str],
) -> Option<PathBuf> {
    let exe = configured.trim();
    if !exe.is_empty() {
        let as_given = PathBuf::from(exe);
        if as_given.is_file() {
            return Some(as_given);
        }
        if let Some(alt) = swap_exe_suffix(exe) {
            let alt_path = PathBuf::from(alt);
            if alt_path.is_file() {
                return Some(alt_path);
            }
        }
    }

    let platform_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    find_in_dirs(platform_name, path_dirs.iter().map(PathBuf::as_path))
        .or_else(|| find_in_dirs(platform_name, extra_dirs.iter().map(Path::new)))
}

/// Directories a login shell's `PATH` would carry but a GUI-launched app's
/// often doesn't. macOS-only: Homebrew installs `ffmpeg` to
/// `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel), and
/// neither is on the environment Finder/Dock hand a launched `.app` — only a
/// shell profile adds them, and nothing here runs one. Windows persists PATH
/// in the registry, which an Explorer launch does inherit, and a Linux
/// desktop session's PATH already normally includes `/usr/bin`.
#[cfg(target_os = "macos")]
const EXTRA_SEARCH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
#[cfg(not(target_os = "macos"))]
const EXTRA_SEARCH_DIRS: &[&str] = &[];

/// The configured value with its extension convention flipped, so a path set
/// up on the other platform (or just typed by hand) still has one more thing
/// to try before falling back to a bare `PATH` search.
fn swap_exe_suffix(name: &str) -> Option<String> {
    if let Some(stripped) = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
    {
        Some(stripped.to_string())
    } else if cfg!(windows) {
        Some(format!("{name}.exe"))
    } else {
        None
    }
}

fn find_in_dirs<'a>(name: &str, dirs: impl Iterator<Item = &'a Path>) -> Option<PathBuf> {
    dirs.map(|dir| dir.join(name)).find(|p| p.is_file())
}

// ----- app-state.json -----

/// Passthrough, deliberately untyped — see the note where `AppState` used to
/// live in `domain.rs`. A missing file reads as `null`; the frontend already
/// treats any non-object as "no saved state".
#[tauri::command]
pub fn app_state_load() -> AppResult<serde_json::Value> {
    read_json_or_default(&paths::app_state_path()?)
}

#[tauri::command]
pub fn app_state_save(state: serde_json::Value) -> AppResult<()> {
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
            tracing::warn!(
                "corrupt presets JSON at {}: {e} — using default",
                path.display()
            );
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
        "tos_ak" => "TOS_ACCESS_KEY_ID".to_string(),
        "tos_sk" => "TOS_SECRET_ACCESS_KEY".to_string(),
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

#[cfg(test)]
mod resolve_ffmpeg_tests {
    use super::*;

    /// A throwaway directory holding one empty file per name given — enough
    /// to make `is_file()` say yes without needing a real ffmpeg binary.
    struct FakeBins {
        dir: PathBuf,
    }
    impl FakeBins {
        fn new(tag: &str, names: &[&str]) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("aislap-ffmpeg-test-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            for name in names {
                std::fs::write(dir.join(name), b"").unwrap();
            }
            Self { dir }
        }
        fn path(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }
    }
    impl Drop for FakeBins {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn platform_name() -> &'static str {
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }
    }

    #[test]
    fn an_existing_configured_path_wins_outright() {
        let bins = FakeBins::new("explicit", &[platform_name()]);
        let configured = bins.path(platform_name());
        let found = resolve_ffmpeg_among(configured.to_str().unwrap(), &[], &[]);
        assert_eq!(found, Some(configured));
    }

    /// The bug this function exists to fix: a configured path naming the
    /// *other* platform's binary resolves to the sibling that actually exists,
    /// rather than failing outright.
    #[test]
    fn a_configured_path_with_the_wrong_platform_extension_falls_back_to_its_sibling() {
        let other = if cfg!(windows) {
            "ffmpeg"
        } else {
            "ffmpeg.exe"
        };
        let bins = FakeBins::new("wrong-ext", &[platform_name()]);
        // Ask for the *other* platform's name — it doesn't exist, but its
        // sibling (this platform's real name) does.
        let configured = bins.path(other);
        let found = resolve_ffmpeg_among(configured.to_str().unwrap(), &[], &[]);
        assert_eq!(found, Some(bins.path(platform_name())));
    }

    #[test]
    fn an_empty_configured_value_goes_straight_to_search() {
        let bins = FakeBins::new("empty-cfg", &[platform_name()]);
        let path_dirs = [bins.dir.clone()];
        let found = resolve_ffmpeg_among("", &path_dirs, &[]);
        assert_eq!(found, Some(bins.path(platform_name())));
    }

    #[test]
    fn a_configured_value_that_resolves_nowhere_still_falls_through_to_path() {
        let bins = FakeBins::new("fallthrough", &[platform_name()]);
        let path_dirs = [bins.dir.clone()];
        let found = resolve_ffmpeg_among("/nonexistent/not-ffmpeg", &path_dirs, &[]);
        assert_eq!(found, Some(bins.path(platform_name())));
    }

    #[test]
    fn extra_dirs_are_only_consulted_after_path_comes_up_empty() {
        let path_bins = FakeBins::new("path-empty", &[]);
        let extra_bins = FakeBins::new("extra", &[platform_name()]);
        let extra_dir_str = extra_bins.dir.to_str().unwrap();
        let found =
            resolve_ffmpeg_among("", std::slice::from_ref(&path_bins.dir), &[extra_dir_str]);
        assert_eq!(found, Some(extra_bins.path(platform_name())));
    }

    #[test]
    fn nothing_found_anywhere_is_none() {
        let bins = FakeBins::new("nothing", &[]);
        let found = resolve_ffmpeg_among("", std::slice::from_ref(&bins.dir), &[]);
        assert_eq!(found, None);
    }

    #[test]
    fn swap_exe_suffix_strips_or_appends_depending_on_platform() {
        assert_eq!(swap_exe_suffix("ffmpeg.exe").as_deref(), Some("ffmpeg"));
        assert_eq!(swap_exe_suffix("ffmpeg.EXE").as_deref(), Some("ffmpeg"));
        if cfg!(windows) {
            assert_eq!(swap_exe_suffix("ffmpeg").as_deref(), Some("ffmpeg.exe"));
        } else {
            assert_eq!(swap_exe_suffix("ffmpeg"), None);
        }
    }
}
