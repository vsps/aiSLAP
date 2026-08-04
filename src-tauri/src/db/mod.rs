//! Local-first SQLite index of generated assets, with an outbox-based sync
//! to a remote Turso primary. Disk (media files + `.json` sidecars) stays
//! the source of truth; this is a rebuildable index plus, eventually, a
//! shared-state layer for multiple people on a shared drive.
//!
//! Every write lands in the local file first — sidecar write is still the
//! durable commit, this is best-effort enrichment — and is queued in
//! `outbox`. There is no autonomous background sync timer here: the Rust
//! backend has no notion of "the project the user currently has open" (every
//! command is a stateless, path-scoped call, matching the rest of this
//! codebase), so flushing the outbox is triggered by the frontend instead
//! (after every asset write, and once on project open) via `sync_outbox`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use libsql::{params, Builder, Connection, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::config::turso_config;
use crate::commands::fsutil::{
    as_str, is_image_ext, is_model3d_ext, is_video_ext, list_dirs, relativize, PROJECT_SIDECAR,
    SEL_DIR, SRC_DIR,
};
use crate::commands::media_id::{file_hash_impl, media_id_embed_impl};
use crate::commands::prism;
use crate::commands::tags::tags_from_sidecar;
use crate::domain::ProjectSidecar;
use crate::error::{AppError, AppResult};
use crate::fsjson::{read_json_or_default, write_json_atomic};
use crate::paths::appdata_dir;

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        rel_path TEXT NOT NULL,
        content_hash TEXT,
        kind TEXT NOT NULL,
        provider TEXT,
        model_id TEXT,
        endpoint TEXT,
        combined_prompt TEXT,
        settings_json TEXT,
        cost_usd REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    )",
    "CREATE INDEX IF NOT EXISTS idx_assets_rel_path ON assets(project_id, rel_path)",
    "CREATE INDEX IF NOT EXISTS idx_assets_content_hash ON assets(project_id, content_hash)",
    "CREATE TABLE IF NOT EXISTS asset_refs (
        asset_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ref_asset_id TEXT,
        ref_rel_path TEXT,
        ref_hash TEXT,
        role_json TEXT,
        PRIMARY KEY (asset_id, ordinal)
    )",
    // Tag index. The per-image sidecar's `tags` array is the source of
    // truth; these rows exist so a gallery scan is one query instead of one
    // sidecar read per file, and are rebuilt from disk by `tags_reindex` /
    // reconcile whenever they go missing or stale.
    "CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag)
    )",
    "CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag)",
    // Phase 3 tables — created now so that phase doesn't need a migration
    // touch, unused by anything in this file yet.
    "CREATE TABLE IF NOT EXISTS shot_state (
        project_id TEXT NOT NULL,
        shot_rel_path TEXT NOT NULL,
        clip_media_asset_id TEXT,
        version_selects_json TEXT,
        version_comments_json TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (project_id, shot_rel_path)
    )",
    "CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        scope_rel_path TEXT NOT NULL,
        channel TEXT NOT NULL,
        ts TEXT NOT NULL,
        prompt TEXT,
        prompts_json TEXT,
        user TEXT
    )",
    // Outbox is keyed by asset_id alone (not (table, id)) because every
    // writer today — asset_upsert, asset_refs_set, asset_tags_apply — is
    // scoped to a single asset id and `push_one_asset` resyncs all three
    // tables for that id in one go, so one row covers the lot and re-queuing
    // collapses via the PK. A future table keyed by anything other than an
    // asset id will need its own outbox key shape.
    "CREATE TABLE IF NOT EXISTS outbox (
        asset_id TEXT PRIMARY KEY,
        queued_at TEXT NOT NULL
    )",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub rel_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// "image" | "video" | "model3d" | "other".
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combined_prompt: Option<String>,
    /// JSON-encoded settings object — kept opaque here, same as the sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRefRecord {
    pub ordinal: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_rel_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_json: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub configured: bool,
    pub pushed: u32,
    pub pending: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub scanned: u32,
    /// Pre-Phase-1 files with no `assetId` in their sidecar — minted an id,
    /// best-effort embedded it, hashed, and rewrote the sidecar.
    pub sidecar_backfilled: u32,
    /// New DB rows created (covers freshly backfilled assets and assets that
    /// already had an id/hash but had never been indexed).
    pub db_ingested: u32,
    /// Existing DB rows whose `rel_path` no longer matched the file's
    /// current location — updated in place.
    pub relinked: u32,
    /// Assets whose indexed tags disagreed with their sidecar — the sidecar
    /// wins, so this is how tags edited outside this app (or lost with a
    /// deleted index file) find their way back in.
    pub tags_synced: u32,
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::Msg(format!("db: {e}"))
}

/// Read the project's id straight from `project.json` rather than trusting
/// a value handed over IPC — the frontend mints it asynchronously right
/// after `project_open`, and a DB command could in principle race that.
/// Empty string when the project hasn't been assigned one yet.
pub(crate) fn read_project_id(project_root: &Path) -> AppResult<String> {
    let sidecar: ProjectSidecar = read_json_or_default(&project_root.join(PROJECT_SIDECAR))?;
    Ok(sidecar.project_id)
}

/// Stable local filename for a project's index file. Prefers the project id;
/// falls back to a hash of the project path itself so the file is still
/// well-defined (and never collides with another project) in the rare case
/// a command races the id mint.
fn local_db_key(project_root: &Path, project_id: &str) -> String {
    if !project_id.is_empty() {
        return project_id.to_string();
    }
    let mut hasher = Sha256::new();
    hasher.update(as_str(project_root).as_bytes());
    format!("path-{:x}", hasher.finalize())
}

fn local_db_path(project_root: &Path, project_id: &str) -> AppResult<PathBuf> {
    let dir = appdata_dir()?.join("db");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.db", local_db_key(project_root, project_id))))
}

async fn bootstrap(conn: &Connection) -> AppResult<()> {
    for stmt in SCHEMA {
        conn.execute(stmt, ()).await.map_err(db_err)?;
    }
    Ok(())
}

/// Open (creating + bootstrapping on first use) the local index for a
/// project. Opened fresh per call — cheap for sqlite, and matches how every
/// other command in this app reopens its JSON files rather than holding
/// shared state across calls.
async fn open_local(project_root: &Path) -> AppResult<Connection> {
    let project_id = read_project_id(project_root)?;
    let path = local_db_path(project_root, &project_id)?;
    let db = Builder::new_local(&path).build().await.map_err(db_err)?;
    let conn = db.connect().map_err(db_err)?;
    bootstrap(&conn).await?;
    Ok(conn)
}

async fn open_remote(url: String, token: String) -> AppResult<Connection> {
    let db = Builder::new_remote(url, token)
        .build()
        .await
        .map_err(db_err)?;
    let conn = db.connect().map_err(db_err)?;
    bootstrap(&conn).await?;
    Ok(conn)
}

// ---------- row <-> struct ----------

fn opt_string(row: &Row, idx: i32) -> AppResult<Option<String>> {
    row.get::<Option<String>>(idx).map_err(db_err)
}

const ASSET_COLUMNS: &str = "id, project_id, rel_path, content_hash, kind, provider, model_id, \
     endpoint, combined_prompt, settings_json, cost_usd, created_at, updated_at, deleted_at";

fn row_to_asset(row: &Row) -> AppResult<AssetRecord> {
    Ok(AssetRecord {
        id: row.get::<String>(0).map_err(db_err)?,
        project_id: opt_string(row, 1)?,
        rel_path: row.get::<String>(2).map_err(db_err)?,
        content_hash: opt_string(row, 3)?,
        kind: row.get::<String>(4).map_err(db_err)?,
        provider: opt_string(row, 5)?,
        model_id: opt_string(row, 6)?,
        endpoint: opt_string(row, 7)?,
        combined_prompt: opt_string(row, 8)?,
        settings_json: opt_string(row, 9)?,
        cost_usd: row.get::<Option<f64>>(10).map_err(db_err)?,
        created_at: row.get::<String>(11).map_err(db_err)?,
        updated_at: opt_string(row, 12)?,
        deleted_at: opt_string(row, 13)?,
    })
}

async fn select_asset_by(
    conn: &Connection,
    column: &str,
    value: &str,
) -> AppResult<Option<AssetRecord>> {
    // `column` is always one of our own fixed literals ("id"/"content_hash")
    // below, never user input — safe to interpolate into the SQL text.
    let sql = format!(
        "SELECT {ASSET_COLUMNS} FROM assets WHERE {column} = ?1 AND deleted_at IS NULL LIMIT 1"
    );
    let mut rows = conn
        .query(&sql, params!(value.to_string()))
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(row) => Ok(Some(row_to_asset(&row)?)),
        None => Ok(None),
    }
}

async fn select_refs(conn: &Connection, asset_id: &str) -> AppResult<Vec<AssetRefRecord>> {
    let mut rows = conn
        .query(
            "SELECT ordinal, ref_asset_id, ref_rel_path, ref_hash, role_json \
             FROM asset_refs WHERE asset_id = ?1 ORDER BY ordinal",
            params!(asset_id.to_string()),
        )
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(AssetRefRecord {
            ordinal: row.get::<i64>(0).map_err(db_err)?,
            ref_asset_id: opt_string(&row, 1)?,
            ref_rel_path: opt_string(&row, 2)?,
            ref_hash: opt_string(&row, 3)?,
            role_json: opt_string(&row, 4)?,
        });
    }
    Ok(out)
}

async fn upsert_asset_row(conn: &Connection, record: &AssetRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO assets (id, project_id, rel_path, content_hash, kind, provider, model_id, \
             endpoint, combined_prompt, settings_json, cost_usd, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL)
         ON CONFLICT(id) DO UPDATE SET
           project_id=excluded.project_id, rel_path=excluded.rel_path,
           content_hash=excluded.content_hash, kind=excluded.kind, provider=excluded.provider,
           model_id=excluded.model_id, endpoint=excluded.endpoint,
           combined_prompt=excluded.combined_prompt, settings_json=excluded.settings_json,
           cost_usd=excluded.cost_usd, updated_at=excluded.updated_at, deleted_at=NULL",
        params!(
            record.id.clone(),
            record.project_id.clone(),
            record.rel_path.clone(),
            record.content_hash.clone(),
            record.kind.clone(),
            record.provider.clone(),
            record.model_id.clone(),
            record.endpoint.clone(),
            record.combined_prompt.clone(),
            record.settings_json.clone(),
            record.cost_usd,
            record.created_at.clone(),
            record.updated_at.clone().unwrap_or_default()
        ),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn replace_ref_rows(
    conn: &Connection,
    asset_id: &str,
    refs: &[AssetRefRecord],
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM asset_refs WHERE asset_id = ?1",
        params!(asset_id.to_string()),
    )
    .await
    .map_err(db_err)?;
    for r in refs {
        conn.execute(
            "INSERT INTO asset_refs (asset_id, ordinal, ref_asset_id, ref_rel_path, ref_hash, role_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params!(
                asset_id.to_string(),
                r.ordinal,
                r.ref_asset_id.clone(),
                r.ref_rel_path.clone(),
                r.ref_hash.clone(),
                r.role_json.clone()
            ),
        )
        .await
        .map_err(db_err)?;
    }
    Ok(())
}

async fn select_tags(conn: &Connection, asset_id: &str) -> AppResult<Vec<String>> {
    let mut rows = conn
        .query(
            "SELECT tag FROM asset_tags WHERE asset_id = ?1 ORDER BY tag",
            params!(asset_id.to_string()),
        )
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(row.get::<String>(0).map_err(db_err)?);
    }
    Ok(out)
}

async fn replace_tag_rows(conn: &Connection, asset_id: &str, tags: &[String]) -> AppResult<()> {
    conn.execute(
        "DELETE FROM asset_tags WHERE asset_id = ?1",
        params!(asset_id.to_string()),
    )
    .await
    .map_err(db_err)?;
    let now = chrono::Utc::now().to_rfc3339();
    for tag in tags {
        conn.execute(
            "INSERT INTO asset_tags (asset_id, tag, updated_at) VALUES (?1, ?2, ?3)",
            params!(asset_id.to_string(), tag.clone(), now.clone()),
        )
        .await
        .map_err(db_err)?;
    }
    Ok(())
}

async fn enqueue_outbox(conn: &Connection, asset_id: &str) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO outbox (asset_id, queued_at) VALUES (?1, ?2) \
         ON CONFLICT(asset_id) DO UPDATE SET queued_at = excluded.queued_at",
        (asset_id.to_string(), now),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn count_outbox(conn: &Connection) -> AppResult<u32> {
    let mut rows = conn
        .query("SELECT COUNT(*) FROM outbox", ())
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(row) => Ok(row.get::<i64>(0).map_err(db_err)? as u32),
        None => Ok(0),
    }
}

async fn pending_outbox_ids(conn: &Connection) -> AppResult<Vec<String>> {
    let mut rows = conn
        .query("SELECT asset_id FROM outbox ORDER BY queued_at", ())
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(row.get::<String>(0).map_err(db_err)?);
    }
    Ok(out)
}

// ---------- public API (called from commands/db.rs) ----------

pub async fn asset_upsert(project_root: &Path, mut record: AssetRecord) -> AppResult<()> {
    let project_id = read_project_id(project_root)?;
    let conn = open_local(project_root).await?;
    let now = chrono::Utc::now().to_rfc3339();
    record.project_id = Some(project_id);
    record.updated_at = Some(now);
    record.deleted_at = None;
    upsert_asset_row(&conn, &record).await?;
    enqueue_outbox(&conn, &record.id).await?;
    Ok(())
}

/// Push a cost that just became available onto an already-indexed asset —
/// the counterpart to `asset_upsert` for `cost.rs`'s backfill pass: a model
/// with no per-item price at generation time gets one once `Settings ->
/// fetch prices` has run and `project_cost_scan` recomputes it, and that
/// value should land in the DB the moment it's known, not wait for the next
/// reconcile. No-op (not an error) if the asset isn't indexed yet — nothing
/// to update, and reconcile will pick the cost up fresh from the sidecar
/// whenever it does get indexed.
pub async fn asset_cost_update(
    project_root: &Path,
    asset_id: &str,
    cost_usd: f64,
) -> AppResult<()> {
    let conn = open_local(project_root).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE assets SET cost_usd = ?1, updated_at = ?2 WHERE id = ?3",
            params!(cost_usd, now, asset_id.to_string()),
        )
        .await
        .map_err(db_err)?;
    if changed > 0 {
        enqueue_outbox(&conn, asset_id).await?;
    }
    Ok(())
}

async fn update_rel_path(conn: &Connection, asset_id: &str, new_rel_path: &str) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE assets SET rel_path = ?1, updated_at = ?2, deleted_at = NULL WHERE id = ?3",
        params!(new_rel_path.to_string(), now, asset_id.to_string()),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Relink an already-indexed asset to its new location the moment a move
/// command (image.rs) knows about it — the counterpart to `asset_cost_update`
/// for path changes, so a moved file resolves again immediately instead of
/// waiting for the next `project_reconcile` pass. No-op if the asset isn't
/// indexed yet or is already at `new_rel_path`.
pub async fn asset_relink(
    project_root: &Path,
    asset_id: &str,
    new_rel_path: &str,
) -> AppResult<()> {
    let conn = open_local(project_root).await?;
    match select_asset_by(&conn, "id", asset_id).await? {
        Some(existing) if existing.rel_path != new_rel_path => {
            update_rel_path(&conn, asset_id, new_rel_path).await?;
            enqueue_outbox(&conn, asset_id).await?;
        }
        _ => {}
    }
    Ok(())
}

/// Rewrite the `rel_path` prefix of every asset under a renamed sequence/shot
/// folder — the DB counterpart to `visible_set_rename_prefix`/
/// `rewrite_path_strings_in_subtree` (rename.rs). A folder rename is one
/// filesystem move, but `rel_path` is stored per-asset, so without this every
/// asset under the renamed subtree goes stale in the index until the next
/// `project_reconcile`. Matches entries equal to `old_prefix` or starting
/// with `old_prefix + "/"`, same boundary rule as the sidecar cascade. Full
/// scan is fine here — this is the local, already project-scoped index file,
/// not a shared table. Returns the number of rows updated.
pub async fn asset_rename_prefix(
    project_root: &Path,
    old_rel_prefix: &str,
    new_rel_prefix: &str,
) -> AppResult<u32> {
    let old_clean = old_rel_prefix.trim_end_matches('/');
    let new_clean = new_rel_prefix.trim_end_matches('/');
    if old_clean == new_clean {
        return Ok(0);
    }
    let conn = open_local(project_root).await?;
    let mut rows = conn
        .query(
            "SELECT id, rel_path FROM assets WHERE deleted_at IS NULL",
            (),
        )
        .await
        .map_err(db_err)?;
    let prefix = format!("{old_clean}/");
    let mut matches: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let id = row.get::<String>(0).map_err(db_err)?;
        let rel_path = row.get::<String>(1).map_err(db_err)?;
        if rel_path == old_clean || rel_path.starts_with(&prefix) {
            matches.push((id, rel_path));
        }
    }
    let mut updated = 0u32;
    for (id, rel_path) in matches {
        let new_rel_path = if rel_path == old_clean {
            new_clean.to_string()
        } else {
            format!("{new_clean}{}", &rel_path[old_clean.len()..])
        };
        update_rel_path(&conn, &id, &new_rel_path).await?;
        enqueue_outbox(&conn, &id).await?;
        updated += 1;
    }
    Ok(updated)
}

pub async fn asset_lookup(
    project_root: &Path,
    asset_id: Option<String>,
    content_hash: Option<String>,
) -> AppResult<Option<AssetRecord>> {
    let conn = open_local(project_root).await?;
    if let Some(id) = asset_id.filter(|s| !s.is_empty()) {
        if let Some(row) = select_asset_by(&conn, "id", &id).await? {
            return Ok(Some(row));
        }
    }
    if let Some(hash) = content_hash.filter(|s| !s.is_empty()) {
        if let Some(row) = select_asset_by(&conn, "content_hash", &hash).await? {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

pub async fn asset_refs_set(
    project_root: &Path,
    asset_id: &str,
    refs: &[AssetRefRecord],
) -> AppResult<()> {
    let conn = open_local(project_root).await?;
    replace_ref_rows(&conn, asset_id, refs).await?;
    enqueue_outbox(&conn, asset_id).await?;
    Ok(())
}

pub async fn asset_refs_get(project_root: &Path, asset_id: &str) -> AppResult<Vec<AssetRefRecord>> {
    let conn = open_local(project_root).await?;
    select_refs(&conn, asset_id).await
}

// ---------- tags ----------

/// What the index knows about the assets under one rel-path prefix.
/// `indexed` lists *every* asset under the prefix, tagged or not, so a
/// caller can tell "this file has no tags" from "this file was never
/// indexed" and only fall back to reading a sidecar in the second case.
#[derive(Debug, Default, Clone)]
pub struct TagIndex {
    pub by_rel: HashMap<String, Vec<String>>,
    pub indexed: HashSet<String>,
}

impl TagIndex {
    pub fn tags_for(&self, rel: &str) -> Vec<String> {
        self.by_rel.get(rel).cloned().unwrap_or_default()
    }

    pub fn is_indexed(&self, rel: &str) -> bool {
        self.indexed.contains(rel)
    }
}

/// One asset's worth of tag work: replace its tag rows, ingesting the
/// `assets` row they hang off first if there isn't one yet. `record` is a
/// fallback for that first-sight case only — it never overwrites a live row,
/// since a sidecar-derived record can be thinner than what reconcile and the
/// generation path have already put in the index.
pub struct TagUpdate {
    pub asset_id: String,
    pub record: Option<AssetRecord>,
    pub tags: Vec<String>,
}

fn under_prefix(rel: &str, prefix: &str) -> bool {
    prefix.is_empty() || rel == prefix || rel.starts_with(&format!("{prefix}/"))
}

/// The whole project's tag index in one query. Project-wide rather than
/// scoped to the directory being scanned because a shot's gallery also shows
/// the project-level GLOBAL SRC column, and anything outside the scope would
/// fall through to a per-file sidecar read.
pub async fn tags_all(project_root: &Path) -> AppResult<TagIndex> {
    let conn = open_local(project_root).await?;
    let mut rows = conn
        .query(
            "SELECT a.rel_path, t.tag FROM assets a \
             LEFT JOIN asset_tags t ON t.asset_id = a.id \
             WHERE a.deleted_at IS NULL",
            (),
        )
        .await
        .map_err(db_err)?;
    let mut idx = TagIndex::default();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let rel = row.get::<String>(0).map_err(db_err)?;
        let tag = opt_string(&row, 1)?;
        idx.indexed.insert(rel.clone());
        if let Some(tag) = tag {
            idx.by_rel.entry(rel).or_default().push(tag);
        }
    }
    for tags in idx.by_rel.values_mut() {
        tags.sort();
    }
    Ok(idx)
}

/// Apply a batch of tag replacements on one connection. Used for a single
/// tag edit, and for the bulk paths (migration, reindex) where reopening the
/// database per asset would dominate the cost.
pub async fn asset_tags_apply(project_root: &Path, updates: &[TagUpdate]) -> AppResult<u32> {
    if updates.is_empty() {
        return Ok(0);
    }
    let project_id = read_project_id(project_root)?;
    let conn = open_local(project_root).await?;
    let mut applied = 0u32;
    for update in updates {
        let known = select_asset_by(&conn, "id", &update.asset_id)
            .await?
            .is_some();
        if let (false, Some(record)) = (known, &update.record) {
            let mut record = record.clone();
            record.project_id = Some(project_id.clone());
            record.updated_at = Some(chrono::Utc::now().to_rfc3339());
            record.deleted_at = None;
            upsert_asset_row(&conn, &record).await?;
        }
        replace_tag_rows(&conn, &update.asset_id, &update.tags).await?;
        enqueue_outbox(&conn, &update.asset_id).await?;
        applied += 1;
    }
    Ok(applied)
}

/// Drop the index rows for a deleted file (or everything under a deleted
/// directory). A hard delete rather than a `deleted_at` stamp: the index is
/// rebuildable from disk, and the tag views query it directly, so a
/// tombstone would just be a ghost with tags. Returns the rows removed.
pub async fn assets_purge(project_root: &Path, rel: &str, is_prefix: bool) -> AppResult<u32> {
    let conn = open_local(project_root).await?;
    let clean = rel.trim_end_matches('/');
    let mut rows = conn
        .query("SELECT id, rel_path FROM assets", ())
        .await
        .map_err(db_err)?;
    let mut ids: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let id = row.get::<String>(0).map_err(db_err)?;
        let rel_path = row.get::<String>(1).map_err(db_err)?;
        let hit = if is_prefix {
            under_prefix(&rel_path, clean)
        } else {
            rel_path == clean
        };
        if hit {
            ids.push(id);
        }
    }
    for id in &ids {
        for sql in [
            "DELETE FROM asset_tags WHERE asset_id = ?1",
            "DELETE FROM asset_refs WHERE asset_id = ?1",
            "DELETE FROM outbox WHERE asset_id = ?1",
            "DELETE FROM assets WHERE id = ?1",
        ] {
            conn.execute(sql, params!(id.clone()))
                .await
                .map_err(db_err)?;
        }
    }
    Ok(ids.len() as u32)
}

/// Push every outbox-queued asset (+ its refs) to Turso, if configured and
/// reachable. Never returns `Err` for "not configured" or "offline" — those
/// are reported in the `SyncReport` so a fire-and-forget frontend caller
/// doesn't need special-case error handling; `Err` is reserved for a
/// genuinely broken local index.
pub async fn sync_outbox(project_root: &Path) -> AppResult<SyncReport> {
    let local = open_local(project_root).await?;

    let Some((url, token)) = turso_config()? else {
        return Ok(SyncReport {
            configured: false,
            pending: count_outbox(&local).await?,
            ..Default::default()
        });
    };

    let remote = match open_remote(url, token).await {
        Ok(c) => c,
        Err(e) => {
            return Ok(SyncReport {
                configured: true,
                pending: count_outbox(&local).await?,
                error: Some(e.to_string()),
                ..Default::default()
            });
        }
    };

    let ids = pending_outbox_ids(&local).await?;
    let mut pushed = 0u32;
    for id in &ids {
        match push_one_asset(&local, &remote, id).await {
            Ok(()) => {
                local
                    .execute(
                        "DELETE FROM outbox WHERE asset_id = ?1",
                        params!(id.clone()),
                    )
                    .await
                    .map_err(db_err)?;
                pushed += 1;
            }
            Err(e) => {
                // Leave it queued — could be a transient network blip on this
                // one row; the next sync call retries it.
                tracing::warn!("turso sync: asset {id} failed: {e}");
            }
        }
    }

    Ok(SyncReport {
        configured: true,
        pushed,
        pending: count_outbox(&local).await?,
        error: None,
    })
}

async fn push_one_asset(local: &Connection, remote: &Connection, id: &str) -> AppResult<()> {
    let Some(record) = select_asset_by(local, "id", id).await? else {
        // Deleted locally before it ever synced — nothing to push.
        return Ok(());
    };
    upsert_asset_row(remote, &record).await?;
    let refs = select_refs(local, id).await?;
    replace_ref_rows(remote, id, &refs).await?;
    let tags = select_tags(local, id).await?;
    replace_tag_rows(remote, id, &tags).await?;
    Ok(())
}

// ---------- reconcile (scan + relink + legacy backfill) ----------

pub(crate) fn media_kind(path: &Path) -> &'static str {
    if is_image_ext(path) {
        "image"
    } else if is_video_ext(path) {
        "video"
    } else if is_model3d_ext(path) {
        "model3d"
    } else {
        "other"
    }
}

pub async fn project_reconcile(
    project_path: &Path,
    ffmpeg_path: &str,
) -> AppResult<ReconcileReport> {
    let project_id = read_project_id(project_path)?;
    let conn = open_local(project_path).await?;
    let mut report = ReconcileReport::default();

    // Sequences sit under the entity roots in a PRISM project (both trees are
    // walked), and each shot's media is one hop further down in `Renders/AI` —
    // walking the project folder directly would only find pipeline dirs.
    let prism = prism::detect(project_path);
    let seq_parents: Vec<PathBuf> = match &prism {
        Some(layout) => vec![
            layout.entity_root(Some("shot")),
            layout.entity_root(Some("asset")),
        ],
        None => vec![project_path.to_path_buf()],
    };
    let mut seq_dirs: Vec<PathBuf> = Vec::new();
    for parent in &seq_parents {
        if parent.is_dir() {
            seq_dirs.extend(list_dirs(parent)?);
        }
    }

    for seq_dir in seq_dirs {
        let seq_name = match seq_dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if seq_name == SRC_DIR {
            continue;
        }
        let entity_dirs = match &prism {
            Some(layout) => prism::entities_in(layout, &seq_dir)?,
            None => list_dirs(&seq_dir)?,
        };
        for entity_dir in entity_dirs {
            let shot_name = match entity_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if shot_name == SRC_DIR || shot_name == SEL_DIR {
                continue;
            }
            let shot_dir = match &prism {
                Some(_) => prism::media_root_for(&entity_dir),
                None => entity_dir,
            };
            if !shot_dir.is_dir() {
                continue;
            }
            reconcile_shot(
                &conn,
                project_path,
                &project_id,
                &shot_dir,
                ffmpeg_path,
                &mut report,
            )
            .await?;
        }
    }
    Ok(report)
}

/// Walk one shot's version folders (mirrors `cost.rs::scan_shot_cost`'s
/// traversal — every subdirectory, since version-folder naming is
/// project-configurable and not worth re-validating here).
async fn reconcile_shot(
    conn: &Connection,
    project_root: &Path,
    project_id: &str,
    shot_dir: &Path,
    ffmpeg_path: &str,
    report: &mut ReconcileReport,
) -> AppResult<()> {
    for entry in std::fs::read_dir(shot_dir)? {
        let entry = entry?;
        let version_dir = entry.path();
        if !version_dir.is_dir() {
            continue;
        }
        let name = match version_dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name == SRC_DIR || name == SEL_DIR {
            continue;
        }
        for file_entry in std::fs::read_dir(&version_dir)? {
            let file_entry = file_entry?;
            let media_path = file_entry.path();
            if !media_path.is_file() {
                continue;
            }
            if !is_image_ext(&media_path)
                && !is_video_ext(&media_path)
                && !is_model3d_ext(&media_path)
            {
                continue;
            }
            report.scanned += 1;
            reconcile_one_file(
                conn,
                project_root,
                project_id,
                &media_path,
                ffmpeg_path,
                report,
            )
            .await?;
        }
    }
    Ok(())
}

async fn reconcile_one_file(
    conn: &Connection,
    project_root: &Path,
    project_id: &str,
    media_path: &Path,
    ffmpeg_path: &str,
    report: &mut ReconcileReport,
) -> AppResult<()> {
    let sidecar_path = media_path.with_extension("json");
    if !sidecar_path.is_file() {
        return Ok(());
    }
    let mut meta: serde_json::Value = read_json_or_default(&sidecar_path)?;
    let Some(obj) = meta.as_object().cloned() else {
        return Ok(());
    };

    let mut asset_id = obj
        .get("assetId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let is_legacy = asset_id.is_none();

    if is_legacy {
        let new_id = uuid::Uuid::new_v4().to_string();
        // Best-effort — a failed embed still gets an id + hash from here on.
        let _ = media_id_embed_impl(media_path, &new_id, project_id, ffmpeg_path);
        asset_id = Some(new_id);
    }
    let id = asset_id.expect("set above");

    let hash = file_hash_impl(media_path)?;
    let hash_changed = obj.get("contentHash").and_then(|v| v.as_str()) != Some(hash.as_str());
    if is_legacy || hash_changed {
        if let Some(map) = meta.as_object_mut() {
            map.insert("assetId".into(), serde_json::json!(id));
            map.insert("contentHash".into(), serde_json::json!(hash));
        }
        write_json_atomic(&sidecar_path, &meta)?;
    }
    if is_legacy {
        report.sidecar_backfilled += 1;
    }

    let rel_path = relativize(media_path, project_root).unwrap_or_else(|| as_str(media_path));

    match select_asset_by(conn, "id", &id).await? {
        Some(existing) if existing.rel_path != rel_path => {
            update_rel_path(conn, &id, &rel_path).await?;
            enqueue_outbox(conn, &id).await?;
            report.relinked += 1;
        }
        // Already indexed at the right path — location is in sync. Content
        // still might not be; tags are re-checked against the sidecar below.
        Some(_) => {}
        None => {
            let now = chrono::Utc::now().to_rfc3339();
            let record = AssetRecord {
                id: id.clone(),
                project_id: Some(project_id.to_string()),
                rel_path,
                content_hash: Some(hash),
                kind: media_kind(media_path).to_string(),
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
            };
            upsert_asset_row(conn, &record).await?;
            enqueue_outbox(conn, &id).await?;
            report.db_ingested += 1;
        }
    }

    // Sidecar is the source of truth for tags — pull it back over the index
    // whenever the two have drifted.
    let sidecar_tags = tags_from_sidecar(&obj);
    let mut indexed_tags = select_tags(conn, &id).await?;
    let mut wanted = sidecar_tags.clone();
    wanted.sort();
    indexed_tags.sort();
    if wanted != indexed_tags {
        replace_tag_rows(conn, &id, &sidecar_tags).await?;
        enqueue_outbox(conn, &id).await?;
        report.tags_synced += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway project rooted under the OS temp dir, with a real
    /// project.json (so `read_project_id` and the local-db-path derivation
    /// behave exactly as they would for a real project). The local index
    /// file this creates under %APPDATA%/aiSLAP/db/ is unique per test run
    /// (random uuid) and removed by `cleanup`.
    fn test_project() -> (PathBuf, String) {
        let project_id = format!("test-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(&project_id);
        fs::create_dir_all(&root).unwrap();
        let sidecar = ProjectSidecar {
            project_id: project_id.clone(),
            ..Default::default()
        };
        write_json_atomic(&root.join(PROJECT_SIDECAR), &sidecar).unwrap();
        (root, project_id)
    }

    fn cleanup(root: &Path, project_id: &str) {
        let _ = fs::remove_dir_all(root);
        if let Ok(dir) = appdata_dir() {
            let _ = fs::remove_file(dir.join("db").join(format!("{project_id}.db")));
        }
    }

    fn asset(id: &str, rel_path: &str) -> AssetRecord {
        AssetRecord {
            id: id.to_string(),
            rel_path: rel_path.to_string(),
            kind: "image".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn asset_upsert_and_lookup_roundtrip() {
        let (root, project_id) = test_project();
        let mut record = asset("asset-1", "seq1/shot1/gen001/img1.png");
        record.content_hash = Some("hash-1".to_string());
        asset_upsert(&root, record.clone()).await.unwrap();

        let by_id = asset_lookup(&root, Some("asset-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_id.rel_path, record.rel_path);
        assert_eq!(by_id.project_id.as_deref(), Some(project_id.as_str()));

        let by_hash = asset_lookup(&root, None, Some("hash-1".to_string()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_hash.id, "asset-1");

        let missing = asset_lookup(&root, Some("nope".to_string()), None)
            .await
            .unwrap();
        assert!(missing.is_none());

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn asset_relink_updates_rel_path_and_no_ops_on_missing() {
        let (root, project_id) = test_project();
        asset_upsert(&root, asset("asset-relink-1", "seq1/shot1/gen001/img.png"))
            .await
            .unwrap();

        asset_relink(&root, "asset-relink-1", "seq1/shot1/gen002/img.png")
            .await
            .unwrap();
        let row = asset_lookup(&root, Some("asset-relink-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.rel_path, "seq1/shot1/gen002/img.png");

        // No row for this id — a no-op, not an error (a move on a file that
        // was never indexed, e.g. pre-Phase-1, self-heals on the next
        // reconcile instead).
        asset_relink(&root, "no-such-asset", "wherever.png")
            .await
            .unwrap();
        let still_missing = asset_lookup(&root, Some("no-such-asset".to_string()), None)
            .await
            .unwrap();
        assert!(still_missing.is_none());

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn asset_rename_prefix_rewrites_matching_rel_paths_only() {
        let (root, project_id) = test_project();
        // Under the renamed shot.
        asset_upsert(&root, asset("asset-in-1", "seq1/shot1/gen001/a.png"))
            .await
            .unwrap();
        asset_upsert(&root, asset("asset-in-2", "seq1/shot1/gen002/b.png"))
            .await
            .unwrap();
        // A sibling shot whose name merely starts with the same characters —
        // must not be touched (exact `/` boundary, not a raw string prefix).
        asset_upsert(&root, asset("asset-sibling", "seq1/shot10/gen001/c.png"))
            .await
            .unwrap();
        // Unrelated asset elsewhere in the project.
        asset_upsert(&root, asset("asset-other", "seq2/shotX/gen001/d.png"))
            .await
            .unwrap();

        let updated = asset_rename_prefix(&root, "seq1/shot1", "seq1/shot1-renamed")
            .await
            .unwrap();
        assert_eq!(updated, 2);

        let in1 = asset_lookup(&root, Some("asset-in-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(in1.rel_path, "seq1/shot1-renamed/gen001/a.png");
        let in2 = asset_lookup(&root, Some("asset-in-2".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(in2.rel_path, "seq1/shot1-renamed/gen002/b.png");

        let sibling = asset_lookup(&root, Some("asset-sibling".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sibling.rel_path, "seq1/shot10/gen001/c.png");
        let other = asset_lookup(&root, Some("asset-other".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other.rel_path, "seq2/shotX/gen001/d.png");

        // Re-running with old == new prefix is a no-op.
        let noop = asset_rename_prefix(&root, "seq1/shot1-renamed", "seq1/shot1-renamed")
            .await
            .unwrap();
        assert_eq!(noop, 0);

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn asset_cost_update_sets_cost_on_existing_row_and_no_ops_on_missing() {
        let (root, project_id) = test_project();
        asset_upsert(&root, asset("asset-cost-1", "seq1/shot1/gen001/img.png"))
            .await
            .unwrap();

        asset_cost_update(&root, "asset-cost-1", 0.0123)
            .await
            .unwrap();
        let row = asset_lookup(&root, Some("asset-cost-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.cost_usd, Some(0.0123));

        // No row for this id yet — a no-op, not an error (mirrors cost.rs's
        // backfill running before the asset has ever been indexed).
        asset_cost_update(&root, "no-such-asset", 1.0)
            .await
            .unwrap();
        let still_missing = asset_lookup(&root, Some("no-such-asset".to_string()), None)
            .await
            .unwrap();
        assert!(still_missing.is_none());

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn asset_refs_roundtrip() {
        let (root, project_id) = test_project();
        asset_upsert(&root, asset("asset-2", "seq1/shot1/gen001/img2.png"))
            .await
            .unwrap();

        let refs = vec![AssetRefRecord {
            ordinal: 0,
            ref_asset_id: Some("asset-1".to_string()),
            ref_rel_path: Some("seq1/shot1/gen001/img1.png".to_string()),
            ref_hash: None,
            role_json: Some("{\"kind\":\"start\"}".to_string()),
        }];
        asset_refs_set(&root, "asset-2", &refs).await.unwrap();
        let fetched = asset_refs_get(&root, "asset-2").await.unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].ref_asset_id.as_deref(), Some("asset-1"));

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn sync_outbox_reports_not_configured_when_unset() {
        let (root, project_id) = test_project();
        asset_upsert(&root, asset("asset-3", "x.png"))
            .await
            .unwrap();
        // This dev machine has no TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set —
        // exercises the "local-only, nothing configured" branch.
        let report = sync_outbox(&root).await.unwrap();
        assert!(!report.configured);
        assert_eq!(report.pending, 1);
        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn reconcile_backfills_legacy_ingests_and_relinks() {
        let (root, project_id) = test_project();
        let shot = root.join("seq1").join("shot1");
        let v1 = shot.join("gen001");
        fs::create_dir_all(&v1).unwrap();

        // Legacy file: sidecar with no assetId (pre-Phase-1 output).
        let legacy_media = v1.join("legacy.png");
        fs::write(
            &legacy_media,
            b"not a real png; embed is allowed to fail here",
        )
        .unwrap();
        write_json_atomic(
            &legacy_media.with_extension("json"),
            &serde_json::json!({
                "model": "Test Model", "modelId": "m1", "endpoint": "e1",
                "settings": {}, "refs": [],
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .unwrap();

        // Already-migrated file: sidecar already carries assetId + contentHash.
        let migrated_media = v1.join("migrated.png");
        fs::write(&migrated_media, b"also fake").unwrap();
        let real_hash = file_hash_impl(&migrated_media).unwrap();
        write_json_atomic(
            &migrated_media.with_extension("json"),
            &serde_json::json!({
                "model": "Test Model", "modelId": "m1", "endpoint": "e1",
                "settings": {}, "refs": [],
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "assetId": "already-migrated-1", "contentHash": real_hash,
            }),
        )
        .unwrap();

        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.scanned, 2);
        assert_eq!(report.sidecar_backfilled, 1);
        assert_eq!(report.db_ingested, 2);
        assert_eq!(report.relinked, 0);

        // Re-run: fully idempotent, nothing left to do.
        let report2 = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report2.scanned, 2);
        assert_eq!(report2.sidecar_backfilled, 0);
        assert_eq!(report2.db_ingested, 0);
        assert_eq!(report2.relinked, 0);

        // Move the migrated file to a new version folder — should relink,
        // not re-ingest as a brand new asset.
        let v2 = shot.join("gen002");
        fs::create_dir_all(&v2).unwrap();
        let moved_media = v2.join("migrated.png");
        fs::rename(&migrated_media, &moved_media).unwrap();
        fs::rename(
            migrated_media.with_extension("json"),
            moved_media.with_extension("json"),
        )
        .unwrap();

        let report3 = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report3.scanned, 2);
        assert_eq!(report3.relinked, 1);
        assert_eq!(report3.db_ingested, 0);

        let relinked_row = asset_lookup(&root, Some("already-migrated-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert!(relinked_row.rel_path.contains("gen002"));

        cleanup(&root, &project_id);
    }

    fn tag_update(id: &str, rel_path: &str, tags: &[&str]) -> TagUpdate {
        TagUpdate {
            asset_id: id.to_string(),
            record: Some(asset(id, rel_path)),
            tags: tags.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn tags_apply_replaces_and_indexes_unknown_assets() {
        let (root, project_id) = test_project();

        // The asset isn't in the index yet — the record on the update is the
        // fallback that gets it there.
        asset_tags_apply(
            &root,
            &[tag_update(
                "tag-a",
                "seq1/shot1/gen001/a.png",
                &["fav", "hero"],
            )],
        )
        .await
        .unwrap();

        let idx = tags_all(&root).await.unwrap();
        assert_eq!(
            idx.tags_for("seq1/shot1/gen001/a.png"),
            vec!["fav".to_string(), "hero".to_string()]
        );
        assert!(idx.is_indexed("seq1/shot1/gen001/a.png"));

        // Replace, not merge.
        asset_tags_apply(
            &root,
            &[tag_update("tag-a", "seq1/shot1/gen001/a.png", &["hero"])],
        )
        .await
        .unwrap();
        let idx = tags_all(&root).await.unwrap();
        assert_eq!(
            idx.tags_for("seq1/shot1/gen001/a.png"),
            vec!["hero".to_string()]
        );

        // An untagged-but-indexed asset is "indexed" with no tags — that's
        // what tells a gallery scan not to fall back to the sidecar.
        asset_upsert(&root, asset("tag-b", "seq1/shot1/gen001/b.png"))
            .await
            .unwrap();
        let idx = tags_all(&root).await.unwrap();
        assert!(idx.is_indexed("seq1/shot1/gen001/b.png"));
        assert!(idx.tags_for("seq1/shot1/gen001/b.png").is_empty());
        assert!(!idx.is_indexed("seq1/shot1/gen001/never-seen.png"));

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn purge_drops_a_deleted_file_and_a_deleted_directory() {
        let (root, project_id) = test_project();
        asset_tags_apply(
            &root,
            &[
                tag_update("purge-1", "seq1/shot1/gen001/a.png", &["fav"]),
                tag_update("purge-2", "seq1/shot1/gen002/b.png", &["fav"]),
                tag_update("purge-3", "seq1/shot2/gen001/c.png", &["fav"]),
            ],
        )
        .await
        .unwrap();

        assert_eq!(
            assets_purge(&root, "seq1/shot1/gen001/a.png", false)
                .await
                .unwrap(),
            1
        );
        // A prefix must stop at a path boundary: shot1 must not take shot10
        // (or, here, shot2) with it.
        assert_eq!(assets_purge(&root, "seq1/shot1", true).await.unwrap(), 1);

        let idx = tags_all(&root).await.unwrap();
        assert!(!idx.is_indexed("seq1/shot1/gen001/a.png"));
        assert!(!idx.is_indexed("seq1/shot1/gen002/b.png"));
        assert_eq!(
            idx.tags_for("seq1/shot2/gen001/c.png"),
            vec!["fav".to_string()]
        );

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn reconcile_pulls_sidecar_tags_back_over_a_wiped_index() {
        let (root, project_id) = test_project();
        let v1 = root.join("seq1").join("shot1").join("gen001");
        fs::create_dir_all(&v1).unwrap();
        let media = v1.join("tagged.png");
        fs::write(&media, b"fake").unwrap();
        write_json_atomic(
            &media.with_extension("json"),
            &serde_json::json!({
                "settings": {}, "refs": [],
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "assetId": "tagged-1", "contentHash": file_hash_impl(&media).unwrap(),
                "tags": ["fav", "hero"],
            }),
        )
        .unwrap();

        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.db_ingested, 1);
        assert_eq!(report.tags_synced, 1);
        let idx = tags_all(&root).await.unwrap();
        assert_eq!(
            idx.tags_for("seq1/shot1/gen001/tagged.png"),
            vec!["fav".to_string(), "hero".to_string()]
        );

        // Second pass has nothing to say — sidecar and index already agree.
        assert_eq!(project_reconcile(&root, "").await.unwrap().tags_synced, 0);

        // Blow the tag rows away (as a deleted index file would) and confirm
        // the sidecar is what puts them back.
        assets_purge(&root, "seq1/shot1/gen001/tagged.png", false)
            .await
            .unwrap();
        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.db_ingested, 1);
        assert_eq!(report.tags_synced, 1);
        let idx = tags_all(&root).await.unwrap();
        assert_eq!(
            idx.tags_for("seq1/shot1/gen001/tagged.png"),
            vec!["fav".to_string(), "hero".to_string()]
        );

        cleanup(&root, &project_id);
    }
}
