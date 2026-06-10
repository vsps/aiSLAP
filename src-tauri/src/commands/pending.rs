//! Persistent "pending submissions" log used to recover orphan generations
//! after a crash/restart.
//!
//! Stored in `${appdata}/pending.json` as a flat JSON array. Records are
//! passthrough `serde_json::Value`s so the schema lives on the frontend
//! (`PendingSubmission` in `src/lib/types.ts`) and we don't need to mirror
//! every field on the Rust side.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::fsjson::{read_json_or_default, write_json_atomic};
use crate::paths;

// Missing, empty, or corrupt file → empty list rather than a loud failure.
fn read_list() -> AppResult<Vec<Value>> {
    read_json_or_default(&paths::pending_path()?)
}

fn write_list(list: &[Value]) -> AppResult<()> {
    write_json_atomic(&paths::pending_path()?, &list)
}

fn record_id(record: &Value) -> Option<&str> {
    record.get("id").and_then(|v| v.as_str())
}

#[tauri::command]
pub fn pending_load() -> AppResult<Vec<Value>> {
    read_list()
}

#[tauri::command]
pub fn pending_add(record: Value) -> AppResult<()> {
    let id = record_id(&record)
        .ok_or_else(|| AppError::Msg("pending record missing string `id` field".into()))?
        .to_string();
    let mut list = read_list()?;
    // Replace any existing record with the same id (defensive — caller shouldn't
    // double-add, but if it does we keep the latest write).
    list.retain(|r| record_id(r) != Some(&id));
    list.push(record);
    write_list(&list)
}

#[tauri::command]
pub fn pending_remove(id: String) -> AppResult<()> {
    let mut list = read_list()?;
    let before = list.len();
    list.retain(|r| record_id(r) != Some(&id));
    if list.len() != before {
        write_list(&list)?;
    }
    Ok(())
}
