use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

fn map_is_empty<K, V>(m: &HashMap<K, V>) -> bool {
    m.is_empty()
}

// All types here must match src/lib/types.ts exactly.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInput {
    pub name: String,
    pub data_type: String,
    pub api_field: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOutput {
    pub name: String,
    pub data_type: String,
    pub api_field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefRoleSpec {
    pub role: String,
    pub api_field: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exclusive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub named: Option<bool>,
}

/// The model files on disk store parameters loosely — we pass them through as a
/// JSON Value so the UI can render them with minimal Rust-side ceremony.
pub type Parameter = Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelNode {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub kind: String, // "image" | "video"
    pub inputs: Vec<ModelInput>,
    pub outputs: Vec<ModelOutput>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ref_roles: Option<Vec<RefRoleSpec>>,
    pub parameters: Vec<Parameter>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub batch_field: Option<String>,
    /// "fal" | "replicate". Defaults to "fal" when omitted.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub family: String,
    pub category: String,
    pub node: ModelNode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TosConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ref_expiry_days: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorOverrides {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub border: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub accent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub window_bounds: WindowBounds,
    #[serde(default)]
    pub project_path: String,
    #[serde(default)]
    pub last_sequence: String,
    #[serde(default)]
    pub last_shot: String,
    #[serde(default)]
    pub last_model: String,
    #[serde(default)]
    pub ffmpeg_path: String,
    /// `None` until the user (or a save) pins a concrete value — needed so a
    /// fresh install can still defer to the shared config's own
    /// `max_concurrent_jobs`, the same way `filename_template` already does.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_concurrent_jobs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filename_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub colors: Option<ColorOverrides>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fal_lifecycle: Option<String>,
    /// Per-endpoint price texts fetched from fal's official pricing API (frontend-managed).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fal_prices: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fal_prices_fetched_at: Option<String>,
    /// Per-endpoint user-entered price overrides (any provider,
    /// frontend-managed) — takes priority over `fal_prices` when set. See
    /// `pricing::per_item_price`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub price_overrides: Option<HashMap<String, f64>>,
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    /// Version the user dismissed via the background auto-check's "Later" —
    /// suppresses re-prompting for that same version on the next launch.
    /// The manual "Check for updates" button in Settings ignores this.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_dismissed_update_version: Option<String>,
    /// BytePlus TOS object storage targeting fields. Was entirely absent from
    /// this struct until now, so the frontend's tos.* form silently never
    /// persisted — Tauri's IPC deserialize had nowhere to put it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tos: Option<TosConfig>,
    /// Path to a read-only shared YAML config an admin maintains on a network
    /// share (provider keys, Turso, ffmpeg path, etc). Never written by
    /// aiSLAP. See `commands::config::load_shared_config`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub shared_config_path: Option<String>,
}

fn default_auto_check_updates() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            window_bounds: WindowBounds {
                x: None,
                y: None,
                width: 1600,
                height: 1000,
            },
            project_path: String::new(),
            last_sequence: String::new(),
            last_shot: String::new(),
            last_model: String::new(),
            ffmpeg_path: String::new(),
            max_concurrent_jobs: None,
            filename_template: None,
            colors: None,
            fal_lifecycle: None,
            fal_prices: None,
            fal_prices_fetched_at: None,
            price_overrides: None,
            auto_check_updates: default_auto_check_updates(),
            last_dismissed_update_version: None,
            tos: None,
            shared_config_path: None,
        }
    }
}

/// A model/node lock-out list, admin-authored only — aiSLAP never writes
/// this back, so there is no Settings UI for it. Patterns are matched against
/// `"<provider>/<node.id>"` (e.g. `"fal/*"`, `"bytedance/topaz_upscale_video"`)
/// via `commands::models::model_visible`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelFilter {
    #[serde(default = "default_include_all")]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

fn default_include_all() -> Vec<String> {
    vec!["*".to_string()]
}

/// The read-only shared config file's shape — every field optional so a
/// partial file (just secrets, say) still parses. Secret/Turso keys are named
/// after their existing `.env` variable names so a studio's shared file can
/// reuse exactly what they'd otherwise put in a `.env`; everything else is a
/// new snake_case key mirroring the matching `Config` field.
///
/// aiSLAP only ever reads this file — see `commands::config::load_shared_config`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SharedConfig {
    #[serde(default)]
    pub fal_key: Option<String>,
    #[serde(default)]
    pub replicate_api_token: Option<String>,
    #[serde(default)]
    pub bytedance_api_key: Option<String>,
    #[serde(default)]
    pub bytedance_mediakit_api_key: Option<String>,
    #[serde(default)]
    pub beeble_api_key: Option<String>,
    #[serde(default)]
    pub tos_access_key_id: Option<String>,
    #[serde(default)]
    pub tos_secret_access_key: Option<String>,
    #[serde(default)]
    pub turso_database_url: Option<String>,
    #[serde(default)]
    pub turso_auth_token: Option<String>,

    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub max_concurrent_jobs: Option<u32>,
    #[serde(default)]
    pub filename_template: Option<String>,
    #[serde(default)]
    pub fal_lifecycle: Option<String>,
    #[serde(default)]
    pub tos_bucket: Option<String>,
    #[serde(default)]
    pub tos_region: Option<String>,
    #[serde(default)]
    pub tos_endpoint: Option<String>,
    #[serde(default)]
    pub tos_ref_expiry_days: Option<u32>,
    #[serde(default)]
    pub colors: Option<ColorOverrides>,

    #[serde(default)]
    pub models: Option<ModelFilter>,
}

// `app-state.json` has no struct here on purpose.
//
// It is the frontend's own session state — the open tabs, each with its project
// paths and its prompt chain — and per rule 3 in `docs/architecture.md` that
// knowledge lives in TypeScript. A typed mirror here was worse than none: serde
// dropped every field the struct hadn't been taught about, so `chainLinks` and
// `chainExpandedIdx` were silently discarded on every save and the chain never
// actually survived a restart. `app_state_load`/`app_state_save` pass the JSON
// straight through instead, the way `presets_load` already did.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEntry {
    pub timestamp: String,
    pub prompt: String,
    /// Each sub-prompt panel saved separately. Absent on legacy single-prompt entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSidecar {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt_history: Vec<PromptEntry>,
    /// Sum of costUsd across every image under this sequence's shots, from
    /// the most recent project_cost_scan run. None until a scan has run once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    /// Count of images that contributed to total_cost_usd (had a known price).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_image_count: Option<u32>,
    /// Count of images with no known price (unpriced/non-fal/time-billed),
    /// excluded from total_cost_usd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_image_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShotSidecar {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt_history: Vec<PromptEntry>,
    /// Single exclusive "clip media" pick — absolute path or None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_media_path: Option<String>,
    /// Single pinned storyboard frame for this shot — absolute path or None.
    /// Set via `shot_storyboard_image_set`, mirroring `clip_media_path` exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storyboard_image_path: Option<String>,
    /// Per-version pinned "select" picks. Key = version name (e.g., "v003"),
    /// value = filename within that version dir. When unset, the latest image is used.
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub version_selects: HashMap<String, String>,
    /// Per-version short free-text comments. Key = version name (e.g., "v003"),
    /// value = comment shown next to the version label. Folders are not renamed.
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub version_comments: HashMap<String, String>,
    /// Highest `<minor>` filename ordinal issued in each version folder. Key =
    /// version name (e.g. "v003").
    ///
    /// Monotonic on purpose: trashing a file does not free its number, so a
    /// name can never be reused within a column. A counter rather than a scan
    /// of existing filenames — the token can sit anywhere in a user-authored
    /// template, and the download path overwrites on collision, so a misparse
    /// would silently destroy a file.
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub minor_counters: HashMap<String, u32>,
    /// Sum of costUsd across every image in this shot's version folders, from
    /// the most recent project_cost_scan run. None until a scan has run once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_image_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_image_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    /// Absolute path to the source shot. None = blank/padding clip.
    #[serde(default)]
    pub shot_path: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub duration_sec: f64,
    #[serde(default)]
    pub media_path: Option<String>,
    /// Slip offset into the source media (seconds). 0 = play from the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_offset_sec: Option<f64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SequenceTimeline {
    #[serde(default)]
    pub total_duration_sec: f64,
    #[serde(default)]
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotLatestMedia {
    pub shot_path: String,
    pub media_path: Option<String>,
    pub is_video: bool,
    pub clip_media_path: Option<String>,
}

fn default_version_prefix() -> String {
    "gen".into()
}

/// One entry in a project's tag vocabulary. Images reference a tag by
/// `name` (the same string that lands in their sidecar's `tags` array), so
/// this record only carries what a name can't: how to draw it.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub name: String,
    /// CSS color, assigned round-robin from a palette on first use.
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSidecar {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created: String,
    /// Legacy starred-image set (forward-slash paths relative to project
    /// root). Superseded by per-image sidecar tags; kept only so
    /// `project_tags_migrate` can read it once and convert it to a tag.
    #[serde(default)]
    pub visible: Vec<String>,
    /// This project's tag vocabulary, in display order.
    #[serde(default)]
    pub tag_defs: Vec<TagDef>,
    /// Set once `project_tags_migrate` has converted `visible` + `SEL/`
    /// contents into tags, so the conversion never runs twice.
    #[serde(default)]
    pub tags_migrated: bool,
    /// Letter (+ `_`/`-`) prefix used when minting new version folders. The
    /// 3-digit suffix is appended at creation time. Defaults to "gen".
    #[serde(default = "default_version_prefix")]
    pub version_prefix: String,
    /// Stable UUID identifying this project across machines — the join key
    /// for a future central index/DB. Minted client-side (crypto.randomUUID)
    /// on first read via `project_id_get`; empty on projects not yet touched
    /// by that path.
    #[serde(default)]
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryImage {
    pub filename: String,
    pub path: String,
    pub metadata_path: String,
    pub is_video: bool,
    #[serde(default)]
    pub is_model_3d: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub thumb_path: Option<String>,
    /// Tag names on this image, resolved at scan time from the index (with a
    /// sidecar fallback for files the index hasn't seen yet).
    #[serde(default)]
    pub tags: Vec<String>,
    /// OS username that generated this image, resolved the same way as
    /// `tags`. Absent for SRC/ref images and anything predating the field.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub generated_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryColumn {
    pub id: String,
    pub version: String,
    pub is_src: bool,
    pub images: Vec<GalleryImage>,
    pub src_images: Vec<GalleryImage>,
    /// Absolute paths of the folders directly inside this column's directory,
    /// which the gallery renders as collapsible sections. Only reference
    /// columns get these — a version folder holds one batch of output and has
    /// no business growing a tree. Contents are *not* included: a section is
    /// scanned by `dir_children_scan` when it is opened, so a resources folder
    /// pointing at a texture library costs nothing until someone asks for it.
    #[serde(default)]
    pub subdirs: Vec<String>,
    /// Where a new reference dropped on this column is written, when that
    /// differs from `id`. Under PRISM a reference column's directory is a
    /// browsing root that other people also keep files in (`04_Resources`), so
    /// aiSLAP's own copies go into a `SRC` folder inside it rather than being
    /// scattered through it. `None` for version columns and for native
    /// projects, where the column directory already is `SRC`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dest_dir: Option<String>,
    /// Which reference root this column is, for the frontend paths that need
    /// to tell them apart. `None` for version columns and for `SEL`.
    ///
    /// This exists so those paths stop matching on the *label*: `version` is a
    /// display string that also keys persisted column widths and collapse
    /// state, and two drop handlers were comparing it to `"GLOBAL SRC"`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ref_scope: Option<RefScope>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model_name: Option<String>,
}

/// Which of the two reference roots a column shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefScope {
    Global,
    Shot,
}

/// One directory's worth of a reference column, fetched when a section opens.
///
/// The same shape a column carries, minus the column's identity — recursion is
/// the frontend rendering a section per `subdirs` entry, each of which fetches
/// its own children only when opened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChildren {
    pub images: Vec<GalleryImage>,
    pub subdirs: Vec<String>,
}
