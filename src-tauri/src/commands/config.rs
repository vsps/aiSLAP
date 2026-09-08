use std::path::{Path, PathBuf};

use crate::domain::{Config, SharedConfig};
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

/// The user's configured ffmpeg binary, or empty when they haven't set one
/// locally *or* via the shared config. See `resolve_ffmpeg` for what a caller
/// actually does with this.
///
/// Lives here rather than in `fsutil` because it reads `config.json`, which is
/// this module's business. `tags.rs` and `image.rs` each carried a
/// byte-identical private copy.
pub(crate) fn configured_ffmpeg_path() -> String {
    let local = read_json_or_default::<Config>(&paths::config_path().unwrap_or_default())
        .map(|c| c.ffmpeg_path)
        .unwrap_or_default();
    if !local.is_empty() {
        return local;
    }
    load_shared_config()
        .and_then(|s| s.ffmpeg_path)
        .unwrap_or_default()
}

/// The read-only shared YAML config an admin points every machine at
/// (`Config.shared_config_path`), or `None` when unset, missing, or
/// unparseable — a bad or absent shared file never blocks the app, it just
/// means nothing defers to it. Read fresh every call: nothing here is
/// hot-path enough yet to justify a cache invalidation story.
pub(crate) fn load_shared_config() -> Option<SharedConfig> {
    let local = read_json_or_default::<Config>(&paths::config_path().ok()?).ok()?;
    let shared_path = local.shared_config_path?;
    if shared_path.trim().is_empty() {
        return None;
    }
    let text = std::fs::read_to_string(&shared_path)
        .inspect_err(|e| tracing::warn!("shared config at {shared_path} unreadable: {e}"))
        .ok()?;
    serde_yaml_ng::from_str(&text)
        .inspect_err(|e| tracing::warn!("shared config at {shared_path} did not parse: {e}"))
        .ok()
}

/// The Settings dialog's read of the shared file — used only for the
/// inherited-value highlight/tooltip. Every other consumer resolves its own
/// field through the plain accessors above (`configured_ffmpeg_path`,
/// `provider_key_get`, `turso_config`), so this command never feeds back into
/// `config_save`.
#[tauri::command]
pub fn shared_config_load() -> Option<SharedConfig> {
    load_shared_config()
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

/// Maps an env-var name (as passed to `read_env_var`/`write_env_var`) to the
/// matching field on the shared config — the two use identical key names by
/// design, so a studio's shared file can reuse exactly what they'd otherwise
/// put in a `.env`. Providers added later via `env_var_for`'s catch-all fall
/// through to `None` here until this gains a matching `SharedConfig` field.
fn shared_secret(name: &str, shared: &SharedConfig) -> Option<String> {
    match name {
        "FAL_KEY" => shared.fal_key.clone(),
        "REPLICATE_API_TOKEN" => shared.replicate_api_token.clone(),
        "BYTEDANCE_API_KEY" => shared.bytedance_api_key.clone(),
        "BYTEDANCE_MEDIAKIT_API_KEY" => shared.bytedance_mediakit_api_key.clone(),
        "BEEBLE_API_KEY" => shared.beeble_api_key.clone(),
        "TOS_ACCESS_KEY_ID" => shared.tos_access_key_id.clone(),
        "TOS_SECRET_ACCESS_KEY" => shared.tos_secret_access_key.clone(),
        "TURSO_DATABASE_URL" => shared.turso_database_url.clone(),
        "TURSO_AUTH_TOKEN" => shared.turso_auth_token.clone(),
        _ => None,
    }
}

/// The literal `.env` line, ignoring the shared config entirely — empty when
/// there's no local line at all. Split out from `read_env_var` so Settings can
/// tell "shown because it's the local override" from "shown because it's
/// inherited from the shared file" (`provider_key_get` collapses that
/// distinction on purpose, since every other caller just wants the effective
/// value).
fn read_local_env_var(name: &str) -> AppResult<String> {
    let path = paths::env_path()?;
    if path.exists() {
        let text = std::fs::read_to_string(&path)?;
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
    }
    Ok(String::new())
}

/// Local `.env` wins outright; an unset/absent key falls back to the shared
/// config. Both `provider_key_get` and `turso_config` go through this, so
/// both get the fallback for free.
fn read_env_var(name: &str) -> AppResult<String> {
    let local = read_local_env_var(name)?;
    if !local.is_empty() {
        return Ok(local);
    }
    Ok(load_shared_config()
        .and_then(|s| shared_secret(name, &s))
        .unwrap_or_default())
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

/// Settings-only: the local `.env` value alone, empty when unset there even
/// if the shared config supplies one. Lets the dialog tell "typed locally"
/// from "inherited" for the highlight — every other caller wants
/// `provider_key_get`'s merged value instead.
#[tauri::command]
pub fn provider_key_get_local(provider: String) -> AppResult<String> {
    let name = env_var_for(&provider);
    read_local_env_var(&name)
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

#[cfg(test)]
mod shared_config_tests {
    use super::*;

    #[test]
    fn shared_secret_maps_every_env_var_name_to_its_field() {
        let shared = SharedConfig {
            fal_key: Some("fal-1".into()),
            replicate_api_token: Some("r8-1".into()),
            bytedance_api_key: Some("bd-1".into()),
            bytedance_mediakit_api_key: Some("mk-1".into()),
            beeble_api_key: Some("bb-1".into()),
            tos_access_key_id: Some("ak-1".into()),
            tos_secret_access_key: Some("sk-1".into()),
            turso_database_url: Some("libsql://x".into()),
            turso_auth_token: Some("tok-1".into()),
            ..Default::default()
        };
        assert_eq!(shared_secret("FAL_KEY", &shared).as_deref(), Some("fal-1"));
        assert_eq!(
            shared_secret("REPLICATE_API_TOKEN", &shared).as_deref(),
            Some("r8-1")
        );
        assert_eq!(
            shared_secret("BYTEDANCE_API_KEY", &shared).as_deref(),
            Some("bd-1")
        );
        assert_eq!(
            shared_secret("BYTEDANCE_MEDIAKIT_API_KEY", &shared).as_deref(),
            Some("mk-1")
        );
        assert_eq!(
            shared_secret("BEEBLE_API_KEY", &shared).as_deref(),
            Some("bb-1")
        );
        assert_eq!(
            shared_secret("TOS_ACCESS_KEY_ID", &shared).as_deref(),
            Some("ak-1")
        );
        assert_eq!(
            shared_secret("TOS_SECRET_ACCESS_KEY", &shared).as_deref(),
            Some("sk-1")
        );
        assert_eq!(
            shared_secret("TURSO_DATABASE_URL", &shared).as_deref(),
            Some("libsql://x")
        );
        assert_eq!(
            shared_secret("TURSO_AUTH_TOKEN", &shared).as_deref(),
            Some("tok-1")
        );
        assert_eq!(shared_secret("SOME_OTHER_KEY", &shared), None);
    }

    /// The actual studio-facing contract: these exact key names in a YAML
    /// file must parse into the fields callers rely on. A field rename here
    /// would compile fine and break every deployed shared file silently.
    #[test]
    fn shared_config_parses_every_documented_yaml_key() {
        let yaml = r#"
fal_key: fal-secret
replicate_api_token: r8-secret
bytedance_api_key: bd-secret
bytedance_mediakit_api_key: mk-secret
beeble_api_key: bb-secret
tos_access_key_id: ak-secret
tos_secret_access_key: sk-secret
turso_database_url: "libsql://team.turso.io"
turso_auth_token: turso-secret

ffmpeg_path: /opt/homebrew/bin/ffmpeg
max_concurrent_jobs: 6
filename_template: "<date>_<shot>_<model>"
fal_lifecycle: 7d
tos_bucket: team-bucket
tos_region: ap-southeast-1
tos_endpoint: tos-ap-southeast-1.bytepluses.com
tos_ref_expiry_days: 14

models:
  include: ["fal/*", "bytedance/*"]
  exclude: ["bytedance/experimental-*"]
"#;
        let parsed: SharedConfig = serde_yaml_ng::from_str(yaml).expect("valid shared config");
        assert_eq!(parsed.fal_key.as_deref(), Some("fal-secret"));
        assert_eq!(
            parsed.turso_database_url.as_deref(),
            Some("libsql://team.turso.io")
        );
        assert_eq!(
            parsed.ffmpeg_path.as_deref(),
            Some("/opt/homebrew/bin/ffmpeg")
        );
        assert_eq!(parsed.max_concurrent_jobs, Some(6));
        assert_eq!(parsed.fal_lifecycle.as_deref(), Some("7d"));
        assert_eq!(parsed.tos_ref_expiry_days, Some(14));
        let models = parsed.models.expect("models section");
        assert_eq!(models.include, vec!["fal/*", "bytedance/*"]);
        assert_eq!(models.exclude, vec!["bytedance/experimental-*"]);
    }

    /// An empty/partial file (just a couple of keys) must still parse —
    /// nobody wants every field mandatory in a hand-authored YAML.
    #[test]
    fn shared_config_tolerates_a_partial_file() {
        let parsed: SharedConfig = serde_yaml_ng::from_str("fal_key: only-this\n").unwrap();
        assert_eq!(parsed.fal_key.as_deref(), Some("only-this"));
        assert_eq!(parsed.turso_database_url, None);
        assert!(parsed.models.is_none());
    }

    /// `include` defaults to `["*"]` when a `models:` section is present but
    /// doesn't mention `include` — "lock out by exclude only" shouldn't
    /// require restating the wildcard.
    #[test]
    fn model_filter_include_defaults_to_wildcard() {
        let parsed: SharedConfig =
            serde_yaml_ng::from_str("models:\n  exclude: [\"fal/topaz*\"]\n").unwrap();
        let models = parsed.models.expect("models section");
        assert_eq!(models.include, vec!["*"]);
        assert_eq!(models.exclude, vec!["fal/topaz*"]);
    }
}
