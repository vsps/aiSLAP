use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use crate::domain::{
    GalleryColumn, GalleryImage, ProjectSidecar, PromptEntry, SequenceSidecar, SequenceTimeline,
    ShotLatestMedia, ShotSidecar,
};
use crate::error::{AppError, AppResult};

const PROJECT_SIDECAR: &str = "project.json";
const SEQUENCE_SIDECAR: &str = "sequence.json";
const SHOT_SIDECAR: &str = "shot.json";
const TIMELINE_SIDECAR: &str = "timeline.json";
const SRC_DIR: &str = "SRC";

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm"];

// ---------- Helpers ----------

fn as_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn is_version_name(name: &str) -> bool {
    name.len() == 4 && name.starts_with('v') && name[1..].chars().all(|c| c.is_ascii_digit())
}

fn read_sidecar<T: serde::de::DeserializeOwned + Default>(path: &Path) -> AppResult<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let text = std::fs::read_to_string(path)?;
    match serde_json::from_str::<T>(&text) {
        Ok(v) => Ok(v),
        Err(_) => Ok(T::default()),
    }
}

fn write_sidecar_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn ensure_dir(path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

/// Walk up the parent chain and return the *topmost* ancestor that contains a
/// `project.json`. Going to the top (rather than stopping at the first hit)
/// protects against orphan sidecars accidentally left inside a project — e.g.,
/// from a folder that was once opened as a standalone project.
fn project_root_for(path: &Path) -> AppResult<PathBuf> {
    let mut found: Option<PathBuf> = None;
    let mut cur: Option<&Path> = Some(path);
    while let Some(p) = cur {
        if p.join(PROJECT_SIDECAR).is_file() {
            found = Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    found.ok_or_else(|| AppError::Msg(format!("no project root for {}", as_str(path))))
}

/// Forward-slash path relative to project root. Returns None if `path` is not
/// underneath `project_root`.
fn relativize(path: &Path, project_root: &Path) -> Option<String> {
    let p = path.canonicalize().ok().unwrap_or_else(|| path.to_path_buf());
    let r = project_root
        .canonicalize()
        .ok()
        .unwrap_or_else(|| project_root.to_path_buf());
    let stripped = p.strip_prefix(&r).ok()?;
    Some(as_str(stripped))
}

fn load_visible_set(project_root: &Path) -> AppResult<HashSet<String>> {
    let sidecar: ProjectSidecar = read_sidecar(&project_root.join(PROJECT_SIDECAR))?;
    Ok(sidecar.visible.into_iter().collect())
}

fn save_visible_set(project_root: &Path, visible: &HashSet<String>) -> AppResult<()> {
    let path = project_root.join(PROJECT_SIDECAR);
    let mut sidecar: ProjectSidecar = read_sidecar(&path)?;
    let mut v: Vec<String> = visible.iter().cloned().collect();
    v.sort();
    sidecar.visible = v;
    write_sidecar_atomic(&path, &sidecar)
}

/// Rewrite the prefix of every entry in the project's visible set. Entries
/// whose value equals `old_rel` (exact) or starts with `old_rel + "/"` are
/// rewritten to use `new_rel`. Best-effort: no-op if there's no project root.
fn visible_set_rename_prefix(project_root: &Path, old_rel: &str, new_rel: &str) -> AppResult<()> {
    let old_clean = old_rel.trim_end_matches('/').to_string();
    let new_clean = new_rel.trim_end_matches('/').to_string();
    if old_clean == new_clean {
        return Ok(());
    }
    let mut set = load_visible_set(project_root)?;
    let prefix = format!("{}/", old_clean);
    let mut changed = false;
    let entries: Vec<String> = set.iter().cloned().collect();
    for entry in entries {
        if entry == old_clean {
            set.remove(&entry);
            set.insert(new_clean.clone());
            changed = true;
        } else if entry.starts_with(&prefix) {
            set.remove(&entry);
            let suffix = &entry[prefix.len()..];
            set.insert(format!("{}/{}", new_clean, suffix));
            changed = true;
        }
    }
    if changed {
        save_visible_set(project_root, &set)?;
    }
    Ok(())
}

/// Remove an image (or all images under a directory) from the project's visible
/// set. Best-effort: silently skips if the path is outside any project.
pub fn visible_set_remove_path_or_prefix(path: &Path, is_dir_prefix: bool) -> AppResult<()> {
    let root = match project_root_for(path) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let target = match path
        .strip_prefix(&root)
        .ok()
        .map(as_str)
        .or_else(|| relativize(path, &root))
    {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut set = load_visible_set(&root)?;
    let before = set.len();
    if is_dir_prefix {
        let prefix = format!("{}/", target.trim_end_matches('/'));
        set.retain(|p| !p.starts_with(&prefix));
    } else {
        set.remove(&target);
    }
    if set.len() != before {
        save_visible_set(&root, &set)?;
    }
    Ok(())
}

fn list_dirs(root: &Path) -> AppResult<Vec<PathBuf>> {
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<_> = std::fs::read_dir(root)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            // Skip hidden + system dirs.
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.') && !n.starts_with('$'))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    Ok(out)
}

// ---------- Commands ----------

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
                .map(|n| n != SRC_DIR)
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
pub fn shot_open(shot_path: String) -> AppResult<ShotOpenResult> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let sidecar: ShotSidecar = read_sidecar(&root.join(SHOT_SIDECAR))?;
    let columns = scan_shot_columns(&root)?;
    Ok(ShotOpenResult { columns, sidecar })
}

#[tauri::command]
pub fn shot_rescan(shot_path: String) -> AppResult<Vec<GalleryColumn>> {
    let root = PathBuf::from(&shot_path);
    scan_shot_columns(&root)
}

#[tauri::command]
pub fn shot_create(sequence_path: String, name: String) -> AppResult<String> {
    let target = PathBuf::from(&sequence_path).join(sanitize(&name));
    ensure_dir(&target)?;
    ensure_dir(&target.join("v001"))?;
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
            },
        )?;
    }
    Ok(as_str(&target))
}

/// Recursively walk every `*.json` file under `dir`, invoking `cb` with each path.
/// Errors from a single file are surfaced (no swallowing) — callers can choose
/// to wrap with `.ok()` if best-effort semantics are wanted.
fn walk_json_files(dir: &Path, cb: &mut dyn FnMut(&Path) -> AppResult<()>) -> AppResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            walk_json_files(&p, cb)?;
        } else if p.extension().and_then(|s| s.to_str()) == Some("json") {
            cb(&p)?;
        }
    }
    Ok(())
}

/// Recursively rewrite any string value in `v` whose contents start with
/// `old_prefix + "/"` (or equal `old_prefix` exactly) to use `new_prefix`.
/// Returns true if anything changed.
fn rewrite_paths_in_value(
    v: &mut serde_json::Value,
    old_prefix: &str,
    new_prefix: &str,
) -> bool {
    let mut changed = false;
    match v {
        serde_json::Value::String(s) => {
            if s == old_prefix {
                *s = new_prefix.to_string();
                changed = true;
            } else if s.starts_with(old_prefix)
                && s.as_bytes().get(old_prefix.len()) == Some(&b'/')
            {
                *s = format!("{}{}", new_prefix, &s[old_prefix.len()..]);
                changed = true;
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                if rewrite_paths_in_value(item, old_prefix, new_prefix) {
                    changed = true;
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                if rewrite_paths_in_value(val, old_prefix, new_prefix) {
                    changed = true;
                }
            }
        }
        _ => {}
    }
    changed
}

/// Walk every `*.json` under `root` and prefix-rewrite any absolute-path strings.
/// Files that don't parse as JSON are skipped. Files that don't change are not
/// rewritten. `old_prefix` / `new_prefix` should be forward-slash absolute paths
/// without trailing slashes (the standard format `as_str` produces).
fn rewrite_path_strings_in_subtree(
    root: &Path,
    old_prefix: &str,
    new_prefix: &str,
) -> AppResult<()> {
    walk_json_files(root, &mut |path| {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => return Ok(()),
        };
        let mut value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        if rewrite_paths_in_value(&mut value, old_prefix, new_prefix) {
            let bytes = serde_json::to_vec_pretty(&value)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, path)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn sequence_rename(sequence_path: String, new_name: String) -> AppResult<String> {
    rename_subtree(&sequence_path, &new_name, /* is_sequence */ true)
}

#[tauri::command]
pub fn shot_rename(shot_path: String, new_name: String) -> AppResult<String> {
    rename_subtree(&shot_path, &new_name, /* is_sequence */ false)
}

fn rename_subtree(old_path: &str, new_name: &str, is_sequence: bool) -> AppResult<String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Msg("New name cannot be empty.".into()));
    }
    let sanitized = sanitize(trimmed);
    if sanitized.is_empty() {
        return Err(AppError::Msg("New name has no usable characters.".into()));
    }
    let old = PathBuf::from(old_path);
    if !old.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {old_path}")));
    }
    let current_base = old
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if sanitized == current_base {
        // No-op rename — return the existing path so callers can navigate uniformly.
        return Ok(as_str(&old));
    }
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Msg(format!("no parent for {old_path}")))?;
    let new_path = parent.join(&sanitized);
    if new_path.exists() {
        return Err(AppError::Msg(format!(
            "A folder named '{sanitized}' already exists."
        )));
    }

    let old_prefix = as_str(&old);
    let new_prefix = as_str(&new_path);

    // The Rust-side rename. Atomic on the same filesystem.
    std::fs::rename(&old, &new_path)?;

    // 1) Update the renamed folder's own sidecar `name` field. Best-effort —
    //    if the sidecar is missing or unreadable we still want the rename to
    //    succeed; the user can fix it later.
    if is_sequence {
        let sidecar_path = new_path.join(SEQUENCE_SIDECAR);
        if let Ok(mut sidecar) = read_sidecar::<SequenceSidecar>(&sidecar_path) {
            sidecar.name = trimmed.to_string();
            let _ = write_sidecar_atomic(&sidecar_path, &sidecar);
        }
    } else {
        let sidecar_path = new_path.join(SHOT_SIDECAR);
        if let Ok(mut sidecar) = read_sidecar::<ShotSidecar>(&sidecar_path) {
            sidecar.name = trimmed.to_string();
            let _ = write_sidecar_atomic(&sidecar_path, &sidecar);
        }
    }

    // 2) Cascade-rewrite every absolute path inside JSON sidecars under the
    //    renamed subtree (shot.json clip_media_path, timeline.json clip
    //    shotPaths, image metadata sidecars).
    rewrite_path_strings_in_subtree(&new_path, &old_prefix, &new_prefix)?;

    // 3) Rewrite the project.json visible[] prefix entries.
    if let Ok(project_root) = project_root_for(&new_path) {
        if let (Some(old_rel), Some(new_rel)) = (
            old.strip_prefix(&project_root).ok().map(as_str),
            new_path.strip_prefix(&project_root).ok().map(as_str),
        ) {
            let _ = visible_set_rename_prefix(&project_root, &old_rel, &new_rel);
        }
    }

    Ok(new_prefix)
}

fn scan_shot_columns(root: &Path) -> AppResult<Vec<GalleryColumn>> {
    let mut cols: Vec<GalleryColumn> = Vec::new();
    let project_root = project_root_for(root).ok();
    let visible = project_root
        .as_ref()
        .map(|r| load_visible_set(r))
        .transpose()?
        .unwrap_or_default();

    // Include the project-level SRC as "GLOBAL SRC" (shot → seq → project).
    if let Some(project) = root.parent().and_then(|s| s.parent()) {
        let global_src = project.join(SRC_DIR);
        if global_src.is_dir() {
            let images = scan_directory_images(&global_src, project_root.as_deref(), &visible)?;
            cols.push(GalleryColumn {
                id: as_str(&global_src),
                version: "GLOBAL SRC".to_string(),
                is_src: true,
                images,
                timestamp: None,
                model_name: None,
            });
        }
    }

    // Scan all subdirectories as version columns (including any legacy SRC folders).
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let images = scan_directory_images(&p, project_root.as_deref(), &visible)?;
        cols.push(GalleryColumn {
            id: name.clone(),
            version: name,
            is_src: false,
            images,
            timestamp: None,
            model_name: None,
        });
    }

    cols.sort_by(|a, b| match (a.is_src, b.is_src) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.version.cmp(&b.version),
    });
    Ok(cols)
}

fn scan_directory_images(
    dir: &Path,
    project_root: Option<&Path>,
    visible: &HashSet<String>,
) -> AppResult<Vec<GalleryImage>> {
    let mut out: Vec<GalleryImage> = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let entry = e?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip `.thumb.png` — it's an adjunct of a video.
        if filename.ends_with(".thumb.png") {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let is_image = IMAGE_EXTS.iter().any(|e| *e == ext);
        let is_video = VIDEO_EXTS.iter().any(|e| *e == ext);
        if !is_image && !is_video {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let meta_path = path.with_file_name(format!("{stem}.json"));
        let thumb_path = if is_video {
            let t = path.with_file_name(format!("{stem}.thumb.png"));
            if t.exists() {
                Some(as_str(&t))
            } else {
                None
            }
        } else {
            None
        };
        let starred = project_root
            .and_then(|r| relativize(&path, r))
            .map(|rel| visible.contains(&rel));
        out.push(GalleryImage {
            filename,
            path: as_str(&path),
            metadata_path: as_str(&meta_path),
            is_video,
            thumb_path,
            starred,
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub fn version_create_next(shot_path: String) -> AppResult<String> {
    let root = PathBuf::from(&shot_path);
    let mut max_n = 0u32;
    if let Ok(it) = std::fs::read_dir(&root) {
        for e in it.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if is_version_name(name) {
                    if let Ok(n) = name[1..].parse::<u32>() {
                        if n > max_n {
                            max_n = n;
                        }
                    }
                }
            }
        }
    }
    let next = format!("v{:03}", max_n + 1);
    ensure_dir(&root.join(&next))?;
    Ok(next)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionStack {
    pub version: String,
    pub images: Vec<GalleryImage>,
    pub selected_filename: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotStack {
    pub shot_path: String,
    pub shot_name: String,
    pub versions: Vec<VersionStack>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub clip_media_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceStacks {
    pub global_src_images: Vec<GalleryImage>,
    pub shots: Vec<ShotStack>,
}

#[tauri::command]
pub fn sequence_stacks_scan(sequence_path: String) -> AppResult<SequenceStacks> {
    let seq_root = PathBuf::from(&sequence_path);
    if !seq_root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {sequence_path}")));
    }

    let project_root = project_root_for(&seq_root).ok();
    let visible = project_root
        .as_ref()
        .map(|r| load_visible_set(r))
        .transpose()?
        .unwrap_or_default();

    // Project-level GLOBAL SRC.
    let global_src_images = match project_root.as_ref() {
        Some(root) => {
            let global_src = root.join(SRC_DIR);
            if global_src.is_dir() {
                scan_directory_images(&global_src, project_root.as_deref(), &visible)?
            } else {
                vec![]
            }
        }
        None => vec![],
    };

    // Walk shots in this sequence.
    let mut shots: Vec<ShotStack> = Vec::new();
    let shot_dirs = list_dirs(&seq_root)?;
    for shot_dir in shot_dirs {
        let shot_name = match shot_dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if shot_name == SRC_DIR {
            continue;
        }

        let sidecar: ShotSidecar = read_sidecar(&shot_dir.join(SHOT_SIDECAR))?;

        let mut versions: Vec<VersionStack> = Vec::new();
        for v_dir in list_dirs(&shot_dir)? {
            let vname = match v_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if vname == SRC_DIR {
                continue;
            }
            let images = scan_directory_images(&v_dir, project_root.as_deref(), &visible)?;
            // Resolve the select:
            //   pinned + file still exists → use it
            //   else → last image in the sorted array (the "latest")
            let pinned = sidecar.version_selects.get(&vname).cloned();
            let resolved = pinned
                .filter(|p| images.iter().any(|i| &i.filename == p))
                .or_else(|| images.last().map(|i| i.filename.clone()))
                .unwrap_or_default();
            versions.push(VersionStack {
                version: vname,
                images,
                selected_filename: resolved,
            });
        }
        versions.sort_by(|a, b| a.version.cmp(&b.version));

        shots.push(ShotStack {
            shot_path: as_str(&shot_dir),
            shot_name,
            versions,
            clip_media_path: sidecar.clip_media_path.clone(),
        });
    }
    shots.sort_by(|a, b| a.shot_name.cmp(&b.shot_name));

    Ok(SequenceStacks {
        global_src_images,
        shots,
    })
}

#[tauri::command]
pub fn shot_version_select_set(
    shot_path: String,
    version: String,
    filename: Option<String>,
) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let sidecar_path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&sidecar_path)?;
    match filename {
        Some(f) if !f.is_empty() => {
            sidecar.version_selects.insert(version, f);
        }
        _ => {
            sidecar.version_selects.remove(&version);
        }
    }
    write_sidecar_atomic(&sidecar_path, &sidecar)?;
    Ok(sidecar)
}

/// Move every image file (plus its sidecar/thumb) from `src_shot/src_version/`
/// into `dst_shot/dst_version/`. When `dst_version` is None or empty, the
/// next version on `dst_shot` is allocated.
/// Returns the destination version's absolute path.
#[tauri::command]
pub fn version_stack_move(
    src_shot: String,
    src_version: String,
    dst_shot: String,
    dst_version: Option<String>,
) -> AppResult<String> {
    let src_dir = PathBuf::from(&src_shot).join(&src_version);
    if !src_dir.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {}", as_str(&src_dir))));
    }

    let dst_root = PathBuf::from(&dst_shot);
    let dst_version_name = match dst_version {
        Some(v) if !v.is_empty() => v,
        _ => {
            let mut max_n = 0u32;
            if let Ok(it) = std::fs::read_dir(&dst_root) {
                for e in it.flatten() {
                    if let Some(name) = e.file_name().to_str() {
                        if is_version_name(name) {
                            if let Ok(n) = name[1..].parse::<u32>() {
                                if n > max_n {
                                    max_n = n;
                                }
                            }
                        }
                    }
                }
            }
            format!("v{:03}", max_n + 1)
        }
    };
    let dst_dir = dst_root.join(&dst_version_name);
    ensure_dir(&dst_dir)?;

    let same = match (src_dir.canonicalize(), dst_dir.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return Ok(as_str(&dst_dir));
    }

    // Collect the media files (skip thumbs/json — they move as siblings).
    let mut moves: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(&src_dir)? {
        let entry = e?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let filename = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if filename.ends_with(".thumb.png") {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let is_media = IMAGE_EXTS.iter().any(|e| *e == ext) || VIDEO_EXTS.iter().any(|e| *e == ext);
        if !is_media {
            continue;
        }
        moves.push(p);
    }

    // Capture rel paths before the source files disappear, so we can update the
    // visible set after the moves succeed.
    let project_root = project_root_for(&dst_dir).ok();
    let mut rel_pairs: Vec<(String, String)> = Vec::new();
    if let Some(root) = project_root.as_ref() {
        for src in &moves {
            let filename = match src.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let src_rel = src
                .strip_prefix(root)
                .ok()
                .map(as_str)
                .or_else(|| relativize(src, root));
            let dst_abs = dst_dir.join(&filename);
            let dst_rel = dst_abs
                .strip_prefix(root)
                .ok()
                .map(as_str)
                .or_else(|| relativize(&dst_abs, root));
            if let (Some(s), Some(d)) = (src_rel, dst_rel) {
                rel_pairs.push((s, d));
            }
        }
    }

    for src in &moves {
        move_triple_to_dir(src, &dst_dir)?;
    }

    // Update visible set, re-keying any moved files that were marked visible.
    if let Some(root) = project_root.as_ref() {
        let mut set = load_visible_set(root)?;
        let mut changed = false;
        for (s, d) in &rel_pairs {
            if set.remove(s) {
                set.insert(d.clone());
                changed = true;
            }
        }
        if changed {
            save_visible_set(root, &set)?;
        }
    }

    // Clear the source shot's pinned select for this version.
    let src_sidecar_path = PathBuf::from(&src_shot).join(SHOT_SIDECAR);
    if src_sidecar_path.exists() {
        let mut sidecar: ShotSidecar = read_sidecar(&src_sidecar_path)?;
        if sidecar.version_selects.remove(&src_version).is_some() {
            write_sidecar_atomic(&src_sidecar_path, &sidecar)?;
        }
    }

    Ok(as_str(&dst_dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotStarredGroup {
    pub shot_path: String,
    pub shot_name: String,
    pub images: Vec<GalleryImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqStarredGroup {
    pub seq_path: String,
    pub seq_name: String,
    pub shots: Vec<ShotStarredGroup>,
}

fn make_gallery_image(abs_path: &Path) -> Option<GalleryImage> {
    let filename = abs_path.file_name().and_then(|n| n.to_str())?.to_string();
    if filename.ends_with(".thumb.png") {
        return None;
    }
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let is_image = IMAGE_EXTS.iter().any(|e| *e == ext);
    let is_video = VIDEO_EXTS.iter().any(|e| *e == ext);
    if !is_image && !is_video {
        return None;
    }
    let stem = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let meta_path = abs_path.with_file_name(format!("{stem}.json"));
    let thumb_path = if is_video {
        let t = abs_path.with_file_name(format!("{stem}.thumb.png"));
        if t.exists() { Some(as_str(&t)) } else { None }
    } else {
        None
    };
    Some(GalleryImage {
        filename,
        path: as_str(abs_path),
        metadata_path: as_str(&meta_path),
        is_video,
        thumb_path,
        starred: Some(true),
    })
}

#[tauri::command]
pub fn project_starred_scan(project_path: String) -> AppResult<Vec<SeqStarredGroup>> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {project_path}")));
    }
    let visible = load_visible_set(&root)?;

    // Group by (seq, shot) preserving sorted order.
    use std::collections::BTreeMap;
    type ShotMap = BTreeMap<String, Vec<GalleryImage>>;
    let mut by_seq: BTreeMap<String, ShotMap> = BTreeMap::new();

    for rel in &visible {
        let abs = root.join(rel);
        if !abs.is_file() {
            continue;
        }
        let img = match make_gallery_image(&abs) {
            Some(i) => i,
            None => continue,
        };
        // Expect path layout: <seq>/<shot>/<version>/<file>
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() < 4 {
            continue;
        }
        let seq = parts[0].to_string();
        let shot = parts[1].to_string();
        by_seq.entry(seq).or_default().entry(shot).or_default().push(img);
    }

    let out: Vec<SeqStarredGroup> = by_seq
        .into_iter()
        .map(|(seq_name, shots)| {
            let seq_path = as_str(&root.join(&seq_name));
            let shots: Vec<ShotStarredGroup> = shots
                .into_iter()
                .map(|(shot_name, images)| ShotStarredGroup {
                    shot_path: as_str(&root.join(&seq_name).join(&shot_name)),
                    shot_name,
                    images,
                })
                .collect();
            SeqStarredGroup {
                seq_path,
                seq_name,
                shots,
            }
        })
        .collect();

    Ok(out)
}

#[tauri::command]
pub fn image_set_visible(image_path: String, visible: bool) -> AppResult<()> {
    let p = PathBuf::from(&image_path);
    let root = project_root_for(&p)?;
    let rel = relativize(&p, &root)
        .ok_or_else(|| AppError::Msg("image not under project root".into()))?;
    let mut set = load_visible_set(&root)?;
    if visible {
        set.insert(rel);
    } else {
        set.remove(&rel);
    }
    save_visible_set(&root, &set)
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> AppResult<()> {
    // Use explorer /select directly to avoid canonicalize() turning mapped
    // drive letters (Z:\...) into \\?\UNC\... paths that Explorer rejects.
    let native = path.replace('/', "\\");
    std::process::Command::new("explorer")
        .arg(format!("/select,{native}"))
        .spawn()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

// ---------- Image triple (primary + .json sidecar + .thumb.png) helpers ----------

#[derive(Clone, Copy)]
enum CollisionPolicy {
    Overwrite,
    Error,
}

fn sibling_paths(p: &Path) -> AppResult<(String, String, PathBuf, PathBuf)> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?
        .to_string();
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no filename".into()))?
        .to_string();
    let dir = p
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    let sidecar = dir.join(format!("{stem}.json"));
    let thumb = dir.join(format!("{stem}.thumb.png"));
    Ok((stem, filename, sidecar, thumb))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let na = a.canonicalize().ok();
    let nb = b.canonicalize().ok();
    if let (Some(x), Some(y)) = (na, nb) {
        return x == y;
    }
    as_str(a) == as_str(b)
}

fn copy_triple_to_dir(src: &Path, dest_dir: &Path, policy: CollisionPolicy) -> AppResult<PathBuf> {
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(src))));
    }
    if !dest_dir.is_dir() {
        ensure_dir(dest_dir)?;
    }
    let src_dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    if same_dir(src_dir, dest_dir) {
        return Err(AppError::Msg(
            "source and destination are the same directory".into(),
        ));
    }
    let (_stem, filename, src_sidecar, src_thumb) = sibling_paths(src)?;
    let dest_primary = dest_dir.join(&filename);
    if dest_primary.exists()
        && matches!(policy, CollisionPolicy::Error) {
            return Err(AppError::Msg(format!("FILENAME_EXISTS: {filename}")));
        }
    std::fs::copy(src, &dest_primary)?;
    if src_sidecar.exists() {
        let dest_sidecar = dest_dir.join(src_sidecar.file_name().unwrap());
        if let Err(e) = std::fs::copy(&src_sidecar, &dest_sidecar) {
            eprintln!("sidecar copy failed: {e}");
        }
    }
    if src_thumb.exists() {
        let dest_thumb = dest_dir.join(src_thumb.file_name().unwrap());
        if let Err(e) = std::fs::copy(&src_thumb, &dest_thumb) {
            eprintln!("thumb copy failed: {e}");
        }
    }
    Ok(dest_primary)
}

fn move_one(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            std::fs::copy(src, dest)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn move_triple_to_dir(src: &Path, dest_dir: &Path) -> AppResult<PathBuf> {
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(src))));
    }
    if !dest_dir.is_dir() {
        ensure_dir(dest_dir)?;
    }
    let src_dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    if same_dir(src_dir, dest_dir) {
        return Err(AppError::Msg(
            "source and destination are the same directory".into(),
        ));
    }
    let (_stem, filename, src_sidecar, src_thumb) = sibling_paths(src)?;
    let dest_primary = dest_dir.join(&filename);
    if dest_primary.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {filename}")));
    }
    move_one(src, &dest_primary)?;
    if src_sidecar.exists() {
        let dest_sidecar = dest_dir.join(src_sidecar.file_name().unwrap());
        if let Err(e) = move_one(&src_sidecar, &dest_sidecar) {
            eprintln!("sidecar move failed: {e}");
        }
    }
    if src_thumb.exists() {
        let dest_thumb = dest_dir.join(src_thumb.file_name().unwrap());
        if let Err(e) = move_one(&src_thumb, &dest_thumb) {
            eprintln!("thumb move failed: {e}");
        }
    }
    Ok(dest_primary)
}

fn validate_filename_stem(stem: &str) -> AppResult<()> {
    if stem.is_empty() {
        return Err(AppError::Msg("name is empty".into()));
    }
    for c in stem.chars() {
        if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
            return Err(AppError::Msg(format!("invalid character: {c:?}")));
        }
    }
    let upper = stem.to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&upper.as_str()) {
        return Err(AppError::Msg(format!("reserved name: {stem}")));
    }
    Ok(())
}

#[tauri::command]
pub fn ref_copy_to_global_src(shot_path: String, source_path: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let project_dir = PathBuf::from(&shot_path)
        .parent()
        .and_then(|s| s.parent())
        .ok_or_else(|| AppError::Msg("no project parent".into()))?
        .join(SRC_DIR);
    ensure_dir(&project_dir)?;
    let dest = copy_triple_to_dir(&src, &project_dir, CollisionPolicy::Overwrite)?;
    Ok(as_str(&dest))
}

#[tauri::command]
pub fn image_copy_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = copy_triple_to_dir(&src, &dest, CollisionPolicy::Error)?;
    // If source is visible, mark the copy visible too.
    if let Ok(root) = project_root_for(&src) {
        let src_rel = relativize(&src, &root);
        let dest_rel = relativize(&out, &root);
        if let (Some(s), Some(d)) = (src_rel, dest_rel) {
            let mut set = load_visible_set(&root)?;
            if set.contains(&s) {
                set.insert(d);
                save_visible_set(&root, &set)?;
            }
        }
    }
    Ok(as_str(&out))
}

#[tauri::command]
pub fn image_move_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = move_triple_to_dir(&src, &dest)?;
    // Re-key the visible entry if the source was visible.
    if let Ok(root) = project_root_for(&out) {
        // src no longer exists; relativize against pre-move path string directly.
        let src_rel = src
            .strip_prefix(&root)
            .ok()
            .map(as_str)
            .or_else(|| relativize(&src, &root));
        let dest_rel = relativize(&out, &root);
        if let (Some(s), Some(d)) = (src_rel, dest_rel) {
            let mut set = load_visible_set(&root)?;
            if set.remove(&s) {
                set.insert(d);
                save_visible_set(&root, &set)?;
            }
        }
    }
    Ok(as_str(&out))
}

#[tauri::command]
pub fn image_rename(source_path: String, new_stem: String) -> AppResult<String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {source_path}")));
    }
    let trimmed = new_stem.trim();
    validate_filename_stem(trimmed)?;
    let (old_stem, _filename, old_sidecar, old_thumb) = sibling_paths(&src)?;
    if trimmed == old_stem {
        return Err(AppError::Msg("name unchanged".into()));
    }
    let dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let new_filename = match &ext {
        Some(e) if !e.is_empty() => format!("{trimmed}.{e}"),
        _ => trimmed.to_string(),
    };
    let new_primary = dir.join(&new_filename);
    let new_sidecar = dir.join(format!("{trimmed}.json"));
    let new_thumb = dir.join(format!("{trimmed}.thumb.png"));
    if new_primary.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {new_filename}")));
    }
    if old_sidecar.exists() && new_sidecar.exists() {
        return Err(AppError::Msg(format!(
            "FILENAME_EXISTS: {trimmed}.json"
        )));
    }
    if old_thumb.exists() && new_thumb.exists() {
        return Err(AppError::Msg(format!(
            "FILENAME_EXISTS: {trimmed}.thumb.png"
        )));
    }
    std::fs::rename(&src, &new_primary)?;
    if old_sidecar.exists() {
        if let Err(e) = std::fs::rename(&old_sidecar, &new_sidecar) {
            eprintln!("sidecar rename failed: {e}");
        }
    }
    if old_thumb.exists() {
        if let Err(e) = std::fs::rename(&old_thumb, &new_thumb) {
            eprintln!("thumb rename failed: {e}");
        }
    }
    // Re-key visible entry if present.
    if let Ok(root) = project_root_for(&new_primary) {
        let old_rel = src
            .strip_prefix(&root)
            .ok()
            .map(as_str)
            .or_else(|| relativize(&src, &root));
        let new_rel = relativize(&new_primary, &root);
        if let (Some(o), Some(n)) = (old_rel, new_rel) {
            let mut set = load_visible_set(&root)?;
            if set.remove(&o) {
                set.insert(n);
                save_visible_set(&root, &set)?;
            }
        }
    }
    Ok(as_str(&new_primary))
}

#[tauri::command]
pub fn save_png_base64(path: String, data_base64: String) -> AppResult<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD
        .decode(&data_base64)
        .map_err(|e| AppError::Msg(format!("base64 decode: {e}")))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }
    std::fs::write(&p, &bytes)?;
    Ok(())
}

#[tauri::command]
pub fn sequence_prompt_append(sequence_path: String, prompt: String) -> AppResult<SequenceSidecar> {
    let root = PathBuf::from(&sequence_path);
    let path = root.join(SEQUENCE_SIDECAR);
    let mut sidecar: SequenceSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(prompt.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt,
            prompts: None,
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_prompt_append(shot_path: String, prompt: String) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(prompt.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt,
            prompts: None,
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_prompts_append(shot_path: String, prompts: Vec<String>) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    let combined = prompts.join("\n\n");
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(combined.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt: combined,
            prompts: Some(prompts),
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

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

#[tauri::command]
pub fn dir_ensure(path: String) -> AppResult<()> {
    ensure_dir(&PathBuf::from(path))
}

#[tauri::command]
pub fn dirs_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).is_dir()).collect()
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

// ---------- Timeline (NLE) ----------

/// Pick the "latest media" for a shot: the last image (alphabetic by filename)
/// in the latest non-SRC version directory. Returns None if the shot has no
/// generation outputs.
fn shot_latest_media(shot_path: &Path) -> Option<(PathBuf, bool)> {
    if !shot_path.is_dir() {
        return None;
    }
    let mut versions: Vec<PathBuf> = std::fs::read_dir(shot_path)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.') && !n.starts_with('$') && n != SRC_DIR)
                .unwrap_or(false)
        })
        .collect();
    versions.sort();
    let latest = versions.into_iter().last()?;

    let mut media: Vec<PathBuf> = std::fs::read_dir(&latest)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with(".thumb.png") {
                return false;
            }
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            IMAGE_EXTS.iter().any(|e| *e == ext) || VIDEO_EXTS.iter().any(|e| *e == ext)
        })
        .collect();
    media.sort();
    let last = media.into_iter().last()?;
    let ext = last
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let is_video = VIDEO_EXTS.iter().any(|e| *e == ext);
    Some((last, is_video))
}

fn shots_latest_media_scan(seq_path: &Path) -> AppResult<Vec<ShotLatestMedia>> {
    if !seq_path.is_dir() {
        return Err(AppError::Msg(format!(
            "not a directory: {}",
            as_str(seq_path)
        )));
    }
    let mut out: Vec<ShotLatestMedia> = Vec::new();
    let mut shot_dirs: Vec<PathBuf> = std::fs::read_dir(seq_path)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.') && !n.starts_with('$') && n != SRC_DIR)
                .unwrap_or(false)
        })
        .collect();
    shot_dirs.sort();

    for shot in shot_dirs {
        let sidecar: ShotSidecar = read_sidecar(&shot.join(SHOT_SIDECAR))?;
        let latest = shot_latest_media(&shot);
        out.push(ShotLatestMedia {
            shot_path: as_str(&shot),
            media_path: latest.as_ref().map(|(p, _)| as_str(p)),
            is_video: latest.as_ref().map(|(_, v)| *v).unwrap_or(false),
            clip_media_path: sidecar.clip_media_path,
        });
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInitResult {
    pub timeline: SequenceTimeline,
    pub shots_latest_media: Vec<ShotLatestMedia>,
}

#[tauri::command]
pub fn timeline_init(seq_path: String) -> AppResult<TimelineInitResult> {
    let root = PathBuf::from(&seq_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {seq_path}")));
    }
    let timeline: SequenceTimeline = read_sidecar(&root.join(TIMELINE_SIDECAR))?;
    let shots_latest_media = shots_latest_media_scan(&root)?;
    Ok(TimelineInitResult {
        timeline,
        shots_latest_media,
    })
}

#[tauri::command]
pub fn sequence_timeline_save(seq_path: String, timeline: SequenceTimeline) -> AppResult<()> {
    let root = PathBuf::from(&seq_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {seq_path}")));
    }
    write_sidecar_atomic(&root.join(TIMELINE_SIDECAR), &timeline)
}

#[tauri::command]
pub fn shot_clip_media_set(shot_path: String, media_path: Option<String>) -> AppResult<()> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    sidecar.clip_media_path = media_path;
    write_sidecar_atomic(&path, &sidecar)
}

/// Set or clear the short comment associated with a version folder. Trimmed
/// empty input removes the entry; the version folder itself is never renamed.
#[tauri::command]
pub fn shot_version_comment_set(
    shot_path: String,
    version: String,
    comment: Option<String>,
) -> AppResult<()> {
    let root = PathBuf::from(&shot_path);
    if !root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {shot_path}")));
    }
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    let trimmed = comment.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        sidecar.version_comments.remove(&version);
    } else {
        sidecar.version_comments.insert(version, trimmed);
    }
    write_sidecar_atomic(&path, &sidecar)
}
