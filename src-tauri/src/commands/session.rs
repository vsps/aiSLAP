//! Project / sequence / shot lifecycle: open, create, version allocation,
//! the project script, and per-shot sidecar fields. Rename (with its sidecar
//! path cascade) lives in `rename.rs`; prompt-history appends live in
//! `prompt_history.rs`.

use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;

use crate::commands::fsutil::{
    as_str, list_dirs, next_version_name, sanitize, version_prefix_for, PROJECT_SIDECAR, SEL_DIR,
    SEQUENCE_SIDECAR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::gallery::scan_shot_columns;
use crate::domain::{GalleryColumn, ProjectSidecar, SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{
    ensure_dir, read_json_or_default as read_sidecar, write_json_atomic as write_sidecar_atomic,
};

// ---------- Project / sequence / shot open + create ----------

#[tauri::command]
pub fn project_open(project_path: String) -> AppResult<Vec<String>> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    // Reject folders that are clearly sequences or shots, not projects.
    if root.join(SEQUENCE_SIDECAR).exists() || root.join(SHOT_SIDECAR).exists() {
        return Err(AppError::Msg("NOT A PROJECT FOLDER".into()));
    }
    // Auto-create project.json on first open (new project or migration).
    let sidecar_path = root.join(PROJECT_SIDECAR);
    if !sidecar_path.exists() {
        let title = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project")
            .to_string();
        write_sidecar_atomic(
            &sidecar_path,
            &ProjectSidecar {
                title,
                created: Utc::now().to_rfc3339(),
                visible: vec![],
                version_prefix: "gen".into(),
                project_id: String::new(),
            },
        )?;
    }
    let dirs = list_dirs(&root)?;
    Ok(dirs.iter().map(|p| as_str(p)).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceOpenResult {
    pub shots: Vec<String>,
    pub sidecar: SequenceSidecar,
}

#[tauri::command]
pub fn sequence_open(sequence_path: String) -> AppResult<SequenceOpenResult> {
    let root = PathBuf::from(&sequence_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {sequence_path}")));
    }
    let sidecar: SequenceSidecar = read_sidecar(&root.join(SEQUENCE_SIDECAR))?;
    let dirs = list_dirs(&root)?;
    let shots = dirs
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n != SRC_DIR && n != SEL_DIR)
                .unwrap_or(false)
        })
        .map(|p| as_str(&p))
        .collect();
    Ok(SequenceOpenResult { shots, sidecar })
}

#[tauri::command]
pub fn sequence_create(project_path: String, name: String) -> AppResult<String> {
    let target = PathBuf::from(&project_path).join(sanitize(&name));
    ensure_dir(&target)?;
    let sidecar_path = target.join(SEQUENCE_SIDECAR);
    if !sidecar_path.exists() {
        write_sidecar_atomic(
            &sidecar_path,
            &SequenceSidecar {
                name: name.clone(),
                prompt_history: vec![],
                ..Default::default()
            },
        )?;
    }
    Ok(as_str(&target))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotOpenResult {
    pub columns: Vec<GalleryColumn>,
    pub sidecar: ShotSidecar,
}

#[tauri::command]
pub async fn shot_open(shot_path: String) -> AppResult<ShotOpenResult> {
    run_blocking(move || {
        let root = PathBuf::from(&shot_path);
        if !root.is_dir() {
            return Err(AppError::Msg(format!("not a directory: {shot_path}")));
        }
        let sidecar: ShotSidecar = read_sidecar(&root.join(SHOT_SIDECAR))?;
        let columns = scan_shot_columns(&root)?;
        Ok(ShotOpenResult { columns, sidecar })
    })
    .await
}

#[tauri::command]
pub fn shot_create(sequence_path: String, name: String) -> AppResult<String> {
    let target = PathBuf::from(&sequence_path).join(sanitize(&name));
    ensure_dir(&target)?;
    let prefix = version_prefix_for(&target);
    ensure_dir(&target.join(format!("{}001", prefix)))?;
    ensure_dir(&target.join(SRC_DIR))?;
    let sidecar_path = target.join(SHOT_SIDECAR);
    if !sidecar_path.exists() {
        write_sidecar_atomic(
            &sidecar_path,
            &ShotSidecar {
                name,
                prompt_history: vec![],
                clip_media_path: None,
                version_selects: Default::default(),
                version_comments: Default::default(),
                ..Default::default()
            },
        )?;
    }
    Ok(as_str(&target))
}

// ---------- Versions ----------

#[tauri::command]
pub fn version_create_next(shot_path: String) -> AppResult<String> {
    let root = PathBuf::from(&shot_path);
    let next = next_version_name(&root);
    ensure_dir(&root.join(&next))?;
    Ok(next)
}

/// Read-modify-write helper for the common shot-sidecar-field-update shape:
/// validate the shot dir exists, load the sidecar, apply `mutate`, persist,
/// and hand back the updated sidecar for callers that want it.
pub(crate) fn with_shot_sidecar(
    shot_path: &str,
    mutate: impl FnOnce(&mut ShotSidecar),
) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    mutate(&mut sidecar);
    write_sidecar_atomic(&path, &sidecar)?;
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_version_select_set(
    shot_path: String,
    version: String,
    filename: Option<String>,
) -> AppResult<ShotSidecar> {
    with_shot_sidecar(&shot_path, |sidecar| match filename {
        Some(f) if !f.is_empty() => {
            sidecar.version_selects.insert(version, f);
        }
        _ => {
            sidecar.version_selects.remove(&version);
        }
    })
}

// ---------- Project script ----------

const SCRIPT_FILE: &str = "script.md";
const DEFAULT_SCRIPT: &str = "# Sequence 1\n\n## Shot 1\n\n## Shot 2\n\n## Shot 3\n";

#[tauri::command]
pub fn script_read(project_path: String) -> AppResult<String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let p = root.join(SCRIPT_FILE);
    if !p.exists() {
        std::fs::write(&p, DEFAULT_SCRIPT)?;
        return Ok(DEFAULT_SCRIPT.to_string());
    }
    Ok(std::fs::read_to_string(&p)?)
}

#[tauri::command]
pub fn script_write(project_path: String, content: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    std::fs::write(root.join(SCRIPT_FILE), content)?;
    Ok(())
}

// ---------- Misc dirs ----------

#[tauri::command]
pub fn dir_ensure(path: String) -> AppResult<()> {
    ensure_dir(&PathBuf::from(path))
}

#[tauri::command]
pub fn dirs_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).is_dir()).collect()
}

// ---------- Project / shot sidecar fields ----------

/// Read the project's configured version-folder prefix (defaults to "gen"
/// for projects without the field set).
#[tauri::command]
pub fn project_version_prefix_get(project_path: String) -> AppResult<String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let sidecar: ProjectSidecar = read_sidecar(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
    Ok(if sidecar.version_prefix.is_empty() {
        "gen".into()
    } else {
        sidecar.version_prefix
    })
}

/// Set the project's version-folder prefix. Accepts ASCII letters plus `_`/`-`
/// only (must start with a letter). Existing folders are not renamed; only
/// newly-minted version folders use the new prefix.
#[tauri::command]
pub fn project_version_prefix_set(project_path: String, prefix: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let trimmed = prefix.trim().to_string();
    let valid = !trimmed.is_empty()
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-');
    if !valid {
        return Err(AppError::Msg(
            "Prefix must start with a letter and contain only letters, `_`, or `-`.".into(),
        ));
    }
    let path = root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_sidecar(&path)?;
    sidecar.version_prefix = trimmed;
    write_sidecar_atomic(&path, &sidecar)
}

/// Read the project's stable identity UUID. Returns `None` for a project
/// that hasn't been assigned one yet — the caller (sessionStore) mints one
/// with `crypto.randomUUID()` and persists it via `project_id_set`, keeping
/// ID generation on the TS side consistent with every other id in the app.
#[tauri::command]
pub fn project_id_get(project_path: String) -> AppResult<Option<String>> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let sidecar: ProjectSidecar = read_sidecar(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
    Ok(if sidecar.project_id.is_empty() {
        None
    } else {
        Some(sidecar.project_id)
    })
}

#[tauri::command]
pub fn project_id_set(project_path: String, project_id: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let path = root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_sidecar(&path)?;
    sidecar.project_id = project_id;
    write_sidecar_atomic(&path, &sidecar)
}

#[tauri::command]
pub fn shot_clip_media_set(shot_path: String, media_path: Option<String>) -> AppResult<()> {
    with_shot_sidecar(&shot_path, |sidecar| {
        sidecar.clip_media_path = media_path;
    })
    .map(drop)
}

/// Set or clear the short comment associated with a version folder. Trimmed
/// empty input removes the entry; the version folder itself is never renamed.
#[tauri::command]
pub fn shot_version_comment_set(
    shot_path: String,
    version: String,
    comment: Option<String>,
) -> AppResult<()> {
    with_shot_sidecar(&shot_path, |sidecar| {
        let trimmed = comment.unwrap_or_default().trim().to_string();
        if trimmed.is_empty() {
            sidecar.version_comments.remove(&version);
        } else {
            sidecar.version_comments.insert(version, trimmed);
        }
    })
    .map(drop)
}
