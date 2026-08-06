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
use std::sync::{Arc, Mutex, OnceLock};

use libsql::{params, Builder, Connection, Database, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::config::turso_config;
use crate::commands::fsutil::{
    as_str, is_image_ext, is_model3d_ext, is_video_ext, sidecar_path, ProjectRoot, PROJECT_SIDECAR,
};
use crate::commands::media_id::{file_hash_impl, media_id_embed_impl, media_id_read_impl};
use crate::commands::session::project_title_for;
use crate::commands::tags::tags_from_sidecar;
use crate::commands::walk;
use crate::domain::ProjectSidecar;
use crate::error::{run_blocking, AppError, AppResult};
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
        deleted_at TEXT,
        generated_by TEXT
    )",
    // Composite, leading with project_id — correct for the remote database,
    // which genuinely holds many projects. See SCHEMA_LOCAL for why the local
    // file needs a different shape.
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
    // Human-readable project name, keyed by the same project id every asset
    // row carries — the join the remote db's cross-project reports were
    // otherwise missing. One row per project; refreshed opportunistically by
    // `sync_outbox` rather than queued through `outbox`, since `outbox` is
    // keyed by asset id and a title change has no asset to hang off.
    "CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )",
];

/// Local-only indexes.
///
/// The local database file is *per project* — `local_db_path` keys it by
/// project id — so `project_id` is a constant column here, and a composite
/// index leading with it cannot serve the queries this module actually issues.
/// `asset_lookup` by hash asks `WHERE content_hash = ?` with no `project_id`
/// predicate, so SQLite could not use `idx_assets_content_hash` at all and fell
/// back to a full table scan on every lookup.
///
/// New index *names* are required: `CREATE INDEX IF NOT EXISTS` will not
/// redefine an index that already exists, so reusing the old names would leave
/// every existing `.db` file on the broken definition.
const SCHEMA_LOCAL: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_assets_hash_local ON assets(content_hash)",
    "CREATE INDEX IF NOT EXISTS idx_assets_rel_path_local ON assets(rel_path)",
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
    /// OS/system username that generated this asset (via `whoami`), captured
    /// at write time — the join key for a future central-db "who generated
    /// what, for how much" query. Absent on rows written before this field
    /// existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_by: Option<String>,
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
    /// Files whose sidecar had lost its `assetId`, but which still carried one
    /// embedded in the media itself — reused rather than replaced, so the
    /// existing index row and its tags survive.
    pub identity_recovered: u32,
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

/// Adopt an index written under the path-hash fallback once the project id
/// lands.
///
/// The frontend mints the id fire-and-forget while simultaneously kicking
/// `db_sync_outbox` and `project_reconcile`, so on a project's very first open
/// those two can win the race and write a complete index into
/// `path-<hash>.db`. Once the id is persisted every later call resolves to
/// `<id>.db` — and all of that work is stranded in a file nothing will open
/// again, which reads to the user as reconcile simply not having run.
///
/// Renaming it into place is safe precisely because the fallback key is derived
/// from the same project path: the two names can only ever refer to the same
/// project. Best-effort throughout — if the id file already exists there is
/// nothing to adopt, and on Windows the source may still be held open by
/// another window, in which case the next open retries.
fn adopt_path_keyed_db(dir: &Path, project_root: &Path, project_id: &str, target: &Path) {
    if project_id.is_empty() || target.exists() {
        return;
    }
    let fallback = dir.join(format!("{}.db", {
        let mut hasher = Sha256::new();
        hasher.update(as_str(project_root).as_bytes());
        format!("path-{:x}", hasher.finalize())
    }));
    if !fallback.is_file() {
        return;
    }
    match std::fs::rename(&fallback, target) {
        Ok(()) => tracing::info!(
            "adopted path-keyed index {} as {}",
            fallback.display(),
            target.display()
        ),
        Err(e) => tracing::warn!("could not adopt {}: {e}", fallback.display()),
    }
}

fn local_db_path(project_root: &Path, project_id: &str) -> AppResult<PathBuf> {
    let dir = appdata_dir()?.join("db");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.db", local_db_key(project_root, project_id)));
    adopt_path_keyed_db(&dir, project_root, project_id, &path);
    Ok(path)
}

async fn bootstrap(conn: &Connection, extra: &[&str]) -> AppResult<()> {
    for stmt in SCHEMA.iter().chain(extra) {
        conn.execute(stmt, ()).await.map_err(db_err)?;
    }
    Ok(())
}

/// Opened `Database` handles, keyed by the index file they point at.
///
/// Building a `Database` runs `create_dir_all`, opens the file, and replays all
/// ten `CREATE TABLE`/`CREATE INDEX` statements. Doing that per call turned
/// batch work into an N+1 — the cost scan opened, bootstrapped and closed the
/// database once *per backfilled asset*.
///
/// Deliberately caching the `Database` rather than a `Connection`:
/// `Database::connect` is just a handle, so each caller still gets its own
/// connection. That keeps transactions independent — two callers sharing one
/// connection would collide on `BEGIN` — with no lock held across an `.await`.
///
/// Keyed by resolved path, not by project root, so the first-open id mint
/// (which changes which file a project resolves to) can't be served a stale
/// handle.
/// Best-effort column add for a table that predates this column. Checked via
/// `PRAGMA table_info` rather than a blind `ALTER TABLE ... ADD COLUMN` plus
/// swallow-the-duplicate-column-error: `open_remote` reopens and re-runs its
/// setup on *every* `sync_outbox` call — i.e. after every single asset write
/// — so a blind attempt would warn on every generation forever once the
/// column exists, instead of once, here. The genuinely-unexpected-failure
/// case (not "duplicate column") still warns exactly the same as before.
async fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> AppResult<()> {
    let mut rows = conn
        .query(&format!("PRAGMA table_info({table})"), ())
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        if row.get::<String>(1).map_err(db_err)? == column {
            return Ok(());
        }
    }
    if let Err(e) = conn.execute(ddl, ()).await {
        tracing::warn!("{ddl} failed: {e}");
    }
    Ok(())
}

static LOCAL_DBS: OnceLock<Mutex<HashMap<PathBuf, Arc<Database>>>> = OnceLock::new();

async fn local_db(path: &Path) -> AppResult<Arc<Database>> {
    let cache = LOCAL_DBS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(db) = cache.lock().expect("db cache poisoned").get(path) {
        return Ok(db.clone());
    }

    let db = Arc::new(Builder::new_local(path).build().await.map_err(db_err)?);
    {
        let conn = db.connect().map_err(db_err)?;
        bootstrap(&conn, SCHEMA_LOCAL).await?;
        // WAL was pointless while the handle was discarded every call; with a
        // cached one it lets a reader and a writer coexist. `busy_timeout`
        // matters because two aiSLAP windows share this file, and the real
        // transactions below would otherwise surface SQLITE_BUSY where the old
        // per-row autocommits mostly got away with it.
        for pragma in [
            "PRAGMA journal_mode=WAL",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA busy_timeout=5000",
        ] {
            // `execute` rejects a statement that returns rows, and
            // journal_mode/busy_timeout both hand back the value they were set
            // to — `query` is the one that actually applies them.
            let result = match conn.query(pragma, ()).await {
                Ok(mut rows) => rows.next().await.map(|_| ()),
                Err(e) => Err(e),
            };
            if let Err(e) = result {
                tracing::warn!("{pragma} failed: {e}");
            }
        }
        ensure_column(
            &conn,
            "assets",
            "generated_by",
            "ALTER TABLE assets ADD COLUMN generated_by TEXT",
        )
        .await?;
        // Not in SCHEMA: on a legacy db this index would be created before the
        // column-add above ever ran, and `CREATE INDEX ... (generated_by)`
        // against a table that doesn't have it yet fails outright.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_assets_generated_by ON assets(project_id, generated_by)",
            (),
        )
        .await
        .map_err(db_err)?;
    }

    // A concurrent opener may have won; keep whichever landed first so every
    // caller shares one handle.
    let mut guard = cache.lock().expect("db cache poisoned");
    Ok(guard.entry(path.to_path_buf()).or_insert(db).clone())
}

/// Open (creating + bootstrapping on first use) the local index for a project.
async fn open_local(project_root: &Path) -> AppResult<Connection> {
    let project_id = read_project_id(project_root)?;
    let path = local_db_path(project_root, &project_id)?;
    let db = local_db(&path).await?;
    db.connect().map_err(db_err)
}

/// Drop a cached handle so the file underneath can be deleted. Tests only —
/// Windows refuses to remove a file that is still open.
#[cfg(test)]
pub(crate) fn evict_cached_db(path: &Path) {
    if let Some(cache) = LOCAL_DBS.get() {
        cache.lock().expect("db cache poisoned").remove(path);
    }
}

/// Cached by URL, same shape as `LOCAL_DBS`. `sync_outbox` calls `open_remote`
/// after every single asset write, and rebuilding the connection (a fresh TLS
/// handshake) plus replaying every `CREATE TABLE`/`CREATE INDEX`/`ensure_column`
/// statement over the network on each of those calls was previously masked —
/// local opens failed before ever reaching this point (see `generated_by`
/// migration ordering fix) — so it never ran in practice until now. A stale
/// entry from Turso credentials changed mid-session is a known gap, matching
/// `local_db`'s handling of a path's underlying file changing identity.
static REMOTE_DBS: OnceLock<Mutex<HashMap<String, Arc<Database>>>> = OnceLock::new();

async fn open_remote(url: String, token: String) -> AppResult<Connection> {
    let cache = REMOTE_DBS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(db) = cache.lock().expect("db cache poisoned").get(&url) {
        return db.connect().map_err(db_err);
    }

    let db = Arc::new(
        Builder::new_remote(url.clone(), token)
            .build()
            .await
            .map_err(db_err)?,
    );
    {
        let conn = db.connect().map_err(db_err)?;
        bootstrap(&conn, &[]).await?;
        ensure_column(
            &conn,
            "assets",
            "generated_by",
            "ALTER TABLE assets ADD COLUMN generated_by TEXT",
        )
        .await?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_assets_generated_by ON assets(project_id, generated_by)",
            (),
        )
        .await
        .map_err(db_err)?;
    }

    let mut guard = cache.lock().expect("db cache poisoned");
    let db = guard.entry(url).or_insert(db).clone();
    db.connect().map_err(db_err)
}

// ---------- row <-> struct ----------

fn opt_string(row: &Row, idx: i32) -> AppResult<Option<String>> {
    row.get::<Option<String>>(idx).map_err(db_err)
}

/// A macro rather than a `const` so it expands to a literal and can be spliced
/// into `concat!` below, which is what lets the SELECTs be constants.
macro_rules! asset_columns {
    () => {
        "id, project_id, rel_path, content_hash, kind, provider, model_id, \
         endpoint, combined_prompt, settings_json, cost_usd, created_at, updated_at, deleted_at, \
         generated_by"
    };
}

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
        generated_by: opt_string(row, 14)?,
    })
}

/// The two lookups, as constants rather than a `format!` per call — this used
/// to rebuild a 14-column SQL string on every invocation, inside reconcile's
/// per-file loop. Fixed text also lets the driver reuse the prepared statement.
const SELECT_ASSET_BY_ID: &str = concat!(
    "SELECT ",
    asset_columns!(),
    " FROM assets WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"
);
const SELECT_ASSET_BY_HASH: &str = concat!(
    "SELECT ",
    asset_columns!(),
    " FROM assets WHERE content_hash = ?1 AND deleted_at IS NULL LIMIT 1"
);

async fn select_asset_by_id(conn: &Connection, id: &str) -> AppResult<Option<AssetRecord>> {
    select_asset(conn, SELECT_ASSET_BY_ID, id).await
}

async fn select_asset_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<AssetRecord>> {
    select_asset(conn, SELECT_ASSET_BY_HASH, hash).await
}

async fn select_asset(conn: &Connection, sql: &str, value: &str) -> AppResult<Option<AssetRecord>> {
    let mut rows = conn
        .query(sql, params!(value.to_string()))
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
             endpoint, combined_prompt, settings_json, cost_usd, created_at, updated_at, deleted_at, \
             generated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14)
         ON CONFLICT(id) DO UPDATE SET
           project_id=excluded.project_id, rel_path=excluded.rel_path,
           content_hash=excluded.content_hash, kind=excluded.kind, provider=excluded.provider,
           model_id=excluded.model_id, endpoint=excluded.endpoint,
           combined_prompt=excluded.combined_prompt, settings_json=excluded.settings_json,
           cost_usd=excluded.cost_usd, updated_at=excluded.updated_at, deleted_at=NULL,
           generated_by=excluded.generated_by",
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
            record.updated_at.clone().unwrap_or_default(),
            record.generated_by.clone()
        ),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn upsert_project_row(
    conn: &Connection,
    project_id: &str,
    title: &str,
    updated_at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO projects (project_id, title, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_id) DO UPDATE SET
           title=excluded.title, updated_at=excluded.updated_at",
        params!(
            project_id.to_string(),
            title.to_string(),
            updated_at.to_string()
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

/// Relink already-indexed assets to their new locations the moment a move
/// command (image.rs) knows about them — the counterpart to `asset_costs_update`
/// for path changes, so a moved file resolves again immediately instead of
/// waiting for the next `project_reconcile` pass. Entries whose asset isn't
/// indexed yet, or is already at the given path, are skipped.
///
/// Batched because a version-stack move relinks every file in the folder at
/// once; one call per file meant one database open per file.
pub async fn assets_relink(project_root: &Path, moves: &[(String, String)]) -> AppResult<()> {
    if moves.is_empty() {
        return Ok(());
    }
    let conn = open_local(project_root).await?;
    let tx = conn.transaction().await.map_err(db_err)?;
    for (asset_id, new_rel_path) in moves {
        match select_asset_by_id(&tx, asset_id).await? {
            Some(existing) if existing.rel_path != *new_rel_path => {
                update_rel_path(&tx, asset_id, new_rel_path).await?;
                enqueue_outbox(&tx, asset_id).await?;
            }
            _ => {}
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

/// Batched cost backfill. The project cost scan produces one of these per
/// asset it repaired, which on a large project is thousands.
pub async fn assets_cost_update(project_root: &Path, costs: &[(String, f64)]) -> AppResult<()> {
    if costs.is_empty() {
        return Ok(());
    }
    let conn = open_local(project_root).await?;
    let tx = conn.transaction().await.map_err(db_err)?;
    let now = chrono::Utc::now().to_rfc3339();
    for (asset_id, cost_usd) in costs {
        let changed = tx
            .execute(
                "UPDATE assets SET cost_usd = ?1, updated_at = ?2 WHERE id = ?3",
                params!(*cost_usd, now.clone(), asset_id.clone()),
            )
            .await
            .map_err(db_err)?;
        if changed > 0 {
            enqueue_outbox(&tx, asset_id).await?;
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

/// Ingest freshly re-identified copies: the asset row and its tag rows, which
/// are keyed by the *copy's* new id rather than the source's.
pub async fn assets_ingest(
    project_root: &Path,
    new_assets: &[(AssetRecord, Vec<String>)],
) -> AppResult<()> {
    if new_assets.is_empty() {
        return Ok(());
    }
    let project_id = read_project_id(project_root)?;
    let conn = open_local(project_root).await?;
    let tx = conn.transaction().await.map_err(db_err)?;
    let now = chrono::Utc::now().to_rfc3339();
    for (record, tags) in new_assets {
        let mut record = record.clone();
        record.project_id = Some(project_id.clone());
        record.updated_at = Some(now.clone());
        record.deleted_at = None;
        upsert_asset_row(&tx, &record).await?;
        if !tags.is_empty() {
            replace_tag_rows(&tx, &record.id, tags).await?;
        }
        enqueue_outbox(&tx, &record.id).await?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

/// The half-open `rel_path` range covering `prefix` and everything beneath it.
///
/// `('/' as u8) + 1 == '0'`, so `["<p>/", "<p>0")` is exactly the set of paths
/// starting with `<p>/` — expressible as a range predicate, which an index on
/// `rel_path` can serve. The alternative (`LIKE 'p/%'`) cannot use an index once
/// the pattern contains an escape, and pulling every row to filter in Rust
/// cannot use one at all.
///
/// The exact match is separate because `<p>` itself sorts before `<p>/`.
fn prefix_range(clean_prefix: &str) -> (String, String) {
    (format!("{clean_prefix}/"), format!("{clean_prefix}0"))
}

/// Rewrite the `rel_path` prefix of every asset under a renamed sequence/shot
/// folder — the DB counterpart to `rewrite_path_strings_in_subtree` (rename.rs).
/// A folder rename is one filesystem move, but `rel_path` is stored per-asset,
/// so without this every asset under the renamed subtree goes stale in the index
/// until the next `project_reconcile`. Matches entries equal to `old_prefix` or
/// starting with `old_prefix + "/"`, the same boundary rule as the sidecar
/// cascade — so renaming `shot_1` never touches `shot_10`.
///
/// Returns the number of rows updated.
///
/// The `rel_path` match below carries no `project_id` predicate — safe only
/// because this always opens its own `open_local` connection (below) and
/// never accepts one from a caller. If this is ever refactored to take a
/// `Connection`/`Transaction` parameter, that parameter must never be one
/// from `open_remote`: the shared table has no such guarantee, and this
/// query would rewrite matching paths across every project on it.
pub async fn asset_rename_prefix(
    project_root: &Path,
    old_rel_prefix: &str,
    new_rel_prefix: &str,
) -> AppResult<u32> {
    let old_clean = old_rel_prefix.trim_end_matches('/').to_string();
    let new_clean = new_rel_prefix.trim_end_matches('/').to_string();
    if old_clean == new_clean {
        return Ok(0);
    }
    let conn = open_local(project_root).await?;
    let (lo, hi) = prefix_range(&old_clean);

    let mut rows = conn
        .query(
            "SELECT id, rel_path FROM assets \
             WHERE deleted_at IS NULL AND (rel_path = ?1 OR (rel_path >= ?2 AND rel_path < ?3))",
            params!(old_clean.clone(), lo, hi),
        )
        .await
        .map_err(db_err)?;
    let mut matches: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        matches.push((
            row.get::<String>(0).map_err(db_err)?,
            row.get::<String>(1).map_err(db_err)?,
        ));
    }

    // One transaction for the whole rename: a folder move is a single user
    // action, and a half-applied prefix rewrite leaves the index describing a
    // tree that never existed.
    let tx = conn.transaction().await.map_err(db_err)?;
    let mut updated = 0u32;
    for (id, rel_path) in matches {
        let new_rel_path = if rel_path == old_clean {
            new_clean.clone()
        } else {
            format!("{new_clean}{}", &rel_path[old_clean.len()..])
        };
        update_rel_path(&tx, &id, &new_rel_path).await?;
        enqueue_outbox(&tx, &id).await?;
        updated += 1;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(updated)
}

pub async fn asset_lookup(
    project_root: &Path,
    asset_id: Option<String>,
    content_hash: Option<String>,
) -> AppResult<Option<AssetRecord>> {
    let conn = open_local(project_root).await?;
    if let Some(id) = asset_id.filter(|s| !s.is_empty()) {
        if let Some(row) = select_asset_by_id(&conn, &id).await? {
            return Ok(Some(row));
        }
    }
    if let Some(hash) = content_hash.filter(|s| !s.is_empty()) {
        if let Some(row) = select_asset_by_hash(&conn, &hash).await? {
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
    // Delete-then-reinsert: without a transaction, a failure partway leaves the
    // asset with some of its references and no way to tell.
    let tx = conn.transaction().await.map_err(db_err)?;
    replace_ref_rows(&tx, asset_id, refs).await?;
    enqueue_outbox(&tx, asset_id).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

/// Read an asset's refs by project root. Production reads them through
/// `select_refs` on a connection it already holds (`push_one_asset`); this
/// stand-alone form existed only for a Tauri command the frontend never called,
/// and now just gives the roundtrip test a way in.
#[cfg(test)]
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
    // The bulk paths (migration, reindex, a project-wide tag rename) push
    // thousands of updates through here, each of which is a DELETE plus one
    // INSERT per tag. Without a transaction that is one autocommit — one fsync —
    // per statement.
    let tx = conn.transaction().await.map_err(db_err)?;
    let mut applied = 0u32;
    for update in updates {
        let known = select_asset_by_id(&tx, &update.asset_id).await?.is_some();
        if let (false, Some(record)) = (known, &update.record) {
            let mut record = record.clone();
            record.project_id = Some(project_id.clone());
            record.updated_at = Some(chrono::Utc::now().to_rfc3339());
            record.deleted_at = None;
            upsert_asset_row(&tx, &record).await?;
        }
        replace_tag_rows(&tx, &update.asset_id, &update.tags).await?;
        enqueue_outbox(&tx, &update.asset_id).await?;
        applied += 1;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(applied)
}

/// Drop the index rows for a deleted file (or everything under a deleted
/// directory). A hard delete rather than a `deleted_at` stamp: the index is
/// rebuildable from disk, and the tag views query it directly, so a
/// tombstone would just be a ghost with tags. Returns the rows removed.
///
/// Same caveat as `asset_rename_prefix`: the `rel_path` match has no
/// `project_id` predicate, safe only because `open_local` below is always
/// this project's own file. Never wire this to a `open_remote` connection
/// without adding one.
pub async fn assets_purge(project_root: &Path, rel: &str, is_prefix: bool) -> AppResult<u32> {
    let conn = open_local(project_root).await?;
    let clean = rel.trim_end_matches('/').to_string();

    // Selected in SQL rather than by pulling every row and filtering in Rust.
    // A prefix delete covers the folder itself plus everything under it.
    let mut rows = if is_prefix {
        let (lo, hi) = prefix_range(&clean);
        conn.query(
            "SELECT id FROM assets WHERE rel_path = ?1 OR (rel_path >= ?2 AND rel_path < ?3)",
            params!(clean.clone(), lo, hi),
        )
        .await
    } else {
        conn.query(
            "SELECT id FROM assets WHERE rel_path = ?1",
            params!(clean.clone()),
        )
        .await
    }
    .map_err(db_err)?;

    let mut ids: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        ids.push(row.get::<String>(0).map_err(db_err)?);
    }

    // Four deletes per id, so a folder delete was previously that many separate
    // autocommits. One transaction also means the asset row and its tag/ref/
    // outbox rows can never be left half-removed.
    let tx = conn.transaction().await.map_err(db_err)?;
    for id in &ids {
        for sql in [
            "DELETE FROM asset_tags WHERE asset_id = ?1",
            "DELETE FROM asset_refs WHERE asset_id = ?1",
            "DELETE FROM outbox WHERE asset_id = ?1",
            "DELETE FROM assets WHERE id = ?1",
        ] {
            tx.execute(sql, params!(id.clone())).await.map_err(db_err)?;
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(ids.len() as u32)
}

/// Push every outbox-queued asset (+ its refs) to Turso, if configured and
/// reachable. Never returns `Err` for "not configured" or "offline" — those
/// are reported in the `SyncReport` so a fire-and-forget frontend caller
/// doesn't need special-case error handling; `Err` is reserved for a
/// genuinely broken local index.
pub async fn sync_outbox(project_root: &Path) -> AppResult<SyncReport> {
    let local = open_local(project_root).await?;

    // Best-effort, every call: cheap (one row) and keeps the index's project
    // name from going stale if `pipeline.json` changes after the project was
    // first opened. Skipped while the project id hasn't been minted yet — the
    // frontend mints it fire-and-forget right after `project_open`, so an
    // early call here can still race it; the next call (after an asset write,
    // or the next project open) picks it up.
    let project_id = read_project_id(project_root)?;
    if !project_id.is_empty() {
        let title = project_title_for(project_root);
        upsert_project_row(
            &local,
            &project_id,
            &title,
            &chrono::Utc::now().to_rfc3339(),
        )
        .await?;
    }

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

    if !project_id.is_empty() {
        let title = project_title_for(project_root);
        if let Err(e) = upsert_project_row(
            &remote,
            &project_id,
            &title,
            &chrono::Utc::now().to_rfc3339(),
        )
        .await
        {
            // Best-effort, same as an individual asset push failing below —
            // never blocks the asset sync that follows.
            tracing::warn!("turso sync: project title push failed: {e}");
        }
    }

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
    let Some(record) = select_asset_by_id(local, id).await? else {
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

/// What the index already believes, loaded once instead of queried per file.
///
/// Reconcile used to run `select_asset_by_id` *and* `select_tags` for every
/// media file in the project — two round trips each, on a pass that fires on
/// every project open. `tags_all` already proves the whole index fits in one
/// query; this is the same idea with the asset rows alongside.
#[derive(Default)]
struct IndexSnapshot {
    rel_path_by_id: HashMap<String, String>,
    tags_by_id: HashMap<String, Vec<String>>,
}

async fn load_index_snapshot(conn: &Connection) -> AppResult<IndexSnapshot> {
    let mut snap = IndexSnapshot::default();

    let mut rows = conn
        .query(
            "SELECT id, rel_path FROM assets WHERE deleted_at IS NULL",
            (),
        )
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        snap.rel_path_by_id.insert(
            row.get::<String>(0).map_err(db_err)?,
            row.get::<String>(1).map_err(db_err)?,
        );
    }

    let mut rows = conn
        .query("SELECT asset_id, tag FROM asset_tags", ())
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        snap.tags_by_id
            .entry(row.get::<String>(0).map_err(db_err)?)
            .or_default()
            .push(row.get::<String>(1).map_err(db_err)?);
    }
    for tags in snap.tags_by_id.values_mut() {
        tags.sort();
    }
    Ok(snap)
}

/// A database change the filesystem pass decided on, applied afterwards.
enum DbWork {
    Relink { id: String, rel_path: String },
    Ingest(Box<AssetRecord>),
    SyncTags { id: String, tags: Vec<String> },
}

pub async fn project_reconcile(
    project_path: &Path,
    ffmpeg_path: &str,
) -> AppResult<ReconcileReport> {
    let project_id = read_project_id(project_path)?;
    let conn = open_local(project_path).await?;
    let snapshot = load_index_snapshot(&conn).await?;

    // The filesystem half — directory walks, sidecar reads and writes, and any
    // hashing — runs off the async runtime. It used to sit inline in this async
    // fn, so a project open could pin a runtime worker for as long as the scan
    // took, which on a large project over SMB is minutes.
    let root = project_path.to_path_buf();
    let ffmpeg = ffmpeg_path.to_string();
    let (report, work) =
        run_blocking(move || scan_for_reconcile(&root, &project_id, &ffmpeg, &snapshot)).await?;

    // One transaction for the whole apply: reconcile is a single repair pass,
    // and a half-applied one leaves the index describing neither the old state
    // nor the new.
    if !work.is_empty() {
        let tx = conn.transaction().await.map_err(db_err)?;
        for item in &work {
            match item {
                DbWork::Relink { id, rel_path } => {
                    update_rel_path(&tx, id, rel_path).await?;
                    enqueue_outbox(&tx, id).await?;
                }
                DbWork::Ingest(record) => {
                    upsert_asset_row(&tx, record.as_ref()).await?;
                    enqueue_outbox(&tx, &record.id).await?;
                }
                DbWork::SyncTags { id, tags } => {
                    replace_tag_rows(&tx, id, tags).await?;
                    enqueue_outbox(&tx, id).await?;
                }
            }
        }
        tx.commit().await.map_err(db_err)?;
    }
    Ok(report)
}

fn scan_for_reconcile(
    project_root: &Path,
    project_id: &str,
    ffmpeg_path: &str,
    snapshot: &IndexSnapshot,
) -> AppResult<(ReconcileReport, Vec<DbWork>)> {
    let mut report = ReconcileReport::default();
    let mut work = Vec::new();
    let root = ProjectRoot::from_root(project_root.to_path_buf());

    for shot in walk::project_shots(project_root)? {
        for (_version, media_path) in walk::shot_media(&shot.media_root)? {
            report.scanned += 1;
            reconcile_one_file(
                &root,
                project_id,
                &media_path,
                ffmpeg_path,
                snapshot,
                &mut report,
                &mut work,
            )?;
        }
    }
    Ok((report, work))
}

#[allow(clippy::too_many_arguments)]
fn reconcile_one_file(
    project_root: &ProjectRoot,
    project_id: &str,
    media_path: &Path,
    ffmpeg_path: &str,
    snapshot: &IndexSnapshot,
    report: &mut ReconcileReport,
    work: &mut Vec<DbWork>,
) -> AppResult<()> {
    let sidecar_path = sidecar_path(media_path);
    if !sidecar_path.is_file() {
        return Ok(());
    }
    let mut meta: serde_json::Value = read_json_or_default(&sidecar_path)?;
    let Some(obj) = meta.as_object().cloned() else {
        return Ok(());
    };

    let existing_id = obj
        .get("assetId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let is_legacy = existing_id.is_none();

    let id = match existing_id {
        Some(id) => id,
        None => {
            // Before minting: the file itself may still carry the id that was
            // embedded when it was generated. Recovering it keeps the existing
            // index row and its tags — minting a fresh uuid would orphan both,
            // which is exactly what embedding an id was meant to prevent.
            match media_id_read_impl(media_path, ffmpeg_path) {
                Ok(Some(embedded)) if !embedded.asset_id.is_empty() => {
                    report.identity_recovered += 1;
                    embedded.asset_id
                }
                _ => {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    // Best-effort — a failed embed still gets an id + hash.
                    let _ = media_id_embed_impl(media_path, &new_id, project_id, ffmpeg_path);
                    new_id
                }
            }
        }
    };

    let rel_path = project_root
        .rel(media_path)
        .unwrap_or_else(|| as_str(media_path));
    let indexed_rel = snapshot.rel_path_by_id.get(&id);
    let recorded_hash = obj.get("contentHash").and_then(|v| v.as_str());

    // Hashing every file on every project open meant reading the entire
    // project — routinely gigabytes of video — to answer "nothing changed",
    // which it almost always is. A file that already carries both halves of its
    // identity *and* is indexed at the path it actually sits at is taken at its
    // word.
    //
    // The trade is the standard one for an incremental indexer: a file edited
    // in place by another tool, keeping its path and sidecar, is no longer
    // noticed. `project_tags_reindex` and deleting the index both still force a
    // full re-read.
    let settled = !is_legacy
        && recorded_hash.is_some()
        && indexed_rel.is_some_and(|indexed| indexed == &rel_path);

    let hash = match (settled, recorded_hash) {
        (true, Some(h)) => h.to_string(),
        _ => file_hash_impl(media_path)?,
    };

    let hash_changed = recorded_hash != Some(hash.as_str());
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

    match indexed_rel {
        Some(indexed) if indexed != &rel_path => {
            work.push(DbWork::Relink {
                id: id.clone(),
                rel_path,
            });
            report.relinked += 1;
        }
        // Already indexed at the right path — location is in sync. Content
        // still might not be; tags are re-checked against the sidecar below.
        Some(_) => {}
        None => {
            let now = chrono::Utc::now().to_rfc3339();
            work.push(DbWork::Ingest(Box::new(AssetRecord {
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
                generated_by: obj
                    .get("generatedBy")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })));
            report.db_ingested += 1;
        }
    }

    // Sidecar is the source of truth for tags — pull it back over the index
    // whenever the two have drifted.
    let sidecar_tags = tags_from_sidecar(&obj);
    let mut wanted = sidecar_tags.clone();
    wanted.sort();
    let indexed_tags = snapshot.tags_by_id.get(&id);
    if indexed_tags.map(Vec::as_slice).unwrap_or(&[]) != wanted.as_slice() {
        work.push(DbWork::SyncTags {
            id,
            tags: sidecar_tags,
        });
        report.tags_synced += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestProject;
    use std::fs;

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
        let project = TestProject::new("db");
        let (root, project_id) = project.parts();
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
    }

    #[tokio::test]
    async fn asset_relink_updates_rel_path_and_no_ops_on_missing() {
        let project = TestProject::new("db");
        let root = project.root.clone();
        asset_upsert(&root, asset("asset-relink-1", "seq1/shot1/gen001/img.png"))
            .await
            .unwrap();

        assets_relink(
            &root,
            &[(
                "asset-relink-1".to_string(),
                "seq1/shot1/gen002/img.png".to_string(),
            )],
        )
        .await
        .unwrap();
        let row = asset_lookup(&root, Some("asset-relink-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.rel_path, "seq1/shot1/gen002/img.png");

        // No row for this id — a no-op, not an error (a move on a file that
        // was never indexed, e.g. pre-Phase-1, self-heals on the next
        // reconcile instead). An unknown id in a batch must not poison the
        // others either.
        assets_relink(
            &root,
            &[("no-such-asset".to_string(), "wherever.png".to_string())],
        )
        .await
        .unwrap();
        let still_missing = asset_lookup(&root, Some("no-such-asset".to_string()), None)
            .await
            .unwrap();
        assert!(still_missing.is_none());
    }

    #[tokio::test]
    async fn asset_rename_prefix_rewrites_matching_rel_paths_only() {
        let project = TestProject::new("db");
        let root = project.root.clone();
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
    }

    #[tokio::test]
    async fn cost_backfill_sets_costs_and_tolerates_unknown_ids_in_the_batch() {
        let project = TestProject::new("db");
        let root = project.root.clone();
        asset_upsert(&root, asset("asset-cost-1", "seq1/shot1/gen001/img.png"))
            .await
            .unwrap();
        asset_upsert(&root, asset("asset-cost-2", "seq1/shot1/gen001/img2.png"))
            .await
            .unwrap();

        // An id the index has never seen is a no-op, not an error — the cost
        // scan runs over sidecars and may reach a file before it is indexed —
        // and crucially it must not stop the rest of the batch applying.
        assets_cost_update(
            &root,
            &[
                ("asset-cost-1".to_string(), 0.0123),
                ("no-such-asset".to_string(), 1.0),
                ("asset-cost-2".to_string(), 0.5),
            ],
        )
        .await
        .unwrap();

        for (id, expected) in [("asset-cost-1", 0.0123), ("asset-cost-2", 0.5)] {
            let row = asset_lookup(&root, Some(id.to_string()), None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row.cost_usd, Some(expected), "{id}");
        }
        assert!(asset_lookup(&root, Some("no-such-asset".to_string()), None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn asset_refs_roundtrip() {
        let project = TestProject::new("db");
        let root = project.root.clone();
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
    }

    #[tokio::test]
    async fn sync_outbox_reports_not_configured_when_unset() {
        let project = TestProject::new("db");
        let root = project.root.clone();
        asset_upsert(&root, asset("asset-3", "x.png"))
            .await
            .unwrap();
        // This dev machine has no TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set —
        // exercises the "local-only, nothing configured" branch.
        let report = sync_outbox(&root).await.unwrap();
        assert!(!report.configured);
        assert_eq!(report.pending, 1);
    }

    #[tokio::test]
    async fn reconcile_backfills_legacy_ingests_and_relinks() {
        let project = TestProject::new("db");
        let root = project.root.clone();
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
    }

    /// Reconcile no longer hashes every file on every project open — reading a
    /// whole project of video to conclude "nothing changed" was the single most
    /// expensive thing it did. A file that already carries an id and a hash,
    /// and is indexed at the path it actually sits at, is taken at its word.
    ///
    /// This pins both halves: the skip really happens (an in-place edit goes
    /// unnoticed — the accepted trade), and it stops applying the moment the
    /// file moves, which is the case that actually matters.
    #[tokio::test]
    async fn a_settled_file_is_not_rehashed_but_a_moved_one_is() {
        let project = TestProject::new("db");
        let root = project.root.clone();
        let v1 = root.join("seq1/shot1/gen001");
        fs::create_dir_all(&v1).unwrap();

        let media = v1.join("settled.png");
        fs::write(&media, b"original bytes").unwrap();
        let original_hash = file_hash_impl(&media).unwrap();
        write_json_atomic(
            &media.with_extension("json"),
            &serde_json::json!({
                "assetId": "settled-1", "contentHash": original_hash,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .unwrap();

        // First pass indexes it.
        project_reconcile(&root, "").await.unwrap();

        // Now change the bytes underneath, leaving path and sidecar alone.
        fs::write(&media, b"different bytes entirely").unwrap();
        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.scanned, 1);

        let sidecar: serde_json::Value =
            read_json_or_default(&media.with_extension("json")).unwrap();
        assert_eq!(
            sidecar.get("contentHash").and_then(|v| v.as_str()),
            Some(original_hash.as_str()),
            "a settled file is taken at its word — the edit is not noticed"
        );

        // Move it. The file is no longer where the index says, so it is hashed
        // again and the stale hash is repaired.
        let v2 = root.join("seq1/shot1/gen002");
        fs::create_dir_all(&v2).unwrap();
        let moved = v2.join("settled.png");
        fs::rename(&media, &moved).unwrap();
        fs::rename(media.with_extension("json"), moved.with_extension("json")).unwrap();

        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.relinked, 1);
        let sidecar: serde_json::Value =
            read_json_or_default(&moved.with_extension("json")).unwrap();
        assert_eq!(
            sidecar.get("contentHash").and_then(|v| v.as_str()),
            Some(file_hash_impl(&moved).unwrap().as_str()),
            "a moved file is re-hashed, so the drift is caught"
        );
    }

    /// Embedding an id inside the media file exists so a file that loses its
    /// sidecar link can still be traced back to the asset it was. Reconcile now
    /// actually uses it: a sidecar with no `assetId` gets the embedded one back
    /// rather than a fresh uuid, which would have orphaned the existing index
    /// row and every tag on it.
    #[tokio::test]
    async fn reconcile_recovers_an_embedded_id_instead_of_minting_a_new_one() {
        let project = TestProject::new("db");
        let root = project.root.clone();
        let v1 = root.join("seq1/shot1/gen001");
        fs::create_dir_all(&v1).unwrap();

        // A real PNG is required — the id lives in a PNG text chunk.
        let media = v1.join("embedded.png");
        fs::write(
            &media,
            crate::commands::media_id::tests::minimal_png_bytes(),
        )
        .unwrap();
        crate::commands::media_id::media_id_embed_impl(&media, "recovered-1", "proj", "").unwrap();

        // Sidecar exists but has lost its assetId — the shape left behind when
        // a sidecar is rebuilt or hand-edited.
        write_json_atomic(
            &media.with_extension("json"),
            &serde_json::json!({ "timestamp": chrono::Utc::now().to_rfc3339() }),
        )
        .unwrap();

        let report = project_reconcile(&root, "").await.unwrap();
        assert_eq!(report.identity_recovered, 1, "the embedded id was reused");
        assert_eq!(report.sidecar_backfilled, 1);

        // The recovered id — not a new uuid — is what landed in both places.
        let sidecar: serde_json::Value =
            read_json_or_default(&media.with_extension("json")).unwrap();
        assert_eq!(
            sidecar.get("assetId").and_then(|v| v.as_str()),
            Some("recovered-1")
        );
        assert!(asset_lookup(&root, Some("recovered-1".to_string()), None)
            .await
            .unwrap()
            .is_some());
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
        let project = TestProject::new("db");
        let root = project.root.clone();

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
    }

    #[tokio::test]
    async fn purge_drops_a_deleted_file_and_a_deleted_directory() {
        let project = TestProject::new("db");
        let root = project.root.clone();
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
    }

    #[tokio::test]
    async fn reconcile_pulls_sidecar_tags_back_over_a_wiped_index() {
        let project = TestProject::new("db");
        let root = project.root.clone();
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
    }
}
