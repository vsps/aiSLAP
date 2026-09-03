//! "Where did this file come from?" — trace a media file back to the index
//! rows that describe it.
//!
//! The audit case: someone is handed a file that has been moved out of its
//! project, or copied off the share, and its sidecar did not travel with it.
//! Three things can still identify it, in descending order of confidence:
//!
//! 1. the **asset id embedded in the media itself** (`media_id.rs`) — or, if
//!    the sidecar did survive, the one it records;
//! 2. the **content hash** of the bytes, which survives any tool that strips
//!    metadata but not one that re-encodes;
//! 3. the **file name**, which is a guess and is treated as one — it is only
//!    consulted when neither identity matched anything, and every row it
//!    returns is labelled `fileName` so the UI can say so.
//!
//! Unlike every other query in this module the search is deliberately *not*
//! scoped to one project: the whole premise is a file that may not belong to
//! the project currently open. It walks every local index in
//! `%APPDATA%/aiSLAP/db`, plus the shared Turso database when one is
//! configured — which is what can answer for a file generated on someone
//! else's machine.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use libsql::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{
    asset_columns, db_err, local_db, open_remote, row_to_asset, select_asset_by_id, select_refs,
    select_tags, AssetRecord, AssetRefRecord,
};
use crate::commands::config::turso_config;
use crate::commands::fsutil::{as_str, sidecar_path};
use crate::commands::media_id::{file_hash_impl, media_id_read_impl};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::read_json_or_default;
use crate::paths::appdata_dir;

/// Rows returned for one content hash, per index. A hash is *not* unique — a
/// copy is re-identified with a fresh asset id but keeps the bytes it was
/// copied from, so the same hash legitimately describes several assets.
const MAX_HASH_MATCHES: usize = 25;
/// Rows returned per index for a name-only search. `output.mp4` in a hundred
/// shots is a realistic input; a capped list the user can narrow beats a
/// thousand-row wall.
const MAX_NAME_MATCHES: usize = 50;

const SELECT_ASSETS_BY_HASH: &str = concat!(
    "SELECT ",
    asset_columns!(),
    " FROM assets WHERE content_hash = ?1 AND deleted_at IS NULL LIMIT 25"
);

/// `rel_path` is project-relative and forward-slashed, so a basename match is
/// either the whole of it (a file at the project root) or the tail after a
/// slash. The leading wildcard means no index can serve this — which is part
/// of why it is the last resort rather than a first pass.
const SELECT_ASSETS_BY_NAME: &str = concat!(
    "SELECT ",
    asset_columns!(),
    " FROM assets WHERE deleted_at IS NULL AND (rel_path = ?1 OR rel_path LIKE ?2 ESCAPE '\\') \
     ORDER BY created_at DESC LIMIT 50"
);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMatch {
    /// How this row was found: `"assetId"`, `"contentHash"` or `"fileName"`.
    /// The first two are proof; the third is a name collision until a human
    /// says otherwise.
    pub matched_by: String,
    /// `"local"` (an index file on this machine) or `"remote"` (Turso).
    pub source: String,
    pub asset: AssetRecord,
    pub tags: Vec<String>,
    pub refs: Vec<AssetRefRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_title: Option<String>,
    /// Absolute project root — known only for a project this machine has
    /// opened since `root_path` started being recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    /// Where the asset should still be sitting: `project_root` + `rel_path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    /// Whether `original_path` is still there. `None` when the root is
    /// unknown, which is not the same as "gone".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_exists: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTrace {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// Hash of the bytes on disk, computed now — not read from anywhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_project_id: Option<String>,
    pub sidecar_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar_asset_id: Option<String>,
    /// The hash the sidecar claims. Differing from `content_hash` means the
    /// bytes changed since it was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar_content_hash: Option<String>,
    pub matches: Vec<TraceMatch>,
    /// Local index files searched.
    pub indexes_searched: u32,
    pub remote_searched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_error: Option<String>,
}

/// What the file itself can say about its own identity, gathered off the
/// async runtime — hashing reads every byte and the video path shells out to
/// ffmpeg.
struct FileIdentity {
    size_bytes: u64,
    content_hash: Option<String>,
    embedded_asset_id: Option<String>,
    embedded_project_id: Option<String>,
    sidecar_found: bool,
    sidecar_asset_id: Option<String>,
    sidecar_content_hash: Option<String>,
}

fn read_identity(path: &Path, ffmpeg_path: &str) -> AppResult<FileIdentity> {
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // A sidecar that did travel with the file is the cheapest answer, and it
    // carries the hash the file had when it was written — worth reporting
    // even when it disagrees with the bytes, since that disagreement is
    // itself a finding.
    let mut sidecar_found = false;
    let mut sidecar_asset_id = None;
    let mut sidecar_content_hash = None;
    let sidecar = sidecar_path(path);
    if sidecar.is_file() {
        sidecar_found = true;
        let meta: serde_json::Value = read_json_or_default(&sidecar)?;
        sidecar_asset_id = meta
            .get("assetId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        sidecar_content_hash = meta
            .get("contentHash")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
    }

    // Best-effort: a format that carries no id, or one whose tag an external
    // tool stripped, just leaves the hash to do the work.
    let embedded = media_id_read_impl(path, ffmpeg_path).unwrap_or(None);
    let (embedded_asset_id, embedded_project_id) = match embedded {
        Some(id) if !id.asset_id.is_empty() => (
            Some(id.asset_id),
            Some(id.project_id).filter(|s| !s.is_empty()),
        ),
        _ => (None, None),
    };

    Ok(FileIdentity {
        size_bytes,
        content_hash: file_hash_impl(path).ok(),
        embedded_asset_id,
        embedded_project_id,
        sidecar_found,
        sidecar_asset_id,
        sidecar_content_hash,
    })
}

/// Every local index file: one per project this machine has opened. Shared
/// with `db::derive`, which walks the same set when no Turso is configured.
pub(super) fn local_index_files() -> AppResult<Vec<PathBuf>> {
    let dir = appdata_dir()?.join("db");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        // `.db` only — WAL leaves `-wal`/`-shm` companions beside each file.
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("db"))
        .collect();
    out.sort();
    Ok(out)
}

/// `project_id` → (title, root path), pooled across every local index.
///
/// Pooled rather than read per match because it also answers for *remote*
/// matches: a project first seen on another machine still resolves to a local
/// folder here if this machine has ever opened it, which is what turns "some
/// project id you don't recognise" into somewhere the user can go and look.
type ProjectDirectory = HashMap<String, (Option<String>, Option<String>)>;

async fn read_projects_local(conn: &Connection, into: &mut ProjectDirectory) {
    let Ok(mut rows) = conn
        .query("SELECT project_id, title, root_path FROM projects", ())
        .await
    else {
        return;
    };
    while let Ok(Some(row)) = rows.next().await {
        let Ok(id) = row.get::<String>(0) else {
            continue;
        };
        let title = row.get::<Option<String>>(1).unwrap_or(None);
        let root = row.get::<Option<String>>(2).unwrap_or(None);
        let entry = into.entry(id).or_insert((None, None));
        // First index to claim a project wins; every later one only fills in
        // what is still missing, so a stub row can't blank a real answer.
        if entry.0.is_none() {
            entry.0 = title;
        }
        if entry.1.is_none() {
            entry.1 = root;
        }
    }
}

/// The remote `projects` table has no `root_path` — paths are per-machine, and
/// pushing one machine's drive letters into a shared database would be worse
/// than useless to everyone else.
async fn remote_project_title(conn: &Connection, project_id: &str) -> Option<String> {
    let mut rows = conn
        .query(
            "SELECT title FROM projects WHERE project_id = ?1 LIMIT 1",
            params!(project_id.to_string()),
        )
        .await
        .ok()?;
    rows.next().await.ok()??.get::<String>(0).ok()
}

fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// One index being searched, and where its rows came from.
struct Source {
    label: &'static str,
    conn: Connection,
}

async fn collect(
    source: &Source,
    matched_by: &str,
    rows: Vec<AssetRecord>,
    seen: &mut HashSet<String>,
    directory: &ProjectDirectory,
    out: &mut Vec<TraceMatch>,
) -> AppResult<()> {
    for asset in rows {
        // An asset synced to Turso is also in the local index it came from.
        // Locals are searched first, so the local row wins and the remote
        // duplicate is dropped rather than listed twice.
        if !seen.insert(asset.id.clone()) {
            continue;
        }
        let tags = select_tags(&source.conn, &asset.id)
            .await
            .unwrap_or_default();
        let refs = select_refs(&source.conn, &asset.id)
            .await
            .unwrap_or_default();

        let (mut project_title, project_root) = match asset.project_id.as_deref() {
            Some(id) => directory.get(id).cloned().unwrap_or((None, None)),
            None => (None, None),
        };
        if project_title.is_none() && source.label == "remote" {
            if let Some(id) = asset.project_id.as_deref() {
                project_title = remote_project_title(&source.conn, id).await;
            }
        }

        let original = project_root
            .as_ref()
            .map(|root| PathBuf::from(root).join(&asset.rel_path));

        out.push(TraceMatch {
            matched_by: matched_by.to_string(),
            source: source.label.to_string(),
            asset,
            tags,
            refs,
            project_title,
            project_root,
            original_path: original.as_deref().map(as_str),
            original_exists: original.as_deref().map(Path::exists),
        });
    }
    Ok(())
}

async fn select_by_hash(conn: &Connection, hash: &str) -> AppResult<Vec<AssetRecord>> {
    let mut rows = conn
        .query(SELECT_ASSETS_BY_HASH, params!(hash.to_string()))
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(row_to_asset(&row)?);
        if out.len() >= MAX_HASH_MATCHES {
            break;
        }
    }
    Ok(out)
}

async fn select_by_name(conn: &Connection, file_name: &str) -> AppResult<Vec<AssetRecord>> {
    let mut rows = conn
        .query(
            SELECT_ASSETS_BY_NAME,
            params!(
                file_name.to_string(),
                format!("%/{}", like_escape(file_name))
            ),
        )
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(row_to_asset(&row)?);
        if out.len() >= MAX_NAME_MATCHES {
            break;
        }
    }
    Ok(out)
}

pub async fn asset_trace(path: &Path, ffmpeg_path: &str) -> AppResult<AssetTrace> {
    if !path.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(path))));
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let ident = {
        let path = path.to_path_buf();
        let ffmpeg = ffmpeg_path.to_string();
        run_blocking(move || read_identity(&path, &ffmpeg)).await?
    };

    let mut trace = AssetTrace {
        path: as_str(path),
        file_name: file_name.clone(),
        size_bytes: ident.size_bytes,
        content_hash: ident.content_hash.clone(),
        embedded_asset_id: ident.embedded_asset_id.clone(),
        embedded_project_id: ident.embedded_project_id.clone(),
        sidecar_found: ident.sidecar_found,
        sidecar_asset_id: ident.sidecar_asset_id.clone(),
        sidecar_content_hash: ident.sidecar_content_hash.clone(),
        ..Default::default()
    };

    // Candidate identities, deduplicated: the sidecar and the embedded tag
    // normally agree, and a sidecar hash that has gone stale against the bytes
    // is still worth trying — it is what the index was written from.
    let mut ids: Vec<String> = Vec::new();
    for id in [&ident.sidecar_asset_id, &ident.embedded_asset_id]
        .into_iter()
        .flatten()
    {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let mut hashes: Vec<String> = Vec::new();
    for hash in [&ident.content_hash, &ident.sidecar_content_hash]
        .into_iter()
        .flatten()
    {
        if !hashes.contains(hash) {
            hashes.push(hash.clone());
        }
    }

    let mut sources: Vec<Source> = Vec::new();
    for file in local_index_files()? {
        match local_db(&file)
            .await
            .and_then(|db| db.connect().map_err(db_err))
        {
            Ok(conn) => sources.push(Source {
                label: "local",
                conn,
            }),
            // One unreadable index must not sink the search — another may well
            // hold the answer.
            Err(e) => tracing::warn!("trace: skipping index {}: {e}", file.display()),
        }
    }
    trace.indexes_searched = sources.len() as u32;

    if let Some((url, token)) = turso_config()? {
        match open_remote(url, token).await {
            Ok(conn) => {
                trace.remote_searched = true;
                sources.push(Source {
                    label: "remote",
                    conn,
                });
            }
            Err(e) => trace.remote_error = Some(e.to_string()),
        }
    }

    let mut directory: ProjectDirectory = HashMap::new();
    for source in &sources {
        if source.label == "local" {
            read_projects_local(&source.conn, &mut directory).await;
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    for source in &sources {
        for id in &ids {
            if let Ok(Some(row)) = select_asset_by_id(&source.conn, id).await {
                collect(
                    source,
                    "assetId",
                    vec![row],
                    &mut seen,
                    &directory,
                    &mut trace.matches,
                )
                .await?;
            }
        }
        for hash in &hashes {
            if let Ok(rows) = select_by_hash(&source.conn, hash).await {
                collect(
                    source,
                    "contentHash",
                    rows,
                    &mut seen,
                    &directory,
                    &mut trace.matches,
                )
                .await?;
            }
        }
    }

    // Only when nothing identified the file. A name match listed alongside a
    // hash match would be noise dressed as evidence.
    if trace.matches.is_empty() && !file_name.is_empty() {
        for source in &sources {
            if let Ok(rows) = select_by_name(&source.conn, &file_name).await {
                collect(
                    source,
                    "fileName",
                    rows,
                    &mut seen,
                    &directory,
                    &mut trace.matches,
                )
                .await?;
            }
        }
    }

    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{asset_upsert, sync_outbox};
    use crate::testutil::TestProject;

    fn record(id: &str, rel_path: &str, hash: &str) -> AssetRecord {
        AssetRecord {
            id: id.to_string(),
            rel_path: rel_path.to_string(),
            content_hash: Some(hash.to_string()),
            kind: "image".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            generated_by: Some("tester".to_string()),
            ..Default::default()
        }
    }

    /// Every assertion here filters `trace.matches` to the ids this test
    /// created: the search walks *every* index in the real `%APPDATA%`, so
    /// another project's rows are expected company, not a failure.
    fn ids_of(trace: &AssetTrace, matched_by: &str) -> Vec<String> {
        trace
            .matches
            .iter()
            .filter(|m| m.matched_by == matched_by)
            .map(|m| m.asset.id.clone())
            .collect()
    }

    #[tokio::test]
    async fn traces_a_moved_file_by_its_sidecar_identity() {
        let project = TestProject::new("trace");
        let (root, project_id) = project.parts();
        // Index the asset where it was generated, then look it up from a copy
        // that has been moved somewhere else entirely.
        let media = project.media(
            "seq1/shot1/gen001/img.png",
            Some(serde_json::json!({ "assetId": "trace-1", "contentHash": "abc" })),
        );
        asset_upsert(&root, record("trace-1", "seq1/shot1/gen001/img.png", "abc"))
            .await
            .unwrap();
        // Populates `projects` (title + root_path), which is what lets the
        // trace name the project rather than just its id.
        sync_outbox(&root).await.unwrap();

        let trace = asset_trace(&media, "").await.unwrap();
        assert_eq!(trace.sidecar_asset_id.as_deref(), Some("trace-1"));
        assert_eq!(ids_of(&trace, "assetId"), vec!["trace-1".to_string()]);

        let hit = trace
            .matches
            .iter()
            .find(|m| m.asset.id == "trace-1")
            .unwrap();
        assert_eq!(hit.asset.project_id.as_deref(), Some(project_id.as_str()));
        assert_eq!(hit.asset.generated_by.as_deref(), Some("tester"));
        assert_eq!(hit.project_root.as_deref(), Some(as_str(&root).as_str()));
        assert_eq!(hit.original_exists, Some(true));
    }

    #[tokio::test]
    async fn falls_back_to_file_name_only_when_identity_finds_nothing() {
        let project = TestProject::new("trace");
        let root = project.root.clone();
        asset_upsert(
            &root,
            record("trace-name-1", "seq1/shot1/gen001/orphan-xyz.png", "zzz"),
        )
        .await
        .unwrap();

        // A file with no sidecar and no embedded id (the bytes are not a real
        // PNG, so nothing is recoverable from them) — name is all that's left.
        // The bytes are made unique so no *other* index on this machine can
        // hash-match them, which would suppress the name pass under test.
        let media = project.media("elsewhere/orphan-xyz.png", None);
        std::fs::write(&media, uuid::Uuid::new_v4().to_string()).unwrap();

        let trace = asset_trace(&media, "").await.unwrap();
        assert!(!trace.sidecar_found);
        assert!(trace.embedded_asset_id.is_none());
        assert_eq!(
            ids_of(&trace, "fileName"),
            vec!["trace-name-1".to_string()],
            "name fallback should find the row"
        );
        assert!(
            ids_of(&trace, "assetId").is_empty() && ids_of(&trace, "contentHash").is_empty(),
            "nothing should have matched by identity"
        );
    }

    #[tokio::test]
    async fn matches_by_content_hash_when_the_name_changed() {
        let project = TestProject::new("trace");
        let root = project.root.clone();
        let media = project.media("seq1/shot1/gen001/img.png", None);
        let hash = file_hash_impl(&media).unwrap();
        asset_upsert(
            &root,
            record("trace-hash-1", "seq1/shot1/gen001/img.png", &hash),
        )
        .await
        .unwrap();

        // Same bytes, different name, no sidecar: only the hash can answer.
        let renamed = project.root.join("renamed-by-someone.png");
        std::fs::copy(&media, &renamed).unwrap();
        let trace = asset_trace(&renamed, "").await.unwrap();
        assert_eq!(trace.content_hash.as_deref(), Some(hash.as_str()));
        assert!(
            ids_of(&trace, "contentHash").contains(&"trace-hash-1".to_string()),
            "hash match missing: {:?}",
            trace.matches
        );
    }

    #[test]
    fn like_escape_neutralises_wildcards() {
        assert_eq!(like_escape("100%_shot.png"), r"100\%\_shot.png");
        assert_eq!(like_escape("plain.png"), "plain.png");
    }
}
