//! Thin Tauri-command shim over `db::` — argument marshalling only, no
//! logic here (see `db/mod.rs` for the actual local-index + sync/reconcile
//! implementation, which is plain async Rust and directly unit-testable).

use std::path::PathBuf;

use crate::db::{self, AssetRecord, AssetRefRecord, ReconcileReport, SyncReport};
use crate::error::AppResult;

#[tauri::command]
pub async fn asset_upsert(project_path: String, record: AssetRecord) -> AppResult<()> {
    db::asset_upsert(&PathBuf::from(project_path), record).await
}

#[tauri::command]
pub async fn asset_lookup(
    project_path: String,
    asset_id: Option<String>,
    content_hash: Option<String>,
) -> AppResult<Option<AssetRecord>> {
    db::asset_lookup(&PathBuf::from(project_path), asset_id, content_hash).await
}

#[tauri::command]
pub async fn asset_refs_set(
    project_path: String,
    asset_id: String,
    refs: Vec<AssetRefRecord>,
) -> AppResult<()> {
    db::asset_refs_set(&PathBuf::from(project_path), &asset_id, &refs).await
}

#[tauri::command]
pub async fn db_sync_outbox(project_path: String) -> AppResult<SyncReport> {
    db::sync_outbox(&PathBuf::from(project_path)).await
}

#[tauri::command]
pub async fn project_reconcile(
    project_path: String,
    ffmpeg_path: String,
) -> AppResult<ReconcileReport> {
    db::project_reconcile(&PathBuf::from(project_path), &ffmpeg_path).await
}
