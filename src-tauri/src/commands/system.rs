//! OS/system identity — currently just "who is running this copy of the
//! app", used to attribute generated assets for a future central-db
//! cost/usage query.

#[tauri::command]
pub fn system_username() -> String {
    whoami::username()
}
