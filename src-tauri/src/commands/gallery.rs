//! Gallery scanning: shot version columns, starred/favorites view, and the
//! stacked sequence view.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{
    as_str, is_image_ext, is_model3d_ext, is_video_ext, list_dirs, project_root_for, relativize,
    sidecar_path, thumb_path, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::visible::{load_visible_set, save_visible_set};
use crate::domain::{GalleryColumn, GalleryImage, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::read_json_or_default;

pub(crate) fn scan_shot_columns(root: &Path) -> AppResult<Vec<GalleryColumn>> {
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
                src_images: Vec::new(),
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
        let src_sub = p.join("SRC");
        let src_images = if src_sub.is_dir() {
            scan_directory_images(&src_sub, project_root.as_deref(), &visible)?
        } else {
            Vec::new()
        };
        cols.push(GalleryColumn {
            id: name.clone(),
            version: name,
            is_src: false,
            images,
            src_images,
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

/// Classify a single file as a `GalleryImage`, or `None` if it's not a
/// recognized media file (or is a `.thumb.png` adjunct). `starred` is passed
/// in rather than computed here since callers differ on how they know it:
/// a directory scan checks the visible set per-file, while a scan seeded from
/// the visible set itself already knows the answer.
fn try_make_gallery_image(path: &Path, starred: Option<bool>) -> Option<GalleryImage> {
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
        if t.exists() { Some(as_str(&t)) } else { None }
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
        starred,
    })
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
        let starred = project_root
            .and_then(|r| relativize(&path, r))
            .map(|rel| visible.contains(&rel));
        if let Some(img) = try_make_gallery_image(&path, starred) {
            out.push(img);
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub async fn shot_rescan(shot_path: String) -> AppResult<Vec<GalleryColumn>> {
    run_blocking(move || {
        let root = PathBuf::from(&shot_path);
        scan_shot_columns(&root)
    })
    .await
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
    run_blocking(move || sequence_stacks_scan_impl(sequence_path)).await
}

fn sequence_stacks_scan_impl(sequence_path: String) -> AppResult<SequenceStacks> {
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

        let sidecar: ShotSidecar = read_json_or_default(&shot_dir.join(SHOT_SIDECAR))?;

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

// ---------- Starred / favorites ----------

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

#[tauri::command]
pub async fn project_starred_scan(project_path: String) -> AppResult<Vec<SeqStarredGroup>> {
    run_blocking(move || project_starred_scan_impl(project_path)).await
}

fn project_starred_scan_impl(project_path: String) -> AppResult<Vec<SeqStarredGroup>> {
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
        let img = match try_make_gallery_image(&abs, Some(true)) {
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
