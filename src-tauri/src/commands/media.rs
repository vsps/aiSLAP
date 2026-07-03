use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub fps: Option<f64>,
    pub duration_sec: Option<f64>,
}

/// Probe a video's framerate + duration by parsing ffmpeg's own `-i` stderr
/// banner (no ffprobe binary required — reuses the ffmpeg path already
/// configured for thumbnail/export). Fields are `None` — not an error — when
/// ffmpeg is missing or the banner doesn't parse; callers show what they have.
#[tauri::command]
pub fn video_info_probe(video_path: String, ffmpeg_path: String) -> AppResult<VideoInfo> {
    let exe = ffmpeg_path.trim();
    if exe.is_empty() {
        return Ok(VideoInfo::default());
    }
    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        return Ok(VideoInfo::default());
    }
    // `-i` with no output makes ffmpeg print the input's stream info to
    // stderr and exit non-zero — that's expected, we only want the banner.
    let output = Command::new(&exe_path)
        .args(["-i", &video_path])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::Msg(format!("ffmpeg spawn failed: {e}")))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(VideoInfo {
        fps: parse_fps(&stderr),
        duration_sec: parse_duration(&stderr),
    })
}

fn parse_fps(banner: &str) -> Option<f64> {
    for line in banner.lines() {
        let line = line.trim();
        if !line.contains("Video:") {
            continue;
        }
        for field in line.split(',') {
            let field = field.trim();
            if let Some(num) = field.strip_suffix("fps") {
                if let Ok(f) = num.trim().parse::<f64>() {
                    return Some(f);
                }
            }
        }
    }
    None
}

fn parse_duration(banner: &str) -> Option<f64> {
    for line in banner.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Duration:") else {
            continue;
        };
        let Some(ts) = rest.split(',').next() else {
            continue;
        };
        let parts: Vec<&str> = ts.trim().split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        let (h, m, s) = (
            parts[0].trim().parse::<f64>(),
            parts[1].trim().parse::<f64>(),
            parts[2].trim().parse::<f64>(),
        );
        if let (Ok(h), Ok(m), Ok(s)) = (h, m, s) {
            return Some(h * 3600.0 + m * 60.0 + s);
        }
    }
    None
}

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
