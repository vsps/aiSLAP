use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{run_blocking, AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

/// Read an image's real pixel dimensions straight from its file header (no
/// full decode — `imagesize` reads only the first handful of bytes). Used to
/// price per-megapixel-billed models exactly from the actual output size,
/// rather than guessing from a named size preset or an upscale model's
/// input-dependent output size (see `pricing::is_per_area_unit`). `None` —
/// not an error — for anything not a recognized image format; best-effort,
/// never blocks a generation or write.
#[tauri::command]
pub async fn image_dimensions_read(path: String) -> AppResult<Option<ImageDimensions>> {
    run_blocking(move || {
        Ok(imagesize::size(&path).ok().map(|s| ImageDimensions {
            width: s.width as u32,
            height: s.height as u32,
        }))
    })
    .await
}

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
pub async fn video_info_probe(video_path: String, ffmpeg_path: String) -> AppResult<VideoInfo> {
    run_blocking(move || video_info_probe_impl(video_path, ffmpeg_path)).await
}

fn video_info_probe_impl(video_path: String, ffmpeg_path: String) -> AppResult<VideoInfo> {
    let exe = ffmpeg_path.trim();
    if exe.is_empty() {
        return Ok(VideoInfo::default());
    }
    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        tracing::warn!("configured ffmpeg path not found: {exe}");
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
pub async fn video_thumbnail_extract(
    video_path: String,
    thumb_path: String,
    ffmpeg_path: String,
) -> AppResult<bool> {
    run_blocking(move || video_thumbnail_extract_impl(video_path, thumb_path, ffmpeg_path)).await
}

fn video_thumbnail_extract_impl(
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
        tracing::warn!("configured ffmpeg path not found: {exe}");
        return Ok(false);
    }
    let thumb = PathBuf::from(&thumb_path);
    if let Some(parent) = thumb.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Grab ~1s frame; `-ss 00:00:01` after -i for accuracy.
    //
    // The pixel format is pinned because the source dictates it otherwise, and
    // a 10-bit source (Seedance 2.5 returns HEVC Main 10 for some outputs) had
    // ffmpeg writing 16-bit `rgb48be` PNGs at ~8MB each. `yuvj420p` at `-q:v 3`
    // is ~150KB for the same 1920x1080 frame, which is ample for a poster that
    // never renders above a few hundred pixels wide.
    let status = Command::new(&exe_path)
        .args([
            "-y",
            "-i",
            &video_path,
            "-ss",
            "00:00:01",
            "-vframes",
            "1",
            "-pix_fmt",
            "yuvj420p",
            "-q:v",
            "3",
            &thumb_path,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => Ok(thumb.exists()),
        Ok(s) => {
            tracing::warn!("ffmpeg thumbnail extract exited with {s}");
            Ok(false)
        }
        Err(e) => {
            tracing::warn!("ffmpeg thumbnail extract spawn failed: {e}");
            Ok(false)
        }
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
        /// Natural duration of the source file, when the frontend has probed
        /// it. Consumed only by the interchange writers (`commands::interchange`)
        /// so a host NLE knows media exists past the trimmed range; the ffmpeg
        /// render path ignores it.
        #[serde(rename = "sourceDurationSec", default)]
        source_duration_sec: Option<f64>,
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
pub async fn timeline_export(params: TimelineExportParams) -> AppResult<()> {
    run_blocking(move || timeline_export_impl(params)).await
}

fn timeline_export_impl(params: TimelineExportParams) -> AppResult<()> {
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
                ..
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

// ---------- Video trim ----------

/// One frame at 25fps — the same floor `timeline_export` puts on a segment.
const MIN_TRIM_SEC: f64 = 0.04;
/// Visually lossless x264. Not exposed in the UI: a trim is an edit, not an
/// encode dialog.
const TRIM_CRF: u32 = 18;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTrimParams {
    pub input_path: String,
    pub output_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub ffmpeg_path: String,
}

/// Build the ffmpeg argv for a trim. Pure, so the argument *order* — the part
/// that decides whether the cut is fast, accurate, both or neither — is
/// testable without a binary on PATH.
///
/// `-ss` sits BEFORE `-i` deliberately. As an *input* option ffmpeg seeks the
/// demuxer to the keyframe preceding the mark rather than decoding and
/// discarding the whole head; since ffmpeg 2.1 that is still frame-accurate
/// when re-encoding, because it decodes on from that keyframe and drops the
/// frames ahead of the mark. The output-side form (`-i in -ss t`) buys no
/// accuracy and costs a full decode of everything before the in point.
///
/// `-t` stays AFTER `-i`, so it measures the trimmed duration rather than an
/// absolute end time: an input-side `-ss` resets output timestamps to zero (no
/// `-copyts`), so `-ss 5 -i in -t 3` yields exactly `[5s, 8s)`.
///
/// No `-r`: a trim preserves the source framerate. `timeline_export` pins one
/// only because it normalizes heterogeneous sources onto a shared timebase.
fn trim_args(p: &VideoTrimParams) -> AppResult<Vec<String>> {
    if !p.start_sec.is_finite() || !p.end_sec.is_finite() {
        return Err(AppError::Msg("in/out points are not finite".into()));
    }
    let start = p.start_sec.max(0.0);
    let dur = p.end_sec - start;
    if dur < MIN_TRIM_SEC {
        return Err(AppError::Msg(format!(
            "out point must be at least {MIN_TRIM_SEC}s after the in point"
        )));
    }
    let is_mp4 = std::path::Path::new(&p.output_path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));

    // Millisecond precision, pinned: matches the popup's readout, and keeps a
    // float like 3.0000000000000004 out of the argv.
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-ss".into(),
        format!("{start:.3}"),
        "-i".into(),
        p.input_path.clone(),
        "-t".into(),
        format!("{dur:.3}"),
        // First video stream always; audio only if the source has any
        // ("?" = don't fail when it doesn't).
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a?".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "medium".into(),
        "-crf".into(),
        format!("{TRIM_CRF}"),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        // An input-side seek can leave the first packets carrying negative
        // timestamps; without this the output opens on a black or stuttering
        // head.
        "-avoid_negative_ts".into(),
        "make_zero".into(),
    ];
    if is_mp4 {
        args.extend_from_slice(&["-movflags".into(), "+faststart".into()]);
    }
    args.push(p.output_path.clone());
    Ok(args)
}

/// Cut `[startSec, endSec)` out of a video into a new file, re-encoding so the
/// cut lands exactly on the marks the user set. Unlike the probe and thumbnail
/// commands, a missing ffmpeg is a hard error rather than a soft no-op — the
/// caller explicitly asked for a file.
#[tauri::command]
pub async fn video_trim(params: VideoTrimParams) -> AppResult<()> {
    run_blocking(move || video_trim_impl(params)).await
}

fn video_trim_impl(params: VideoTrimParams) -> AppResult<()> {
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
    if !PathBuf::from(&params.input_path).is_file() {
        return Err(AppError::Msg(format!("not a file: {}", params.input_path)));
    }
    let out = PathBuf::from(&params.output_path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let args = trim_args(&params)?;

    let output = Command::new(&exe_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::Msg(format!("ffmpeg spawn failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(20).collect::<Vec<_>>().join("\n");
        return Err(AppError::Msg(format!(
            "ffmpeg exited with status {}: {tail}",
            output.status
        )));
    }

    // A range that selected nothing can still exit 0 with an empty container.
    // Don't leave a 0-byte file behind for the next gallery scan to render as
    // a broken tile.
    if std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&out);
        return Err(AppError::Msg(
            "ffmpeg produced no output — check the in and out points".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(start: f64, end: f64, out: &str) -> VideoTrimParams {
        VideoTrimParams {
            input_path: "in.mp4".into(),
            output_path: out.into(),
            start_sec: start,
            end_sec: end,
            ffmpeg_path: "ffmpeg".into(),
        }
    }

    #[test]
    fn trim_seeks_on_the_input_side() {
        let args = trim_args(&params(3.24, 7.0, "out.mp4")).unwrap();
        // -ss must precede -i, or the seek costs a full decode of the head.
        assert_eq!(args[1], "-ss");
        assert_eq!(args[2], "3.240");
        assert_eq!(args[3], "-i");
        assert_eq!(args[4], "in.mp4");
        // -t is an output option measuring the trimmed length, not an end time.
        assert_eq!(args[5], "-t");
        assert_eq!(args[6], "3.760");
    }

    #[test]
    fn trim_re_encodes_and_keeps_source_framerate() {
        let args = trim_args(&params(0.0, 2.0, "out.mp4")).unwrap();
        assert!(args.iter().any(|a| a == "libx264"));
        assert!(args.iter().any(|a| a == "18"));
        assert!(!args.iter().any(|a| a == "-r"));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn trim_adds_faststart_only_for_mp4() {
        let mp4 = trim_args(&params(0.0, 2.0, "out.mp4")).unwrap();
        assert!(mp4.iter().any(|a| a == "+faststart"));
        let webm = trim_args(&params(0.0, 2.0, "out.webm")).unwrap();
        assert!(!webm.iter().any(|a| a == "+faststart"));
    }

    #[test]
    fn trim_clamps_a_negative_start() {
        let args = trim_args(&params(-5.0, 2.0, "out.mp4")).unwrap();
        assert_eq!(args[2], "0.000");
        assert_eq!(args[6], "2.000");
    }

    #[test]
    fn trim_rejects_empty_and_inverted_ranges() {
        assert!(trim_args(&params(5.0, 5.0, "out.mp4")).is_err());
        assert!(trim_args(&params(5.0, 2.0, "out.mp4")).is_err());
        assert!(trim_args(&params(1.0, 1.0 + MIN_TRIM_SEC / 2.0, "out.mp4")).is_err());
    }

    #[test]
    fn trim_rejects_non_finite_marks() {
        assert!(trim_args(&params(f64::NAN, 2.0, "out.mp4")).is_err());
        assert!(trim_args(&params(0.0, f64::INFINITY, "out.mp4")).is_err());
    }
}
