//! Lazy H.264 playback proxies for videos the webview can't decode.
//!
//! WebView2 only plays HEVC when the OS has the HEVC extension / a capable GPU,
//! and never plays 4:4:4 (Seedance 2.5 returns HEVC Main 10 from the API and
//! 10-bit 4:4:4 via Magnific). The frontend tries the original first and, on a
//! `<video>` error, asks for a proxy here. The original stays the master —
//! export, trim and the sidecars never see the proxy.
//!
//! Proxies live in the per-user cache dir, not beside the media, so shot folders
//! and the media triple stay clean. They are disposable: deleting the directory
//! costs one re-transcode per file.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::commands::config::resolve_ffmpeg;
use crate::error::{run_blocking, AppError, AppResult};

const CACHE_SUBDIR: &str = "video-proxy";

fn proxy_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("aiSLAP").join(CACHE_SUBDIR))
}

/// `sha256(path, mtime_ms, len)`. Self-invalidating: a file edited in place
/// misses and is re-encoded. The absolute path is fine here (unlike the
/// thumbnail cache) because the proxy isn't stored inside the project.
fn proxy_key(path: &Path, meta: &std::fs::Metadata) -> String {
    use sha2::{Digest, Sha256};
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().to_lowercase().as_bytes());
    hasher.update([0]);
    hasher.update(mtime_ms.to_le_bytes());
    hasher.update(meta.len().to_le_bytes());
    format!("{:x}", hasher.finalize())
}

/// ffmpeg argv for one encoder attempt. Pure so it can be tested without a binary.
///
/// 8-bit 4:2:0 is the only thing every webview decodes, so the pixel format is
/// pinned. The scale filter rounds to even dimensions (odd sizes fail yuv420p).
/// `-map 0:a?` keeps audio when there is some and doesn't fail when there isn't.
fn proxy_args(src: &str, dst: &str, hardware: bool) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-y".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        src.into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a?".into(),
        "-vf".into(),
        "scale=trunc(iw/2)*2:trunc(ih/2)*2".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    let enc: &[&str] = if hardware {
        &["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "19"]
    } else {
        &["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
    };
    a.extend(enc.iter().map(|s| s.to_string()));
    a.extend(
        [
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            dst,
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    a
}

fn run_ffmpeg(exe: &Path, args: &[String]) -> bool {
    Command::new(exe)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Path of an H.264 proxy for `video_path`, transcoding it on first request.
///
/// `None` — not an error — when ffmpeg is missing or both encoders fail; the
/// caller just leaves the video unplayable as before.
#[tauri::command]
pub async fn video_proxy_ensure(
    video_path: String,
    ffmpeg_path: String,
) -> AppResult<Option<String>> {
    run_blocking(move || video_proxy_ensure_impl(&video_path, &ffmpeg_path)).await
}

fn video_proxy_ensure_impl(video_path: &str, ffmpeg_path: &str) -> AppResult<Option<String>> {
    let src = PathBuf::from(video_path);
    let meta = std::fs::metadata(&src)?;
    let Some(dir) = proxy_dir() else {
        return Ok(None);
    };
    let out = dir.join(format!("{}.mp4", proxy_key(&src, &meta)));
    if out.is_file() {
        return Ok(Some(out.to_string_lossy().into_owned()));
    }
    let Some(exe) = resolve_ffmpeg(ffmpeg_path) else {
        return Ok(None);
    };
    std::fs::create_dir_all(&dir)?;

    // Encode to a unique temp name and rename, so a half-written file is never
    // mistaken for a finished proxy and two racing callers can't corrupt each other.
    let tmp = dir.join(format!(
        "{}.{}.part.mp4",
        out.file_stem().and_then(|s| s.to_str()).unwrap_or("proxy"),
        std::process::id()
    ));
    let tmp_s = tmp.to_string_lossy().into_owned();
    let ok = run_ffmpeg(&exe, &proxy_args(video_path, &tmp_s, true))
        || run_ffmpeg(&exe, &proxy_args(video_path, &tmp_s, false));
    if !ok || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        tracing::warn!("video proxy transcode failed for {video_path}");
        return Ok(None);
    }
    std::fs::rename(&tmp, &out).map_err(|e| AppError::Msg(format!("proxy rename failed: {e}")))?;
    Ok(Some(out.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_pin_pixel_format_and_pick_encoder() {
        let hw = proxy_args("a.mp4", "b.mp4", true);
        let sw = proxy_args("a.mp4", "b.mp4", false);
        for a in [&hw, &sw] {
            let i = a.iter().position(|s| s == "-pix_fmt").unwrap();
            assert_eq!(a[i + 1], "yuv420p");
            assert_eq!(a.last().unwrap(), "b.mp4");
        }
        assert!(hw.contains(&"h264_nvenc".to_string()));
        assert!(sw.contains(&"libx264".to_string()));
    }

    #[test]
    fn key_changes_with_path() {
        let meta = std::fs::metadata(std::env::current_exe().unwrap()).unwrap();
        assert_ne!(
            proxy_key(Path::new("a.mp4"), &meta),
            proxy_key(Path::new("b.mp4"), &meta)
        );
    }
}
