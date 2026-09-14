//! OS/system identity — currently just "who is running this copy of the
//! app", used to attribute generated assets for a future central-db
//! cost/usage query.

#[tauri::command]
pub fn system_username() -> String {
    whoami::username()
}

/// Open the webview inspector on the calling window.
///
/// Opening is idempotent everywhere; `is_devtools_open` is not (unsupported on
/// Windows), so there is no toggle — F12 opens, the inspector's own close
/// button closes.
#[tauri::command]
pub fn devtools_open(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_a_nonempty_name_on_this_machine() {
        let name = system_username();
        eprintln!("whoami::username() = {name:?}");
        assert!(!name.is_empty());
    }
}
