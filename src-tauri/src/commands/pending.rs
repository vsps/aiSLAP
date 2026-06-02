//! Persistent "pending submissions" log used to recover orphan generations
//! after a crash/restart.
//!
//! Stored in `${appdata}/pending.json` as a flat JSON array. Records are
//! passthrough `serde_json::Value`s so the schema lives on the frontend
//! (`PendingSubmission` in `src/lib/types.ts`) and we don't need to mirror
//! every field on the Rust side.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::paths;

fn read_list() -> AppResult<Vec<Value>> {
    let path = paths::pending_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    match serde_json::from_str::<Vec<Value>>(&text) {
        Ok(v) => Ok(v),
        Err(_) => Ok(vec![]), // corrupt file → treat as empty rather than fail loudly
    }
}

fn write_list(list: &[Value]) -> AppResult<()> {
    let path = paths::pending_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(list)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
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
