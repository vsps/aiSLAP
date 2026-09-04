//! Thin Tauri-command shim over `db::` — argument marshalling only, no
//! logic here (see `db/mod.rs` for the actual local-index + sync/reconcile
//! implementation, which is plain async Rust and directly unit-testable).

use std::path::PathBuf;

use std::collections::HashMap;

use crate::db::derive::DerivedPricing;
use crate::db::pricing::SharedPricing;
use crate::db::trace::AssetTrace;
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

/// Identify a loose media file and report every index row that describes it.
/// Takes no project path on purpose — see `db::trace`.
#[tauri::command]
pub async fn asset_trace(path: String, ffmpeg_path: String) -> AppResult<AssetTrace> {
    db::trace::asset_trace(&PathBuf::from(path), &ffmpeg_path).await
}

#[tauri::command]
pub async fn asset_refs_set(
    project_path: String,
    asset_id: String,
    refs: Vec<AssetRefRecord>,
) -> AppResult<()> {
    db::asset_refs_set(&PathBuf::from(project_path), &asset_id, &refs).await
}

/// Read the team's shared price sheet. `None` means no Turso is configured —
/// the caller stays on its local `config.json` cache.
#[tauri::command]
pub async fn pricing_pull() -> AppResult<Option<SharedPricing>> {
    db::pricing::pricing_pull().await
}

/// Upsert prices/overrides into the shared sheet, last write wins per row.
/// `None` when no Turso is configured; otherwise the row count written.
#[tauri::command]
pub async fn pricing_push(
    prices: HashMap<String, String>,
    overrides: HashMap<String, f64>,
) -> AppResult<Option<u32>> {
    db::pricing::pricing_push(prices, overrides).await
}

/// Read a price table out of what fal actually billed, grouped by endpoint
/// and resolution. Only reconciled rows are averaged — see `db::derive`.
#[tauri::command]
pub async fn pricing_derive() -> AppResult<DerivedPricing> {
    db::derive::pricing_derive().await
}

/// Remove one override from the shared sheet — clearing the field locally is
/// not enough, since a push only ever upserts what it was given.
#[tauri::command]
pub async fn pricing_forget(key: String) -> AppResult<Option<bool>> {
    db::pricing::pricing_forget(key).await
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
