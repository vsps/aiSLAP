use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// Extract a frame from `video_path` into `thumb_path` using the provided ffmpeg binary.
/// Returns `false` (not an error) when ffmpeg is missing or extraction fails — caller decides.
#[tauri::command]
pub fn video_thumbnail_extract(
    video_path: String,
    thumb_path: String,
    ffmpeg_path: String,
) -> AppResult<bool> {
    let exe = ffmpeg_path.trim();
    if exe.is_empty() {
        return Ok(false);
    }
    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        return Ok(false);
    }
    let thumb = PathBuf::from(&thumb_path);
    if let Some(parent) = thumb.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Grab ~1s frame; `-ss 00:00:01` after -i for accuracy.
    let status = Command::new(&exe_path)
        .args([
            "-y",
            "-i",
            &video_path,
            "-ss",
            "00:00:01",
            "-vframes",
            "1",
            &thumb_path,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => Ok(thumb.exists()),
        _ => Ok(false),
    }
}

// ---------- Timeline export ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExportSegmentKind {
    Image {
        path: String,
    },
    Video {
        path: String,
        #[serde(rename = "sourceOffsetSec", default)]
        source_offset_sec: f64,
    },
    Blank,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSegment {
    #[serde(flatten)]
    pub kind: ExportSegmentKind,
    pub duration_sec: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineExportParams {
    pub segments: Vec<ExportSegment>,
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub ffmpeg_path: String,
}

#[tauri::command]
pub fn timeline_export(params: TimelineExportParams) -> AppResult<()> {
    if params.segments.is_empty() {
        return Err(AppError::Msg("no segments to export".into()));
    }
    let exe = params.ffmpeg_path.trim();
    if exe.is_empty() {
        return Err(AppError::Msg(
            "ffmpeg path not configured — set it in Settings".into(),
        ));
    }
    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        return Err(AppError::Msg(format!("ffmpeg not found at: {exe}")));
    }

    let w = params.width.max(2);
    let h = params.height.max(2);
    let fps = params.fps.max(1);
    let br_k = params.bitrate_kbps.max(1);

    let mut args: Vec<String> = vec!["-y".to_string()];
    let mut filter = String::new();

    for (i, seg) in params.segments.iter().enumerate() {
        let dur = seg.duration_sec.max(0.04);
        match &seg.kind {
            ExportSegmentKind::Image { path } => {
                args.extend_from_slice(&[
                    "-loop".into(),
                    "1".into(),
                    "-t".into(),
                    format!("{dur}"),
                    "-i".into(),
                    path.clone(),
                ]);
            }
            ExportSegmentKind::Video {
                path,
                source_offset_sec,
            } => {
                let offset = source_offset_sec.max(0.0);
                // Bound the input decode at offset+dur so a long source doesn't
                // get fully read before the trim filter discards the head.
                args.extend_from_slice(&[
                    "-t".into(),
                    format!("{}", offset + dur),
                    "-i".into(),
                    path.clone(),
                ]);
            }
            ExportSegmentKind::Blank => {
                args.extend_from_slice(&[
                    "-f".into(),
                    "lavfi".into(),
                    "-t".into(),
                    format!("{dur}"),
                    "-i".into(),
                    format!("color=c=black:s={w}x{h}:r={fps}"),
                ]);
            }
        }

        // Per-input normalize filter chain.
        let chain = match &seg.kind {
            ExportSegmentKind::Blank => format!("[{i}:v]setsar=1[v{i}]"),
            ExportSegmentKind::Video {
                source_offset_sec, ..
            } => {
                let offset = source_offset_sec.max(0.0);
                format!(
                    "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
                     pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,\
                     setsar=1,fps={fps},trim=start={offset}:duration={dur},setpts=PTS-STARTPTS[v{i}]"
                )
            }
            ExportSegmentKind::Image { .. } => format!(
                "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,\
                 setsar=1,fps={fps},trim=duration={dur},setpts=PTS-STARTPTS[v{i}]"
            ),
        };
        if !filter.is_empty() {
            filter.push(';');
        }
        filter.push_str(&chain);
    }

    // Concat
    let n = params.segments.len();
    filter.push(';');
    for i in 0..n {
        filter.push_str(&format!("[v{i}]"));
    }
    filter.push_str(&format!("concat=n={n}:v=1:a=0[out]"));

    args.extend_from_slice(&[
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "[out]".into(),
        "-c:v".into(),
        "libx264".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-b:v".into(),
        format!("{br_k}k"),
        "-r".into(),
        format!("{fps}"),
        params.output_path.clone(),
    ]);

    let output = Command::new(&exe_path)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| AppError::Msg(format!("ffmpeg spawn failed: {e}")))?;

    if !output.status.success() {
        // Surface the last bit of stderr — ffmpeg can be loud.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(AppError::Msg(format!(
            "ffmpeg exited with status {}: {tail}",
            output.status
        )));
    }

    Ok(())
}
