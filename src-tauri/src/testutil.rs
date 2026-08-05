//! Shared test fixtures.
//!
//! Four modules used to carry their own copy of `test_project`/`cleanup`
//! (`db`, `commands::tags`, `commands::image`, `commands::rename`) — one of
//! them with a comment acknowledging the duplication. They are consolidated
//! here.
//!
//! The consolidation also fixes a real leak: every copy called `cleanup()`
//! *after* the assertions, so a failing test left both a temp directory and a
//! `.db` file behind in the user's profile. [`TestProject`] cleans up in
//! `Drop`, which runs on the unwinding panic too.
//!
//! Note that these tests write into the *real* `%APPDATA%/aiSLAP/db/`, keyed by
//! a per-run uuid. That is why CI runs `cargo test -- --test-threads=1`.

// A fixture toolbox: not every consumer uses every helper, and a test being
// added or removed should never break the build over an unused constructor.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::commands::fsutil::{sidecar_path, PROJECT_SIDECAR};
use crate::domain::ProjectSidecar;
use crate::fsjson::write_json_atomic;

/// A throwaway project rooted under the OS temp dir, with a real `project.json`
/// so `read_project_id` and the local-db-path derivation behave exactly as they
/// would for a real project.
pub struct TestProject {
    pub root: PathBuf,
    pub project_id: String,
}

impl TestProject {
    /// A plain (non-PRISM) project. `prefix` only makes failures easier to
    /// attribute to a module; uniqueness comes from the uuid.
    pub fn new(prefix: &str) -> Self {
        let project_id = format!("test-{prefix}-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(&project_id);
        fs::create_dir_all(&root).unwrap();
        write_json_atomic(
            &root.join(PROJECT_SIDECAR),
            &ProjectSidecar {
                project_id: project_id.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        Self { root, project_id }
    }

    /// A PRISM project: the same `project.json` marker plus a
    /// `00_Pipeline/pipeline.json` declaring the stock shot and asset roots and
    /// a 4-digit version padding.
    pub fn prism(prefix: &str) -> Self {
        let project = Self::new(prefix);
        let pipeline = project.root.join("00_Pipeline");
        fs::create_dir_all(&pipeline).unwrap();
        fs::write(
            pipeline.join("pipeline.json"),
            r#"{"globals":{"project_name":"TESTPRJ","versionFormat":"v#","versionPadding":4},
                "folder_structure":{
                  "sequences":{"value":"@project_path@/03_Production/Shots/@sequence@"},
                  "assets":{"value":"@project_path@/03_Production/Assets/@asset_path@"}}}"#,
        )
        .unwrap();
        project
    }

    /// Create a media file at `rel` (parents included), optionally with a
    /// sidecar beside it. Returns the media path.
    pub fn media(&self, rel: &str, sidecar: Option<Value>) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fake media").unwrap();
        if let Some(value) = sidecar {
            write_json_atomic(&sidecar_path(&path), &value).unwrap();
        }
        path
    }

    /// Create an empty directory at `rel`. Returns its path.
    pub fn dir(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// The project root as the forward-slashed string the Tauri commands take.
    pub fn root_str(&self) -> String {
        crate::commands::fsutil::as_str(&self.root)
    }

    /// Owned root and id. The guard itself must stay alive for the duration of
    /// the test — it is what cleans up — so bind it before calling this.
    pub fn parts(&self) -> (PathBuf, String) {
        (self.root.clone(), self.project_id.clone())
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        if let Ok(dir) = crate::paths::appdata_dir() {
            let db = dir.join("db").join(format!("{}.db", self.project_id));
            // The db layer caches open handles, and Windows will not delete a
            // file that is still open — evict before unlinking.
            crate::db::evict_cached_db(&db);
            let _ = fs::remove_file(&db);
            // WAL leaves companions beside the file.
            for suffix in ["-wal", "-shm"] {
                let mut companion = db.clone().into_os_string();
                companion.push(suffix);
                let _ = fs::remove_file(PathBuf::from(companion));
            }
        }
    }
}
