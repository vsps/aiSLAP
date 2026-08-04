//! Timeline (NLE) commands: per-shot "latest media" resolution and the
//! sequence timeline sidecar.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{
    as_str, is_media_ext, is_video_ext, SHOT_SIDECAR, SRC_DIR, TIMELINE_SIDECAR,
};
use crate::commands::prism;
use crate::domain::{SequenceTimeline, ShotLatestMedia, ShotSidecar};
use crate::error::{AppError, AppResult};
use crate::fsjson::{read_json_or_default, write_json_atomic};

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
            is_media_ext(p)
        })
        .collect();
    media.sort();
    let last = media.into_iter().last()?;
    let is_video = is_video_ext(&last);
    Some((last, is_video))
}

fn shots_latest_media_scan(seq_path: &Path) -> AppResult<Vec<ShotLatestMedia>> {
    if !seq_path.is_dir() {
        return Err(AppError::Msg(format!(
            "not a directory: {}",
            as_str(seq_path)
        )));
    }
    // PRISM: entity resolution is shared with the dropdowns (so categories in
    // the asset tree aren't mistaken for assets), and aiSLAP's versions live in
    // `<entity>/Renders/AI`. The emitted shot_path must be that media root —
    // it's what the session carries as its shot path and what the timeline
    // store keys clips by.
    let layout = prism::layout_for(seq_path);
    let mut out: Vec<ShotLatestMedia> = Vec::new();
    let mut shot_dirs: Vec<PathBuf> = match &layout {
        Some(l) => prism::entities_in(l, seq_path)?
            .into_iter()
            .map(|p| prism::media_root_for(&p))
            .filter(|p| p.is_dir())
            .collect(),
        None => std::fs::read_dir(seq_path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.starts_with('.') && !n.starts_with('$') && n != SRC_DIR)
                    .unwrap_or(false)
            })
            .collect(),
    };
    shot_dirs.sort();

    for shot in shot_dirs {
        let sidecar: ShotSidecar = read_json_or_default(&shot.join(SHOT_SIDECAR))?;
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
    let timeline: SequenceTimeline = read_json_or_default(&root.join(TIMELINE_SIDECAR))?;
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
    write_json_atomic(&root.join(TIMELINE_SIDECAR), &timeline)
}
