//! OS/system identity — currently just "who is running this copy of the
//! app", used to attribute generated assets for a future central-db
//! cost/usage query.

#[tauri::command]
pub fn system_username() -> String {
    whoami::username()
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
