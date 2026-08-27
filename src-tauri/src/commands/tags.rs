//! User-defined image tags.
//!
//! Three layers, in order of authority:
//!   1. the per-image sidecar's `tags` array — the source of truth, and the
//!      reason tags survive a copy/move/rename with no path bookkeeping at
//!      all (the sidecar travels with the media triple);
//!   2. `db::asset_tags` — a rebuildable index so a gallery scan is one
//!      query instead of one sidecar read per file;
//!   3. `project.json`'s `tagDefs` — the project's vocabulary, holding the
//!      one thing a tag name can't carry: its color.
//!
//! Anything that writes a tag writes the sidecar first and the index second,
//! same contract as the rest of the DB layer.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::fsutil::{
    as_str, existing_thumb_path, is_media_ext, is_thumb, project_root_for, relativize, require_dir,
    sidecar_path, thumb_path, thumb_path_like, ProjectRoot, PROJECT_SIDECAR, SEL_DIR,
};
use crate::commands::gallery::try_make_gallery_image;
use crate::commands::media_id::{file_hash_impl, media_id_embed_impl};
use crate::commands::prism;
use crate::db::{self, AssetRecord, TagUpdate};
use crate::domain::{GalleryImage, ProjectSidecar, TagDef};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{ensure_dir, read_json_or_default, read_json_strict, write_json_atomic};

/// Tags carried over from the systems this replaced: the star became `fav`,
/// the SEL folder became `select`.
pub(crate) const TAG_FAV: &str = "fav";
pub(crate) const TAG_SELECT: &str = "select";

/// Colors handed out round-robin as new tags appear. Deliberately literal
/// hex rather than theme tokens — a tag color is user data that ends up in
/// project.json, not part of the app's palette.
const PALETTE: &[&str] = &[
    "#9b31f2", "#4ade80", "#fbbf24", "#f87171", "#38bdf8", "#f472b6", "#a3e635", "#fb923c",
];

const MAX_TAG_LEN: usize = 40;

// ---------- normalization ----------

/// Canonical form of a user-typed tag: trimmed, inner whitespace collapsed,
/// length-capped. `None` for anything that normalizes to nothing.
pub(crate) fn normalize_tag(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TAG_LEN).collect())
}

/// Normalize a whole list, dropping empties and case-insensitive duplicates
/// while keeping the caller's order (which is the order they'll be drawn in).
pub(crate) fn normalize_tags<I, S>(raw: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for item in raw {
        let Some(tag) = normalize_tag(item.as_ref()) else {
            continue;
        };
        if seen.insert(tag.to_lowercase()) {
            out.push(tag);
        }
    }
    out
}

/// Pull the `tags` array out of a parsed sidecar object.
pub(crate) fn tags_from_sidecar(obj: &Map<String, Value>) -> Vec<String> {
    let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    normalize_tags(arr.iter().filter_map(|v| v.as_str()))
}

/// Mirrors `tags_from_sidecar` for the `generatedBy` field — the sidecar
/// fallback path for files the tag/generated-by index hasn't indexed yet.
pub(crate) fn generated_by_from_sidecar(obj: &Map<String, Value>) -> Option<String> {
    obj.get("generatedBy")
        .and_then(|v| v.as_str())
        .map(String::from)
}

fn eq_tag(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

// ---------- sidecar reading/writing ----------

fn read_sidecar_value(media: &Path) -> Value {
    let path = sidecar_path(media);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Map::new())),
        Err(_) => Value::Object(Map::new()),
    }
}

/// Give a media file an identity if it doesn't have one, mutating `obj` in
/// place. Same mint-embed-hash sequence as `reidentify_copy` and reconcile's
/// legacy backfill — a tag is the first durable thing many SRC/legacy files
/// ever get, so tagging is a reasonable moment to index them. Returns true
/// when `obj` changed.
fn ensure_identity(media: &Path, project_id: &str, obj: &mut Map<String, Value>) -> bool {
    if obj.get("assetId").and_then(|v| v.as_str()).is_some() {
        return false;
    }
    let id = uuid::Uuid::new_v4().to_string();
    // Best-effort, exactly as elsewhere: a format we can't embed into still
    // gets an id, just not a recoverable in-file tag.
    let _ = media_id_embed_impl(
        media,
        &id,
        project_id,
        &crate::commands::config::configured_ffmpeg_path(),
    );
    obj.insert("assetId".into(), Value::String(id));
    if let Ok(hash) = file_hash_impl(media) {
        obj.insert("contentHash".into(), Value::String(hash));
    }
    true
}

/// Map a sidecar object onto the index record used to ingest a file the
/// index hasn't seen. Mirrors `reidentify_copy`'s mapping; only ever used as
/// an insert-if-absent fallback, never to overwrite a live row.
fn record_from_sidecar(
    media: &Path,
    project_root: &Path,
    project_id: &str,
    asset_id: &str,
    obj: &Map<String, Value>,
) -> Option<AssetRecord> {
    let rel_path = relativize(media, project_root)?;
    let now = chrono::Utc::now().to_rfc3339();
    Some(AssetRecord {
        id: asset_id.to_string(),
        project_id: Some(project_id.to_string()),
        rel_path,
        content_hash: obj
            .get("contentHash")
            .and_then(|v| v.as_str())
            .map(String::from),
        kind: db::media_kind(media).to_string(),
        provider: obj
            .get("provider")
            .and_then(|v| v.as_str())
            .map(String::from),
        model_id: obj
            .get("modelId")
            .and_then(|v| v.as_str())
            .map(String::from),
        endpoint: obj
            .get("endpoint")
            .and_then(|v| v.as_str())
            .map(String::from),
        combined_prompt: obj
            .get("combinedPrompt")
            .and_then(|v| v.as_str())
            .map(String::from),
        settings_json: obj.get("settings").map(|v| v.to_string()),
        cost_usd: obj.get("costUsd").and_then(|v| v.as_f64()),
        created_at: obj
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| now.clone()),
        updated_at: Some(now),
        deleted_at: None,
        generated_by: obj
            .get("generatedBy")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

/// Write `tags` onto one media file: sidecar first (creating one for files
/// that never had it — an OS-dragged reference image, say), then hand back
/// the index work for the async caller to apply.
fn write_tags(
    media: &Path,
    project_root: &Path,
    project_id: &str,
    tags: Vec<String>,
) -> AppResult<Option<TagUpdate>> {
    let mut value = read_sidecar_value(media);
    if !value.is_object() {
        value = Value::Object(Map::new());
    }
    let obj = value.as_object_mut().expect("object above");

    ensure_identity(media, project_id, obj);
    if tags.is_empty() {
        obj.remove("tags");
    } else {
        obj.insert("tags".into(), serde_json::json!(tags));
    }
    write_json_atomic(&sidecar_path(media), &value)?;

    let obj = value.as_object().expect("object above");
    let Some(asset_id) = obj.get("assetId").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    Ok(Some(TagUpdate {
        asset_id: asset_id.to_string(),
        record: record_from_sidecar(media, project_root, project_id, asset_id, obj),
        tags,
    }))
}

// ---------- vocabulary (project.json) ----------

/// Lenient read, for callers that only *report* the vocabulary. A missing or
/// damaged `project.json` reads as "no tags defined", which is a survivable
/// answer when nothing is written back.
fn load_sidecar(project_root: &Path) -> AppResult<ProjectSidecar> {
    read_json_or_default(&project_root.join(PROJECT_SIDECAR))
}

/// Strict read, for every read-modify-write of `project.json`.
///
/// The lenient read is actively dangerous here: it turns a damaged file into an
/// empty `ProjectSidecar`, and the save that follows then commits that empty
/// document — discarding the project id, title, creation date, the
/// `tagsMigrated` flag and the whole tag vocabulary, with nothing but a `warn!`
/// to show for it. Missing is still fine (a project that has never had tags),
/// so only a genuine parse failure is an error.
fn load_sidecar_for_update(project_root: &Path) -> AppResult<ProjectSidecar> {
    Ok(read_json_strict(&project_root.join(PROJECT_SIDECAR))?.unwrap_or_default())
}

fn save_sidecar(project_root: &Path, sidecar: &ProjectSidecar) -> AppResult<()> {
    write_json_atomic(&project_root.join(PROJECT_SIDECAR), sidecar)
}

/// Append a definition for every name that doesn't have one yet, picking the
/// next palette color. Returns the full vocabulary.
fn ensure_tag_defs(project_root: &Path, names: &[String]) -> AppResult<Vec<TagDef>> {
    let mut sidecar = load_sidecar_for_update(project_root)?;
    let mut added = false;
    for name in names {
        if sidecar.tag_defs.iter().any(|d| eq_tag(&d.name, name)) {
            continue;
        }
        let color = PALETTE[sidecar.tag_defs.len() % PALETTE.len()].to_string();
        sidecar.tag_defs.push(TagDef {
            name: name.clone(),
            color,
        });
        added = true;
    }
    if added {
        save_sidecar(project_root, &sidecar)?;
    }
    Ok(sidecar.tag_defs)
}

// ---------- filesystem walk ----------

/// Every media file in the project, at any depth (so `SRC`/`SEL` and any
/// hand-made folder are covered — unlike reconcile, which only looks at
/// `<seq>/<shot>/<version>/`). Skips hidden/system dirs and thumb adjuncts.
fn walk_media(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if !name.starts_with('.') && !name.starts_with('$') {
                walk_media(&path, out);
            }
        } else if is_media_ext(&path) && !is_thumb(&path) {
            out.push(path);
        }
    }
}

fn project_media(project_root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_media(project_root, &mut out);
    out.sort();
    out
}

/// Rewrite every sidecar in the project whose tags `edit` changes. Used by
/// rename and delete, which have to reach files the index may not know
/// about — the sidecar is the record that has to be right.
///
/// The filesystem walk is deliberately kept: narrowing to what the index knows
/// would silently skip a file dropped in from outside, or a sidecar edited by
/// hand, and this is precisely the path that has to repair those. What the index
/// *does* save is the read — a project-wide tag rename used to parse every
/// sidecar on disk to find the handful carrying that tag. Now a file the index
/// knows is decided from the index, and only the ones actually being changed are
/// read and written. Files the index has never seen still fall back to reading
/// their sidecar, so nothing is missed.
fn sweep_tags(
    project_root: &Path,
    index: &db::TagIndex,
    edit: impl Fn(&[String]) -> Option<Vec<String>>,
) -> AppResult<Vec<TagUpdate>> {
    let project_id = db::read_project_id(project_root)?;
    let root = ProjectRoot::from_root(project_root.to_path_buf());
    let mut updates = Vec::new();

    for media in project_media(project_root) {
        let indexed_tags = root
            .rel(&media)
            .filter(|rel| index.is_indexed(rel))
            .map(|rel| index.tags_for(rel.as_str()));

        // Only touch the disk when the index doesn't already know the answer.
        let current = match indexed_tags {
            Some(tags) => tags,
            None => {
                let value = read_sidecar_value(&media);
                match value.as_object() {
                    Some(obj) => tags_from_sidecar(obj),
                    None => continue,
                }
            }
        };

        let Some(next) = edit(&current) else {
            continue;
        };
        if let Some(update) = write_tags(&media, project_root, &project_id, next)? {
            updates.push(update);
        }
    }
    Ok(updates)
}

/// Apply index work, logging rather than failing: the sidecars are already
/// written by the time this runs, and the index rebuilds from them.
async fn apply_updates(project_root: &Path, updates: &[TagUpdate]) -> u32 {
    match db::asset_tags_apply(project_root, updates).await {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!("tag index update failed: {e}");
            0
        }
    }
}

// ---------- commands ----------

/// Set the complete tag list for one image. Returns the normalized list that
/// was actually written.
#[tauri::command]
pub async fn image_tags_set(image_path: String, tags: Vec<String>) -> AppResult<Vec<String>> {
    let (root, applied, update) = run_blocking(move || {
        let media = PathBuf::from(&image_path);
        if !media.is_file() {
            return Err(AppError::Msg(format!("not a file: {image_path}")));
        }
        let root = project_root_for(&media)?;
        let project_id = db::read_project_id(&root)?;
        let tags = normalize_tags(tags);
        ensure_tag_defs(&root, &tags)?;
        let update = write_tags(&media, &root, &project_id, tags.clone())?;
        Ok((root, tags, update))
    })
    .await?;
    if let Some(update) = update {
        apply_updates(&root, &[update]).await;
    }
    Ok(applied)
}

#[tauri::command]
pub fn project_tag_defs_get(project_path: String) -> AppResult<Vec<TagDef>> {
    Ok(load_sidecar(&PathBuf::from(&project_path))?.tag_defs)
}

/// Replace the vocabulary wholesale — used by the tag manager for recolor
/// and reorder. Names are not touched here; renaming goes through
/// `project_tag_rename` so the sidecars come along.
#[tauri::command]
pub fn project_tag_defs_set(project_path: String, defs: Vec<TagDef>) -> AppResult<Vec<TagDef>> {
    let root = PathBuf::from(&project_path);
    let mut sidecar = load_sidecar_for_update(&root)?;
    sidecar.tag_defs = defs;
    save_sidecar(&root, &sidecar)?;
    Ok(sidecar.tag_defs)
}

#[tauri::command]
pub async fn project_tag_rename(
    project_path: String,
    old_name: String,
    new_name: String,
) -> AppResult<Vec<TagDef>> {
    // Loaded once, before the blocking sweep, so it can decide most files
    // without reading their sidecars.
    let index = db::tags_all(&PathBuf::from(&project_path))
        .await
        .unwrap_or_default();
    let (root, defs, updates) = run_blocking(move || {
        let root = PathBuf::from(&project_path);
        let old =
            normalize_tag(&old_name).ok_or_else(|| AppError::Msg("no tag to rename".into()))?;
        let new =
            normalize_tag(&new_name).ok_or_else(|| AppError::Msg("new name is empty".into()))?;
        if eq_tag(&old, &new) {
            return Ok((root.clone(), load_sidecar(&root)?.tag_defs, Vec::new()));
        }
        let updates = sweep_tags(&root, &index, |current| {
            if !current.iter().any(|t| eq_tag(t, &old)) {
                return None;
            }
            // Normalizing after the swap collapses the case where the image
            // already carried the destination tag as well.
            Some(normalize_tags(current.iter().map(|t| {
                if eq_tag(t, &old) {
                    new.clone()
                } else {
                    t.clone()
                }
            })))
        })?;

        let mut sidecar = load_sidecar_for_update(&root)?;
        let already = sidecar.tag_defs.iter().any(|d| eq_tag(&d.name, &new));
        sidecar
            .tag_defs
            .retain(|d| !already || !eq_tag(&d.name, &old));
        for def in sidecar.tag_defs.iter_mut() {
            if eq_tag(&def.name, &old) {
                def.name = new.clone();
            }
        }
        save_sidecar(&root, &sidecar)?;
        Ok((root, sidecar.tag_defs, updates))
    })
    .await?;
    apply_updates(&root, &updates).await;
    Ok(defs)
}

#[tauri::command]
pub async fn project_tag_delete(project_path: String, name: String) -> AppResult<Vec<TagDef>> {
    let index = db::tags_all(&PathBuf::from(&project_path))
        .await
        .unwrap_or_default();
    let (root, defs, updates) = run_blocking(move || {
        let root = PathBuf::from(&project_path);
        let target =
            normalize_tag(&name).ok_or_else(|| AppError::Msg("no tag to delete".into()))?;
        let updates = sweep_tags(&root, &index, |current| {
            if !current.iter().any(|t| eq_tag(t, &target)) {
                return None;
            }
            Some(
                current
                    .iter()
                    .filter(|t| !eq_tag(t, &target))
                    .cloned()
                    .collect(),
            )
        })?;
        let mut sidecar = load_sidecar_for_update(&root)?;
        sidecar.tag_defs.retain(|d| !eq_tag(&d.name, &target));
        save_sidecar(&root, &sidecar)?;
        Ok((root, sidecar.tag_defs, updates))
    })
    .await?;
    apply_updates(&root, &updates).await;
    Ok(defs)
}

/// Rebuild the tag index *and* the vocabulary from the sidecars on disk.
/// Much cheaper than `project_reconcile` — no content hashing, and only files
/// that actually carry tags are touched.
///
/// This is the repair path for any drift between the three layers: the
/// sidecars win, so every tag name found on disk is re-indexed and gets a
/// `tagDefs` entry if the project doesn't have one.
#[tauri::command]
pub async fn project_tags_reindex(project_path: String) -> AppResult<u32> {
    let (root, updates) = run_blocking(move || {
        let root = PathBuf::from(&project_path);
        let project_id = db::read_project_id(&root)?;
        let mut updates = Vec::new();
        let mut discovered: Vec<String> = Vec::new();
        for media in project_media(&root) {
            let value = read_sidecar_value(&media);
            let Some(obj) = value.as_object() else {
                continue;
            };
            let tags = tags_from_sidecar(obj);
            if tags.is_empty() {
                continue;
            }
            discovered.extend(tags.iter().cloned());
            if let Some(update) = write_tags(&media, &root, &project_id, tags)? {
                updates.push(update);
            }
        }
        ensure_tag_defs(&root, &normalize_tags(discovered))?;
        Ok((root, updates))
    })
    .await?;
    Ok(apply_updates(&root, &updates).await)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMigrationReport {
    /// False when this project had already been migrated — the other counts
    /// are then meaningless and no files were touched.
    pub ran: bool,
    pub starred: u32,
    pub selects: u32,
}

/// One-shot conversion of the two things tags replaced: `project.json`'s
/// `visible` list becomes the `fav` tag, and everything already sitting in a
/// `SEL/` folder becomes the `select` tag. The SEL files themselves are left
/// exactly where they are — only the marking moves.
#[tauri::command]
pub async fn project_tags_migrate(project_path: String) -> AppResult<TagMigrationReport> {
    let (root, report, updates) = run_blocking(move || {
        let root = PathBuf::from(&project_path);
        let sidecar = load_sidecar_for_update(&root)?;
        if sidecar.tags_migrated {
            return Ok((root, TagMigrationReport::default(), Vec::new()));
        }
        let project_id = db::read_project_id(&root)?;

        // media path -> tags to add
        let mut additions: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
        let mut starred = 0u32;
        for rel in &sidecar.visible {
            let abs = root.join(rel);
            if !abs.is_file() {
                continue;
            }
            additions.entry(abs).or_default().push(TAG_FAV.to_string());
            starred += 1;
        }
        let mut selects = 0u32;
        for media in project_media(&root) {
            let in_sel = media
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == SEL_DIR);
            if !in_sel {
                continue;
            }
            additions
                .entry(media)
                .or_default()
                .push(TAG_SELECT.to_string());
            selects += 1;
        }

        let mut updates = Vec::new();
        for (media, added) in additions {
            let value = read_sidecar_value(&media);
            let existing = value.as_object().map(tags_from_sidecar).unwrap_or_default();
            let merged = normalize_tags(existing.into_iter().chain(added));
            if let Some(update) = write_tags(&media, &root, &project_id, merged)? {
                updates.push(update);
            }
        }

        let mut sidecar = load_sidecar_for_update(&root)?;
        let mut used: Vec<String> = Vec::new();
        if starred > 0 {
            used.push(TAG_FAV.to_string());
        }
        if selects > 0 {
            used.push(TAG_SELECT.to_string());
        }
        sidecar.visible.clear();
        sidecar.tags_migrated = true;
        save_sidecar(&root, &sidecar)?;
        ensure_tag_defs(&root, &used)?;

        Ok((
            root,
            TagMigrationReport {
                ran: true,
                starred,
                selects,
            },
            updates,
        ))
    })
    .await?;
    apply_updates(&root, &updates).await;
    Ok(report)
}

// ---------- querying ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotTaggedGroup {
    pub shot_path: String,
    pub shot_name: String,
    pub images: Vec<GalleryImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqTaggedGroup {
    pub seq_path: String,
    pub seq_name: String,
    pub shots: Vec<ShotTaggedGroup>,
}

/// "any" (default) matches an image carrying at least one of `tags`; "all"
/// requires every one of them. An empty `tags` means "anything tagged".
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TagFilterMode {
    #[default]
    Any,
    All,
}

fn matches(image_tags: &[String], wanted: &[String], mode: TagFilterMode) -> bool {
    if wanted.is_empty() {
        return !image_tags.is_empty();
    }
    let has = |w: &String| image_tags.iter().any(|t| eq_tag(t, w));
    match mode {
        TagFilterMode::Any => wanted.iter().any(has),
        TagFilterMode::All => wanted.iter().all(has),
    }
}

/// Every tagged image in the project matching the filter, grouped
/// sequence -> shot. Ghost rows (indexed files that no longer exist) are
/// skipped rather than reported.
#[tauri::command]
pub async fn project_tag_scan(
    project_path: String,
    tags: Vec<String>,
    mode: Option<TagFilterMode>,
) -> AppResult<Vec<SeqTaggedGroup>> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    let mode = mode.unwrap_or_default();
    let wanted = normalize_tags(tags);
    let index = db::tags_all(&root).await?;

    // In a PRISM project every media path starts with the entity root
    // ("03_Production/Shots/…"), so the seq/shot pair is two segments further
    // in — group on the path with that prefix stripped.
    let entity_prefixes: Vec<String> = match prism::detect(&root) {
        Some(layout) => vec![
            format!("{}/", layout.shots_rel),
            format!("{}/", layout.assets_rel),
        ],
        None => vec![],
    };

    // Keyed by project-relative dir rather than bare name, so the two PRISM
    // trees can't collide on a shared sequence name and the output paths can be
    // rebuilt exactly. In a native project these keys *are* the names.
    type ShotMap = BTreeMap<String, Vec<GalleryImage>>;
    let mut by_seq: BTreeMap<String, ShotMap> = BTreeMap::new();
    let mut rels: Vec<&String> = index.by_rel.keys().collect();
    rels.sort();
    for rel in rels {
        let image_tags = &index.by_rel[rel];
        if !matches(image_tags, &wanted, mode) {
            continue;
        }
        // Expect at least <seq>/<shot>/<file>; project-level SRC has no shot
        // to group under and is left out, same as the starred view before it.
        let (prefix, grouping) = entity_prefixes
            .iter()
            .find_map(|p| rel.strip_prefix(p.as_str()).map(|rest| (p.as_str(), rest)))
            .unwrap_or(("", rel.as_str()));
        let parts: Vec<&str> = grouping.split('/').collect();
        if parts.len() < 3 {
            continue;
        }
        let abs = root.join(rel);
        if !abs.is_file() {
            continue;
        }
        let generated_by = index.generated_by_for(rel);
        let Some(img) = try_make_gallery_image(&abs, image_tags.clone(), generated_by) else {
            continue;
        };
        by_seq
            .entry(format!("{prefix}{}", parts[0]))
            .or_default()
            .entry(format!("{prefix}{}/{}", parts[0], parts[1]))
            .or_default()
            .push(img);
    }

    let prism_mode = !entity_prefixes.is_empty();
    let leaf = |rel: &str| rel.rsplit('/').next().unwrap_or(rel).to_string();
    Ok(by_seq
        .into_iter()
        .map(|(seq_rel, shots)| SeqTaggedGroup {
            seq_path: as_str(&root.join(&seq_rel)),
            seq_name: leaf(&seq_rel),
            shots: shots
                .into_iter()
                .map(|(shot_rel, images)| {
                    let entity = root.join(&shot_rel);
                    let shot_path = if prism_mode {
                        prism::media_root_for(&entity)
                    } else {
                        entity
                    };
                    ShotTaggedGroup {
                        shot_path: as_str(&shot_path),
                        shot_name: leaf(&shot_rel),
                        images,
                    }
                })
                .collect(),
        })
        .collect())
}

/// Copy every image matching the filter out of the project. `mode`
/// "preserve" mirrors each file's path under the destination; anything else
/// flattens into one folder with a `seq_shot_` filename prefix. The sidecar and
/// thumbnail come along so the export stays self-describing and browsable.
#[tauri::command]
pub async fn export_by_tag(
    project_path: String,
    tags: Vec<String>,
    mode: Option<TagFilterMode>,
    dest_dir: String,
    layout: String,
) -> AppResult<u32> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    let wanted = normalize_tags(tags);
    let filter_mode = mode.unwrap_or_default();
    let index = db::tags_all(&root).await?;
    let hits: Vec<String> = index
        .by_rel
        .iter()
        .filter(|(_, t)| matches(t, &wanted, filter_mode))
        .map(|(rel, _)| rel.clone())
        .collect();

    run_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        ensure_dir(&dest)?;
        let preserve = layout == "preserve";
        let mut copied = 0u32;
        let mut sorted = hits;
        sorted.sort();
        for rel in sorted {
            let src = root.join(&rel);
            if !src.is_file() {
                continue;
            }
            let parts: Vec<&str> = rel.split('/').collect();
            let fname = match parts.last() {
                Some(n) => (*n).to_string(),
                None => continue,
            };
            let dst = if preserve {
                let mut d = dest.clone();
                for part in &parts[..parts.len() - 1] {
                    d = d.join(part);
                }
                ensure_dir(&d)?;
                d.join(&fname)
            } else {
                let prefix = parts[..parts.len() - 1].join("_");
                dest.join(format!("{prefix}_{fname}"))
            };
            std::fs::copy(&src, &dst)?;
            copied += 1;
            // The whole media triple travels, so the export keeps its
            // provenance (and its tags) and stays browsable. Both companions
            // are derived from `dst`, not copied under their source names: the
            // flatten layout renames the media to `{prefix}_{fname}`, and a
            // companion that keeps the old stem would never be found again.
            // Whichever thumbnail suffix the source actually has; the
            // `is_file` guard below skips it when there is none.
            let src_thumb = existing_thumb_path(&src).unwrap_or_else(|| thumb_path(&src));
            let dst_thumb = thumb_path_like(&dst, &src_thumb);
            for (src_side, dst_side, what) in [
                (sidecar_path(&src), sidecar_path(&dst), "sidecar"),
                (src_thumb, dst_thumb, "thumbnail"),
            ] {
                if src_side.is_file() {
                    if let Err(e) = std::fs::copy(&src_side, &dst_side) {
                        tracing::warn!("{what} export failed for {rel}: {e}");
                    }
                }
            }
        }
        Ok(copied)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestProject;
    use std::fs;

    fn media(root: &Path, rel: &str, sidecar: Option<Value>) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fake media").unwrap();
        if let Some(value) = sidecar {
            write_json_atomic(&sidecar_path(&path), &value).unwrap();
        }
        path
    }

    fn sidecar_tags_of(media: &Path) -> Vec<String> {
        read_sidecar_value(media)
            .as_object()
            .map(tags_from_sidecar)
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn setting_tags_writes_the_sidecar_and_seeds_the_vocabulary() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        // No sidecar at all — an OS-dragged reference image.
        let img = media(&root, "seq1/shot1/SRC/ref.png", None);

        let applied = image_tags_set(as_str(&img), vec!["  Hero  ".into(), "hero".into()])
            .await
            .unwrap();
        assert_eq!(applied, vec!["Hero".to_string()]);
        assert_eq!(sidecar_tags_of(&img), vec!["Hero".to_string()]);

        let defs = project_tag_defs_get(as_str(&root)).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "Hero");
        assert!(!defs[0].color.is_empty());

        // The index picked it up, which means the file got an identity too.
        let idx = db::tags_all(&root).await.unwrap();
        assert_eq!(
            idx.tags_for("seq1/shot1/SRC/ref.png"),
            vec!["Hero".to_string()]
        );

        // Clearing drops the key rather than leaving an empty array behind.
        image_tags_set(as_str(&img), vec![]).await.unwrap();
        assert!(read_sidecar_value(&img).get("tags").is_none());
        assert!(db::tags_all(&root)
            .await
            .unwrap()
            .tags_for("seq1/shot1/SRC/ref.png")
            .is_empty());
    }

    #[tokio::test]
    async fn rename_and_delete_sweep_every_sidecar() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        let a = media(&root, "seq1/shot1/gen001/a.png", None);
        let b = media(&root, "seq1/shot2/gen001/b.png", None);
        image_tags_set(as_str(&a), vec!["fav".into(), "wip".into()])
            .await
            .unwrap();
        image_tags_set(as_str(&b), vec!["wip".into()])
            .await
            .unwrap();

        project_tag_rename(as_str(&root), "wip".into(), "In progress".into())
            .await
            .unwrap();
        assert_eq!(
            sidecar_tags_of(&a),
            vec!["fav".to_string(), "In progress".to_string()]
        );
        assert_eq!(sidecar_tags_of(&b), vec!["In progress".to_string()]);
        let names: Vec<String> = project_tag_defs_get(as_str(&root))
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["fav".to_string(), "In progress".to_string()]);

        let defs = project_tag_delete(as_str(&root), "In progress".into())
            .await
            .unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(sidecar_tags_of(&a), vec!["fav".to_string()]);
        assert!(sidecar_tags_of(&b).is_empty());
    }

    /// The sweep consults the tag index to avoid reading every sidecar on disk,
    /// but the index is only ever a shortcut — a file it has never seen must
    /// still be found and repaired. That is the entire reason the sweep walks
    /// the filesystem instead of querying the index for candidates.
    #[tokio::test]
    async fn sweep_still_reaches_a_file_the_index_has_never_seen() {
        let project = TestProject::new("tags");
        let root = project.root.clone();

        // Indexed the normal way.
        let known = media(&root, "seq1/shot1/gen001/known.png", None);
        image_tags_set(as_str(&known), vec!["wip".into()])
            .await
            .unwrap();

        // Dropped in from outside with a hand-written sidecar: it carries the
        // tag, but nothing ever told the index about it.
        let stranger = media(
            &root,
            "seq1/shot1/gen001/stranger.png",
            Some(serde_json::json!({ "tags": ["wip"] })),
        );
        let index = db::tags_all(&root).await.unwrap();
        assert!(
            !index.is_indexed("seq1/shot1/gen001/stranger.png"),
            "precondition: the index must not know this file"
        );

        project_tag_rename(as_str(&root), "wip".into(), "done".into())
            .await
            .unwrap();

        assert_eq!(sidecar_tags_of(&known), vec!["done".to_string()]);
        assert_eq!(
            sidecar_tags_of(&stranger),
            vec!["done".to_string()],
            "an unindexed sidecar must still be swept"
        );

        project_tag_delete(as_str(&root), "done".into())
            .await
            .unwrap();
        assert!(sidecar_tags_of(&stranger).is_empty());
    }

    #[tokio::test]
    async fn migration_converts_stars_and_sel_contents_exactly_once() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        let starred = media(&root, "seq1/shot1/gen001/star.png", None);
        let selected = media(&root, "seq1/shot1/SEL/keep.png", None);
        media(&root, "seq1/shot1/gen001/plain.png", None);

        let mut sidecar = load_sidecar(&root).unwrap();
        sidecar.visible = vec![
            "seq1/shot1/gen001/star.png".into(),
            "seq1/shot1/gone.png".into(), // stale entry, no such file
        ];
        save_sidecar(&root, &sidecar).unwrap();

        let report = project_tags_migrate(as_str(&root)).await.unwrap();
        assert!(report.ran);
        assert_eq!(report.starred, 1);
        assert_eq!(report.selects, 1);
        assert_eq!(sidecar_tags_of(&starred), vec![TAG_FAV.to_string()]);
        assert_eq!(sidecar_tags_of(&selected), vec![TAG_SELECT.to_string()]);

        let after = load_sidecar(&root).unwrap();
        assert!(after.visible.is_empty());
        assert!(after.tags_migrated);
        assert_eq!(after.tag_defs.len(), 2);

        // The SEL file stays exactly where it was — only the marking moved.
        assert!(selected.is_file());

        // Second run is a no-op.
        let again = project_tags_migrate(as_str(&root)).await.unwrap();
        assert!(!again.ran);
    }

    #[tokio::test]
    async fn reindex_rebuilds_the_index_from_sidecars_alone() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        let img = media(&root, "seq1/shot1/gen001/a.png", None);
        image_tags_set(as_str(&img), vec!["fav".into()])
            .await
            .unwrap();

        db::assets_purge(&root, "seq1", true).await.unwrap();
        assert!(db::tags_all(&root)
            .await
            .unwrap()
            .tags_for("seq1/shot1/gen001/a.png")
            .is_empty());

        // Vocabulary drift (what a project nested under another project's
        // project.json produced): the sidecar has the tag, project.json
        // doesn't know it. Reindex must rebuild both.
        let mut sidecar = load_sidecar(&root).unwrap();
        sidecar.tag_defs.clear();
        save_sidecar(&root, &sidecar).unwrap();

        assert_eq!(project_tags_reindex(as_str(&root)).await.unwrap(), 1);
        let names: Vec<String> = project_tag_defs_get(as_str(&root))
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["fav".to_string()]);
        assert_eq!(
            db::tags_all(&root)
                .await
                .unwrap()
                .tags_for("seq1/shot1/gen001/a.png"),
            vec!["fav".to_string()]
        );
    }

    #[tokio::test]
    async fn scan_groups_by_sequence_and_shot_and_honours_the_filter() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        let a = media(&root, "seq1/shot1/gen001/a.png", None);
        let b = media(&root, "seq1/shot2/gen001/b.png", None);
        let c = media(&root, "seq2/shot1/gen001/c.png", None);
        image_tags_set(as_str(&a), vec!["fav".into(), "hero".into()])
            .await
            .unwrap();
        image_tags_set(as_str(&b), vec!["hero".into()])
            .await
            .unwrap();
        image_tags_set(as_str(&c), vec!["fav".into()])
            .await
            .unwrap();

        let all = project_tag_scan(as_str(&root), vec![], None).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].seq_name, "seq1");
        assert_eq!(all[0].shots.len(), 2);
        assert_eq!(all[0].shots[0].images[0].tags, vec!["fav", "hero"]);

        let both = project_tag_scan(
            as_str(&root),
            vec!["fav".into(), "hero".into()],
            Some(TagFilterMode::All),
        )
        .await
        .unwrap();
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].shots.len(), 1);
        assert_eq!(both[0].shots[0].images.len(), 1);

        // A file deleted behind the index's back is skipped, not reported.
        fs::remove_file(&c).unwrap();
        let favs = project_tag_scan(as_str(&root), vec!["fav".into()], None)
            .await
            .unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].seq_name, "seq1");
    }

    /// In a PRISM project every media path carries the entity root and the
    /// `Renders/2dRender/AI` hop, so grouping on the first two segments files
    /// everything under "03_Production / Shots".
    #[tokio::test]
    async fn scan_groups_prism_paths_by_entity() {
        let project = TestProject::new("tags");
        let root = project.root.clone();
        fs::create_dir_all(root.join("00_Pipeline")).unwrap();
        fs::write(
            root.join("00_Pipeline/pipeline.json"),
            r#"{"globals":{"versionPadding":4}}"#,
        )
        .unwrap();

        let shot = media(
            &root,
            "03_Production/Shots/MOD/s0010/Renders/2dRender/AI/v0001/a.png",
            None,
        );
        let asset = media(
            &root,
            "03_Production/Assets/PROPS/cube/Renders/2dRender/AI/v0001/b.png",
            None,
        );
        image_tags_set(as_str(&shot), vec!["fav".into()])
            .await
            .unwrap();
        image_tags_set(as_str(&asset), vec!["fav".into()])
            .await
            .unwrap();

        let groups = project_tag_scan(as_str(&root), vec![], None).await.unwrap();
        let names: Vec<&str> = groups.iter().map(|g| g.seq_name.as_str()).collect();
        assert_eq!(names, vec!["PROPS", "MOD"]);

        let mod_group = groups.iter().find(|g| g.seq_name == "MOD").unwrap();
        assert_eq!(mod_group.shots.len(), 1);
        assert_eq!(mod_group.shots[0].shot_name, "s0010");
        // shot_path must be the media root — that's what the session opens, and
        // what the timeline keys its clips by.
        assert!(
            mod_group.shots[0]
                .shot_path
                .ends_with("Shots/MOD/s0010/Renders/2dRender/AI"),
            "got {}",
            mod_group.shots[0].shot_path
        );
        assert!(mod_group.seq_path.ends_with("03_Production/Shots/MOD"));

        let props = groups.iter().find(|g| g.seq_name == "PROPS").unwrap();
        assert_eq!(props.shots[0].shot_name, "cube");
    }

    /// The media triple has to survive an export intact. The thumbnail is the
    /// one that used to be dropped, which mattered most for video and 3D
    /// output — there the thumbnail *is* the only thing a file browser can
    /// show. Both companions must land under the *destination* stem, since the
    /// flatten layout renames the media.
    #[tokio::test]
    async fn export_carries_the_sidecar_and_the_thumbnail_in_both_layouts() {
        let project = TestProject::new("export");
        let root = project.root.clone();

        let video = media(
            &root,
            "seq1/shot1/gen001/clip.mp4",
            Some(serde_json::json!({ "tags": ["fav"], "assetId": "a1" })),
        );
        fs::write(thumb_path(&video), b"fake thumb").unwrap();
        image_tags_set(as_str(&video), vec!["fav".into()])
            .await
            .unwrap();

        // Flattened: media is renamed `seq1_shot1_gen001_clip.mp4`, so the
        // companions must be renamed to match or nothing resolves them.
        let flat = root.join("out-flat");
        let n = export_by_tag(
            as_str(&root),
            vec!["fav".into()],
            None,
            as_str(&flat),
            "flatten".into(),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let flat_media = flat.join("seq1_shot1_gen001_clip.mp4");
        assert!(flat_media.is_file(), "media exported");
        assert!(sidecar_path(&flat_media).is_file(), "sidecar exported");
        assert!(thumb_path(&flat_media).is_file(), "thumbnail exported");

        // Preserved: same three files, original names, mirrored path.
        let tree = root.join("out-tree");
        export_by_tag(
            as_str(&root),
            vec!["fav".into()],
            None,
            as_str(&tree),
            "preserve".into(),
        )
        .await
        .unwrap();
        let kept = tree.join("seq1/shot1/gen001/clip.mp4");
        assert!(kept.is_file(), "media exported");
        assert!(sidecar_path(&kept).is_file(), "sidecar exported");
        assert!(thumb_path(&kept).is_file(), "thumbnail exported");
    }

    /// A damaged `project.json` used to read as an empty `ProjectSidecar`, and
    /// the save that followed committed that emptiness — taking the project id,
    /// title, migration flag and the entire tag vocabulary with it. The write
    /// must now refuse, and the file must still be on disk afterwards.
    #[test]
    fn a_corrupt_project_json_is_never_silently_replaced() {
        let project = TestProject::new("corrupt");
        let root = project.root.clone();

        // Seed a real vocabulary, then damage the file.
        project_tag_defs_set(
            as_str(&root),
            vec![TagDef {
                name: "hero".into(),
                color: "#ff0000".into(),
            }],
        )
        .unwrap();
        let sidecar_file = root.join(PROJECT_SIDECAR);
        let intact = fs::read_to_string(&sidecar_file).unwrap();
        assert!(intact.contains("hero"));

        fs::write(&sidecar_file, b"{ this is not json").unwrap();

        // Every read-modify-write path must refuse rather than default.
        assert!(
            project_tag_defs_set(as_str(&root), vec![]).is_err(),
            "defs_set must not overwrite a corrupt project.json"
        );
        assert!(
            ensure_tag_defs(&root, &["new".to_string()]).is_err(),
            "ensure_tag_defs must not overwrite a corrupt project.json"
        );

        // The damaged bytes survive, and a recovery copy was made alongside.
        assert_eq!(
            fs::read_to_string(&sidecar_file).unwrap(),
            "{ this is not json"
        );
        let backups: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("project.corrupt-")
            })
            .collect();
        assert!(!backups.is_empty(), "a .corrupt- copy should be preserved");

        // A pure read still degrades gracefully — the picker shows no tags
        // rather than the whole app refusing to open the project.
        assert!(project_tag_defs_get(as_str(&root)).unwrap().is_empty());
    }

    #[test]
    fn normalize_trims_collapses_and_dedupes_case_insensitively() {
        assert_eq!(normalize_tag("  hero   shot "), Some("hero shot".into()));
        assert_eq!(normalize_tag("   "), None);
        assert_eq!(
            normalize_tags(["Fav", "fav", " ", "select"]),
            vec!["Fav".to_string(), "select".to_string()]
        );
    }

    #[test]
    fn tags_read_out_of_a_sidecar_object() {
        let value: Value = serde_json::json!({ "tags": ["a", "", "A", "b"], "other": 1 });
        assert_eq!(
            tags_from_sidecar(value.as_object().unwrap()),
            vec!["a".to_string(), "b".to_string()]
        );
        let empty: Value = serde_json::json!({});
        assert!(tags_from_sidecar(empty.as_object().unwrap()).is_empty());
    }

    #[test]
    fn filter_modes_behave() {
        let tags = vec!["fav".to_string(), "hero".to_string()];
        assert!(matches(&tags, &[], TagFilterMode::Any));
        assert!(!matches(&[], &[], TagFilterMode::Any));
        assert!(matches(&tags, &["FAV".into()], TagFilterMode::Any));
        assert!(matches(
            &tags,
            &["fav".into(), "nope".into()],
            TagFilterMode::Any
        ));
        assert!(!matches(
            &tags,
            &["fav".into(), "nope".into()],
            TagFilterMode::All
        ));
        assert!(matches(
            &tags,
            &["fav".into(), "hero".into()],
            TagFilterMode::All
        ));
    }
}
