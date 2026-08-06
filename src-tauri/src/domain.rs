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
    #[serde(default = "default_max_concurrent_jobs")]
    pub max_concurrent_jobs: u32,
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
}

fn default_max_concurrent_jobs() -> u32 {
    3
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
            max_concurrent_jobs: default_max_concurrent_jobs(),
            filename_template: None,
            colors: None,
            fal_lifecycle: None,
            fal_prices: None,
            fal_prices_fetched_at: None,
            price_overrides: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RoleAssignment {
    Source,
    Start,
    End,
    #[serde(rename_all = "camelCase")]
    Element {
        group_name: String,
        frontal: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefImage {
    pub path: String,
    pub role_assignment: Option<RoleAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    #[serde(default)]
    pub project_path: String,
    /// Sequence/shot paths relative to their parent — the folder name in a
    /// native project, but carrying the entity-root and `Renders/AI` segments
    /// in a PRISM one.
    #[serde(default)]
    pub last_sequence: String,
    #[serde(default)]
    pub last_shot: String,
    /// PRISM entity tree the session was last in ("shot" | "asset"). Absent for
    /// plain aiSLAP projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prism_entity_type: Option<String>,
    #[serde(default)]
    pub last_model: String,
    #[serde(default)]
    pub sequence_prompt: String,
    /// Legacy single-string shot prompt. Read for back-compat; new code writes
    /// `shot_prompts` instead. Kept here so older saved AppState still loads.
    #[serde(default)]
    pub shot_prompt: String,
    #[serde(default)]
    pub shot_prompts: Vec<String>,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub ref_images: Vec<RefImage>,
    #[serde(default = "one")]
    pub iterations: u32,
    #[serde(default = "default_gallery_height")]
    pub gallery_height: u32,
    #[serde(default = "default_thumb_col_width")]
    pub thumb_col_width: u32,
    #[serde(default = "default_log_height")]
    pub log_height: u32,
}

fn one() -> u32 {
    1
}
fn default_gallery_height() -> u32 {
    400
}
fn default_thumb_col_width() -> u32 {
    120
}
fn default_log_height() -> u32 {
    78
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            project_path: String::new(),
            last_sequence: String::new(),
            last_shot: String::new(),
            prism_entity_type: None,
            last_model: String::new(),
            sequence_prompt: String::new(),
            shot_prompt: String::new(),
            shot_prompts: vec![],
            settings: Value::Object(Default::default()),
            ref_images: vec![],
            iterations: 1,
            gallery_height: 400,
            thumb_col_width: 120,
            log_height: 78,
        }
    }
}

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
    /// Per-version pinned "select" picks. Key = version name (e.g., "v003"),
    /// value = filename within that version dir. When unset, the latest image is used.
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub version_selects: HashMap<String, String>,
    /// Per-version short free-text comments. Key = version name (e.g., "v003"),
    /// value = comment shown next to the version label. Folders are not renamed.
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub version_comments: HashMap<String, String>,
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model_name: Option<String>,
}
