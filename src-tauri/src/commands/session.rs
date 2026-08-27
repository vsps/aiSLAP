//! Project / sequence / shot lifecycle: open, create, version allocation,
//! the project script, and per-shot sidecar fields. Rename (with its sidecar
//! path cascade) lives in `rename.rs`; prompt-history appends live in
//! `prompt_history.rs`.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use crate::commands::fsutil::{
    as_str, highest_version_number, list_dirs, next_version_name, require_dir, sanitize,
    VersionNaming, PROJECT_SIDECAR, SEL_DIR, SEQUENCE_SIDECAR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::gallery::{scan_shot_columns, tag_index_for};
use crate::commands::prism;
use crate::domain::{GalleryColumn, ProjectSidecar, SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{ensure_dir, read_json_or_default, read_json_strict, write_json_atomic};

// ---------- Project / sequence / shot open + create ----------

/// Open a project and list its sequences.
///
/// `entity_type` ("shot" | "asset") only matters for PRISM projects, where
/// sequences live under `03_Production/Shots` or `03_Production/Assets` rather
/// than directly in the project folder.
#[tauri::command]
pub fn project_open(project_path: String, entity_type: Option<String>) -> AppResult<Vec<String>> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    // Reject folders that are clearly sequences or shots, not projects.
    if root.join(SEQUENCE_SIDECAR).exists() || root.join(SHOT_SIDECAR).exists() {
        return Err(AppError::Msg("NOT A PROJECT FOLDER".into()));
    }
    let prism = prism::detect(&root);
    // Auto-create project.json on first open (new project or migration).
    let sidecar_path = root.join(PROJECT_SIDECAR);
    if !sidecar_path.exists() {
        let title = prism
            .as_ref()
            .map(|l| l.project_name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| folder_title(&root));
        write_json_atomic(
            &sidecar_path,
            &ProjectSidecar {
                title,
                created: Utc::now().to_rfc3339(),
                // PRISM's versionFormat is "v#" — match it so aiSLAP's version
                // folders read like the rest of the pipeline's.
                version_prefix: if prism.is_some() { "v" } else { "gen" }.into(),
                // A brand-new project has nothing to convert.
                tags_migrated: true,
                ..Default::default()
            },
        )?;
    }
    let dirs = match &prism {
        // The asset tree has no fixed depth — categories and assets sit at the
        // same level — so its "sequences" are resolved rather than listed.
        Some(layout) if entity_type.as_deref() == Some("asset") => {
            prism::asset_sequences(&layout.entity_root(Some("asset")))?
        }
        Some(layout) => list_dirs(&layout.entity_root(entity_type.as_deref()))?
            .into_iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n != SRC_DIR && n != SEL_DIR && !n.starts_with('_'))
            })
            .collect(),
        None => list_dirs(&root)?,
    };
    Ok(dirs.iter().map(|p| as_str(p)).collect())
}

fn folder_title(root: &Path) -> String {
    root.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string()
}

/// Human-readable project name: a PRISM project's `pipeline.json`
/// `globals.project_name` when set, else the folder name. Live-derived —
/// same reasoning as `project_version_prefix_get` — rather than trusting the
/// `title` stored in `project.json` at creation time, so a later pipeline.json
/// edit is picked up immediately instead of going stale.
///
/// The frontend derives the same value itself (it already has `prism` from
/// `prism_detect`, plus the folder path) rather than round-tripping through a
/// command; this copy is what `db::sync_outbox` mirrors into the `projects`
/// table, so the two must stay in lockstep.
pub(crate) fn project_title_for(root: &Path) -> String {
    prism::detect(root)
        .map(|l| l.project_name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder_title(root))
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
    require_dir(&root)?;
    let sidecar: SequenceSidecar = read_json_or_default(&root.join(SEQUENCE_SIDECAR))?;
    let layout = prism::layout_for(&root);
    let shots: Vec<String> = match &layout {
        // Asset tree: only real asset entities, so a category sitting beside
        // them (or an old output folder inside one) isn't offered as an asset.
        Some(l) if prism::is_in_asset_tree(l, &root) => prism::asset_entities_in(&root)?
            .iter()
            .map(|p| as_str(p))
            .collect(),
        // Shot tree: every dir except SRC/SEL and PRISM's `_sequence`
        // pseudo-entity. Not gated on entity markers — a shot PRISM just
        // created is legitimately empty.
        _ => {
            let skip_underscore = layout.is_some();
            list_dirs(&root)?
                .into_iter()
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| {
                            n != SRC_DIR && n != SEL_DIR && !(skip_underscore && n.starts_with('_'))
                        })
                        .unwrap_or(false)
                })
                .map(|p| as_str(&p))
                .collect()
        }
    };
    Ok(SequenceOpenResult { shots, sidecar })
}

/// PRISM owns entity creation (it writes pipeline metadata aiSLAP knows
/// nothing about), so aiSLAP only ever creates the `Renders/2dRender/AI` root
/// inside an entity that already exists. The UI greys these out; this is the
/// backstop.
fn reject_if_prism(path: &Path) -> AppResult<()> {
    if prism::detect(path).is_some() || prism::layout_for(path).is_some() {
        return Err(AppError::Msg(
            "sequences and shots are managed by PRISM — create it in PRISM first".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn sequence_create(project_path: String, name: String) -> AppResult<String> {
    reject_if_prism(&PathBuf::from(&project_path))?;
    let target = PathBuf::from(&project_path).join(sanitize(&name));
    ensure_dir(&target)?;
    let sidecar_path = target.join(SEQUENCE_SIDECAR);
    if !sidecar_path.exists() {
        write_json_atomic(
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
    let index = tag_index_for(&PathBuf::from(&shot_path)).await;
    run_blocking(move || {
        let root = PathBuf::from(&shot_path);
        require_dir(&root)?;
        let sidecar: ShotSidecar = read_json_or_default(&root.join(SHOT_SIDECAR))?;
        let columns = scan_shot_columns(&root, &index)?;
        Ok(ShotOpenResult { columns, sidecar })
    })
    .await
}

#[tauri::command]
pub fn shot_create(sequence_path: String, name: String) -> AppResult<String> {
    reject_if_prism(&PathBuf::from(&sequence_path))?;
    let target = PathBuf::from(&sequence_path).join(sanitize(&name));
    ensure_dir(&target)?;
    // next_version_name, not a hardcoded "001" — it carries the project's
    // prefix *and* its digit padding.
    ensure_dir(&target.join(next_version_name(&target)))?;
    ensure_dir(&target.join(SRC_DIR))?;
    let sidecar_path = target.join(SHOT_SIDECAR);
    if !sidecar_path.exists() {
        write_json_atomic(
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

/// Allocate and create the next version folder, atomically enough that two
/// callers can't be handed the same name.
///
/// `create_dir` (not `create_dir_all`) is the mechanism: it fails with
/// `AlreadyExists` instead of quietly succeeding on a directory that is already
/// there, which turns this from a guess into a claim. Two tabs generating into
/// the same shot — now reachable, since each tab holds its own session — each
/// walk forward until one wins an unused name, rather than both being told
/// "v004" and writing into one folder.
#[tauri::command]
pub fn version_create_next(shot_path: String) -> AppResult<String> {
    let root = PathBuf::from(&shot_path);
    require_dir(&root)?;
    let naming = VersionNaming::for_path(&root);
    let start = highest_version_number(&root).unwrap_or(0) + 1;
    // Bounded so a permission error that reports as AlreadyExists can't spin
    // forever; 512 past the current high-water mark is far beyond any real
    // contention (the loop only advances when a folder genuinely exists).
    for n in start..start.saturating_add(512) {
        let name = naming.name(n);
        match std::fs::create_dir(root.join(&name)) {
            Ok(()) => return Ok(name),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Msg(format!(
        "could not allocate a version folder under {shot_path}"
    )))
}

/// Read-modify-write helper for the common shot-sidecar-field-update shape:
/// validate the shot dir exists, load the sidecar, apply `mutate`, persist,
/// and hand back the updated sidecar for callers that want it.
pub(crate) fn with_shot_sidecar(
    shot_path: &str,
    mutate: impl FnOnce(&mut ShotSidecar),
) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(shot_path);
    require_dir(&root)?;
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_json_or_default(&path)?;
    mutate(&mut sidecar);
    write_json_atomic(&path, &sidecar)?;
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
    require_dir(&root)?;
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
    require_dir(&root)?;
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

/// The version-folder prefix actually in use: the pipeline's `versionFormat`
/// for a PRISM project, else the project's configured prefix (default "gen").
#[tauri::command]
pub fn project_version_prefix_get(project_path: String) -> AppResult<String> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    if let Some(layout) = prism::detect(&root) {
        return Ok(layout.version_prefix);
    }
    let sidecar: ProjectSidecar =
        read_json_or_default(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
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
    require_dir(&root)?;
    // A PRISM project's version naming comes from pipeline.json, so accepting a
    // prefix here would store a value nothing reads.
    if prism::detect(&root).is_some() {
        return Err(AppError::Msg(
            "PRISM projects follow the pipeline's versionFormat — set it in PRISM".into(),
        ));
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
    // Strict: this rewrites the whole sidecar, so defaulting on a corrupt read
    // would discard the project id and tag vocabulary along with it.
    let path = root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_json_strict(&path)?.unwrap_or_default();
    sidecar.version_prefix = trimmed;
    write_json_atomic(&path, &sidecar)
}

/// Read the project's stable identity UUID. Returns `None` for a project
/// that hasn't been assigned one yet — the caller (sessionStore) mints one
/// with `crypto.randomUUID()` and persists it via `project_id_set`, keeping
/// ID generation on the TS side consistent with every other id in the app.
#[tauri::command]
pub fn project_id_get(project_path: String) -> AppResult<Option<String>> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    let sidecar: ProjectSidecar =
        read_json_or_default(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
    Ok(if sidecar.project_id.is_empty() {
        None
    } else {
        Some(sidecar.project_id)
    })
}

#[tauri::command]
pub fn project_id_set(project_path: String, project_id: String) -> AppResult<()> {
    let root = PathBuf::from(&project_path);
    require_dir(&root)?;
    // Strict, as above — and doubly so here: a default read would also blank
    // any existing id, and the local index is keyed by it.
    let path = root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_json_strict(&path)?.unwrap_or_default();
    sidecar.project_id = project_id;
    write_json_atomic(&path, &sidecar)
}

#[tauri::command]
pub fn shot_clip_media_set(shot_path: String, media_path: Option<String>) -> AppResult<()> {
    with_shot_sidecar(&shot_path, |sidecar| {
        sidecar.clip_media_path = media_path;
    })
    .map(drop)
}

/// Serializes `<minor>` ordinal allocation.
///
/// Up to `DEFAULT_MAX_CONCURRENT_JOBS` generations run at once and two of them
/// can target the same version folder. Allocation is a read-modify-write of one
/// `shot.json`; interleaved, two callers would be handed the same ordinal — and
/// the download path overwrites rather than erroring, so the collision would
/// destroy a file rather than surface.
static MINOR_ALLOC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A generation writing `count` files into `version` gets its ordinals here.
///
/// The counter is monotonic and lives in `shot.json` beside `version_comments`:
/// trashing a file never frees its number, which is what "next highest, never
/// falls into a gap" means. Files that predate the token carry no ordinal at
/// all, so a counter starting from zero cannot collide with them.
#[tauri::command]
pub async fn shot_version_minor_next(
    shot_path: String,
    version: String,
    count: u32,
) -> AppResult<Vec<u32>> {
    // Clamped: a bogus count would inflate the counter permanently, and no
    // real provider response is anywhere near this size.
    let count = count.min(256);
    run_blocking(move || {
        let _guard = MINOR_ALLOC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut issued = Vec::with_capacity(count as usize);
        with_shot_sidecar(&shot_path, |sidecar| {
            let next = sidecar.minor_counters.entry(version).or_insert(0);
            for _ in 0..count {
                *next += 1;
                issued.push(*next);
            }
        })?;
        Ok(issued)
    })
    .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestProject;

    /// Ordinals are handed out in an unbroken run, keep going across calls
    /// (that's the "never falls into a gap" property), and each version folder
    /// counts on its own.
    #[tokio::test]
    async fn minor_ordinals_are_monotonic_and_per_version() {
        let project = TestProject::new("minor");
        let shot = as_str(&project.dir("SQ01/sh010"));

        let first = shot_version_minor_next(shot.clone(), "v003".into(), 4)
            .await
            .unwrap();
        assert_eq!(first, vec![1, 2, 3, 4]);

        let second = shot_version_minor_next(shot.clone(), "v003".into(), 2)
            .await
            .unwrap();
        assert_eq!(second, vec![5, 6], "the counter never restarts");

        let other = shot_version_minor_next(shot.clone(), "v004".into(), 1)
            .await
            .unwrap();
        assert_eq!(other, vec![1], "a different column counts independently");

        // It survives a reload — the counter lives in shot.json, not memory.
        let sidecar: ShotSidecar =
            read_json_or_default(&project.root.join("SQ01/sh010").join(SHOT_SIDECAR)).unwrap();
        assert_eq!(sidecar.minor_counters.get("v003"), Some(&6));
        assert_eq!(sidecar.minor_counters.get("v004"), Some(&1));
    }
}
