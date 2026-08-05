//! Timeline (NLE) commands: per-shot "latest media" resolution and the
//! sequence timeline sidecar.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{as_str, is_video_ext, require_dir, SHOT_SIDECAR, TIMELINE_SIDECAR};
use crate::commands::walk;
use crate::domain::{SequenceTimeline, ShotLatestMedia, ShotSidecar};
use crate::error::AppResult;
use crate::fsjson::{read_json_or_default, write_json_atomic};

/// Pick the "latest media" for a shot: the last file (alphabetic by filename)
/// in the last version directory. Returns None if the shot has no generation
/// outputs.
///
/// `shot_versions` excludes `SEL` as well as `SRC`. That matters here: this used
/// to skip only `SRC`, so a `SEL` folder sorted after the real version folders
/// and its contents could win "latest media" purely on alphabetical order.
fn shot_latest_media(shot_path: &Path) -> Option<(PathBuf, bool)> {
    if !shot_path.is_dir() {
        return None;
    }
    let latest = walk::shot_versions(shot_path).ok()?.into_iter().last()?;
    let last = walk::dir_media(&latest).ok()?.into_iter().last()?;
    let is_video = is_video_ext(&last);
    Some((last, is_video))
}

fn shots_latest_media_scan(seq_path: &Path) -> AppResult<Vec<ShotLatestMedia>> {
    require_dir(seq_path)?;
    // The emitted shot_path must be the media root — it's what the session
    // carries as its shot path and what the timeline store keys clips by.
    let mut shot_dirs: Vec<PathBuf> = walk::sequence_shots(seq_path)?
        .into_iter()
        .map(|s| s.media_root)
        .collect();
    shot_dirs.sort();

    let mut out: Vec<ShotLatestMedia> = Vec::new();
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
    require_dir(&root)?;
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
    require_dir(&root)?;
    write_json_atomic(&root.join(TIMELINE_SIDECAR), &timeline)
}
