//! Gallery scanning: shot version columns and the stacked sequence view.
//!
//! Every scan resolves each file's tags from a `TagIndex` loaded once by the
//! async command wrapper (see `tag_index_for`), falling back to the file's
//! own sidecar only for files the index has never seen.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{
    as_str, is_image_ext, is_model3d_ext, is_video_ext, list_dirs, project_root_for, relativize,
    sidecar_path, thumb_path, SEL_DIR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::tags::tags_from_sidecar;
use crate::db::TagIndex;
use crate::domain::{GalleryColumn, GalleryImage, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::read_json_or_default;

/// Load the tag index for the project `path` belongs to. Best-effort: a
/// missing or broken index just means every image scans as untagged (and the
/// sidecar fallback in `tags_for_file` fills most of it back in).
pub(crate) async fn tag_index_for(path: &Path) -> TagIndex {
    let Ok(root) = project_root_for(path) else {
        return TagIndex::default();
    };
    match crate::db::tags_all(&root).await {
        Ok(idx) => idx,
        Err(e) => {
            tracing::warn!("tag index load failed for {}: {e}", as_str(path));
            TagIndex::default()
        }
    }
}

pub(crate) fn scan_shot_columns(root: &Path, tags: &TagIndex) -> AppResult<Vec<GalleryColumn>> {
    let mut cols: Vec<GalleryColumn> = Vec::new();
    let project_root = project_root_for(root).ok();

    // Include the project-level SRC as "GLOBAL SRC" (shot → seq → project).
    if let Some(project) = root.parent().and_then(|s| s.parent()) {
        let global_src = project.join(SRC_DIR);
        if global_src.is_dir() {
            let images = scan_directory_images(&global_src, project_root.as_deref(), tags)?;
            cols.push(GalleryColumn {
                id: as_str(&global_src),
                version: "GLOBAL SRC".to_string(),
                is_src: true,
                images,
                src_images: Vec::new(),
                timestamp: None,
                model_name: None,
            });
        }
    }

    // Per-shot SRC — sits to the right of GLOBAL SRC, holds shot-level
    // reference images copied in by the ref panel or drag-drop.
    let shot_src = root.join(SRC_DIR);
    if shot_src.is_dir() {
        let images = scan_directory_images(&shot_src, project_root.as_deref(), tags)?;
        cols.push(GalleryColumn {
            id: as_str(&shot_src),
            version: "SHOT SRC".to_string(),
            is_src: true,
            images,
            src_images: Vec::new(),
            timestamp: None,
            model_name: None,
        });
    }

    // Scan all subdirectories as version columns (skip SRC — it's handled above).
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
        if name.starts_with('.') || name.starts_with('$') || name == SRC_DIR || name == SEL_DIR {
            continue;
        }
        let images = scan_directory_images(&p, project_root.as_deref(), tags)?;
        cols.push(GalleryColumn {
            id: name.clone(),
            version: name,
            is_src: false,
            images,
            src_images: Vec::new(),
            timestamp: None,
            model_name: None,
        });
    }

    // SEL column — sits at the far right, contains user-selected keeps.
    let shot_sel = root.join(SEL_DIR);
    if shot_sel.is_dir() {
        let images = scan_directory_images(&shot_sel, project_root.as_deref(), tags)?;
        cols.push(GalleryColumn {
            id: as_str(&shot_sel),
            version: SEL_DIR.to_string(),
            is_src: true,
            images,
            src_images: Vec::new(),
            timestamp: None,
            model_name: None,
        });
    }

    cols.sort_by(|a, b| match (a.is_src, b.is_src) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.version.cmp(&b.version),
    });

    // SEL must always sit immediately after SHOT SRC (falling back to right
    // after GLOBAL SRC, or the front, if this shot has no SRC folder yet) —
    // independent of the alphabetical sort above, which would otherwise
    // place it wherever its name happens to fall (e.g. before SHOT SRC).
    if let Some(sel_idx) = cols.iter().position(|c| c.version == SEL_DIR) {
        let sel_col = cols.remove(sel_idx);
        let insert_at = cols
            .iter()
            .position(|c| c.version == "SHOT SRC")
            .or_else(|| cols.iter().position(|c| c.version == "GLOBAL SRC"))
            .map(|i| i + 1)
            .unwrap_or(0);
        cols.insert(insert_at, sel_col);
    }

    Ok(cols)
}

/// Classify a single file as a `GalleryImage`, or `None` if it's not a
/// recognized media file (or is a `.thumb.png` adjunct). `tags` are passed in
/// rather than resolved here since callers differ on how they know them: a
/// directory scan looks each file up in the index, while a scan driven by the
/// index itself already has them in hand.
pub(crate) fn try_make_gallery_image(path: &Path, tags: Vec<String>) -> Option<GalleryImage> {
    let filename = path.file_name().and_then(|n| n.to_str())?.to_string();
    if filename.ends_with(".thumb.png") {
        return None;
    }
    let is_image = is_image_ext(path);
    let is_video = is_video_ext(path);
    let is_model_3d = is_model3d_ext(path);
    if !is_image && !is_video && !is_model_3d {
        return None;
    }
    let meta_path = sidecar_path(path);
    let thumb_path = if is_video || is_model_3d {
        let t = thumb_path(path);
        if t.exists() {
            Some(as_str(&t))
        } else {
            None
        }
    } else {
        None
    };
    Some(GalleryImage {
        filename,
        path: as_str(path),
        metadata_path: as_str(&meta_path),
        is_video,
        is_model_3d,
        thumb_path,
        tags,
    })
}

/// Tags for one file: the index if it knows the file, otherwise the file's
/// own sidecar. The fallback only fires for media the index has never seen
/// (legacy files, anything dropped in from outside the app), so a warm
/// project costs zero extra reads per scan.
fn tags_for_file(path: &Path, project_root: Option<&Path>, index: &TagIndex) -> Vec<String> {
    let rel = project_root.and_then(|r| relativize(path, r));
    match rel {
        Some(rel) if index.is_indexed(&rel) => index.tags_for(&rel),
        _ => match std::fs::read_to_string(sidecar_path(path)) {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .as_ref()
                .and_then(|v| v.as_object())
                .map(tags_from_sidecar)
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        },
    }
}

fn scan_directory_images(
    dir: &Path,
    project_root: Option<&Path>,
    index: &TagIndex,
) -> AppResult<Vec<GalleryImage>> {
    let mut out: Vec<GalleryImage> = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let entry = e?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let tags = tags_for_file(&path, project_root, index);
        if let Some(img) = try_make_gallery_image(&path, tags) {
            out.push(img);
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub async fn shot_rescan(shot_path: String) -> AppResult<Vec<GalleryColumn>> {
    let root = PathBuf::from(&shot_path);
    // One index query up front — the scan itself is blocking, and the DB
    // layer is async (same split as image.rs's `_impl` + async wrapper).
    let index = tag_index_for(&root).await;
    run_blocking(move || scan_shot_columns(&root, &index)).await
}

// ---------- Stacked sequence view ----------

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
pub async fn sequence_stacks_scan(sequence_path: String) -> AppResult<SequenceStacks> {
    let index = tag_index_for(&PathBuf::from(&sequence_path)).await;
    run_blocking(move || sequence_stacks_scan_impl(sequence_path, &index)).await
}

fn sequence_stacks_scan_impl(sequence_path: String, tags: &TagIndex) -> AppResult<SequenceStacks> {
    let seq_root = PathBuf::from(&sequence_path);
    if !seq_root.is_dir() {
        return Err(AppError::Msg(format!("not a directory: {sequence_path}")));
    }

    let project_root = project_root_for(&seq_root).ok();

    // Project-level GLOBAL SRC.
    let global_src_images = match project_root.as_ref() {
        Some(root) => {
            let global_src = root.join(SRC_DIR);
            if global_src.is_dir() {
                scan_directory_images(&global_src, project_root.as_deref(), tags)?
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
        if shot_name == SRC_DIR || shot_name == SEL_DIR {
            continue;
        }

        let sidecar: ShotSidecar = read_json_or_default(&shot_dir.join(SHOT_SIDECAR))?;

        let mut versions: Vec<VersionStack> = Vec::new();
        for v_dir in list_dirs(&shot_dir)? {
            let vname = match v_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if vname == SRC_DIR || vname == SEL_DIR {
                continue;
            }
            let images = scan_directory_images(&v_dir, project_root.as_deref(), tags)?;
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
