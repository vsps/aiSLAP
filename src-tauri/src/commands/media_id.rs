//! Asset identity embedded in media files, so a file that gets moved or
//! unlinked from its sidecar can still be traced back to the asset it was
//! (PNG/JPEG/WebP via a private chunk, MP4/WebM via container metadata).
//! Content hashing is the format-agnostic fallback when embedded tags are
//! stripped by an external tool.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use bytes::Bytes;
use img_parts::jpeg::{markers, Jpeg, JpegSegment};
use img_parts::png::{Png, PngChunk};
use img_parts::riff::{RiffChunk, RiffContent};
use img_parts::webp::WebP;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{run_blocking, AppError, AppResult};

const PNG_KEYWORD: &[u8] = b"aiSLAP";
const JPEG_MAGIC: &str = "AISLAP1:";
const WEBP_CHUNK_ID: [u8; 4] = *b"aiSL";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaId {
    pub asset_id: String,
    pub project_id: String,
}

#[tauri::command]
pub async fn file_hash(path: String) -> AppResult<String> {
    run_blocking(move || file_hash_impl(&PathBuf::from(path))).await
}

pub(crate) fn file_hash_impl(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Embed `asset_id`/`project_id` into the media file at `path`. Returns
/// `false` (not an error) for formats we don't embed into (3D models) or
/// when embedding fails — callers treat embedding as best-effort, since the
/// sidecar + DB row (once Phase 2 lands) remain the durable record.
#[tauri::command]
pub async fn media_id_embed(
    path: String,
    asset_id: String,
    project_id: String,
    ffmpeg_path: String,
) -> AppResult<bool> {
    run_blocking(move || media_id_embed_impl(&PathBuf::from(path), &asset_id, &project_id, &ffmpeg_path))
        .await
}

pub(crate) fn media_id_embed_impl(
    path: &Path,
    asset_id: &str,
    project_id: &str,
    ffmpeg_path: &str,
) -> AppResult<bool> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => embed_png(path, asset_id, project_id),
        "jpg" | "jpeg" => embed_jpeg(path, asset_id, project_id),
        "webp" => embed_webp(path, asset_id, project_id),
        "mp4" | "webm" => Ok(embed_video(path, asset_id, project_id, ffmpeg_path)),
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn media_id_read(path: String, ffmpeg_path: String) -> AppResult<Option<MediaId>> {
    run_blocking(move || media_id_read_impl(&PathBuf::from(path), &ffmpeg_path)).await
}

fn media_id_read_impl(path: &Path, ffmpeg_path: &str) -> AppResult<Option<MediaId>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => read_png(path),
        "jpg" | "jpeg" => read_jpeg(path),
        "webp" => read_webp(path),
        "mp4" | "webm" => Ok(read_video(path, ffmpeg_path)),
        _ => Ok(None),
    }
}

// ---------- PNG: private tEXt chunk, keyword "aiSLAP" ----------

fn png_text_contents(asset_id: &str, project_id: &str) -> Bytes {
    let text = format!("{{\"assetId\":\"{asset_id}\",\"projectId\":\"{project_id}\"}}");
    let mut buf = Vec::with_capacity(PNG_KEYWORD.len() + 1 + text.len());
    buf.extend_from_slice(PNG_KEYWORD);
    buf.push(0); // PNG tEXt keyword/text null separator
    buf.extend_from_slice(text.as_bytes());
    Bytes::from(buf)
}

fn embed_png(path: &Path, asset_id: &str, project_id: &str) -> AppResult<bool> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let mut png = Png::from_bytes(bytes).map_err(|e| AppError::Msg(format!("png parse: {e}")))?;
    png.chunks_mut()
        .retain(|c| !(c.kind() == *b"tEXt" && c.contents().starts_with(PNG_KEYWORD)));
    let chunk = PngChunk::new(*b"tEXt", png_text_contents(asset_id, project_id));
    // Insert right after the mandatory leading IHDR chunk (index 0), ahead of
    // pixel data — cheap position, doesn't require scanning for IDAT.
    let insert_at = if png.chunks().is_empty() { 0 } else { 1 };
    png.chunks_mut().insert(insert_at, chunk);
    write_atomic(path, png.encoder().bytes())?;
    Ok(true)
}

fn read_png(path: &Path) -> AppResult<Option<MediaId>> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let png = Png::from_bytes(bytes).map_err(|e| AppError::Msg(format!("png parse: {e}")))?;
    for chunk in png.chunks_by_type(*b"tEXt") {
        let contents = chunk.contents();
        if let Some(json) = strip_keyword(contents, PNG_KEYWORD) {
            if let Some(id) = parse_media_id(json) {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

fn strip_keyword<'a>(contents: &'a [u8], keyword: &[u8]) -> Option<&'a [u8]> {
    if !contents.starts_with(keyword) {
        return None;
    }
    let rest = &contents[keyword.len()..];
    rest.strip_prefix(&[0u8][..])
}

// ---------- JPEG: COM segment, magic-prefixed ----------

fn embed_jpeg(path: &Path, asset_id: &str, project_id: &str) -> AppResult<bool> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let mut jpeg = Jpeg::from_bytes(bytes).map_err(|e| AppError::Msg(format!("jpeg parse: {e}")))?;
    jpeg.segments_mut().retain(|s| {
        !(s.marker() == markers::COM && s.contents().starts_with(JPEG_MAGIC.as_bytes()))
    });
    let text = format!("{JPEG_MAGIC}{{\"assetId\":\"{asset_id}\",\"projectId\":\"{project_id}\"}}");
    let segment = JpegSegment::new_with_contents(markers::COM, Bytes::from(text));
    // Index 1 — after the mandatory leading SOI-adjacent segment, before scan data.
    let insert_at = jpeg.segments().len().min(1);
    jpeg.segments_mut().insert(insert_at, segment);
    write_atomic(path, jpeg.encoder().bytes())?;
    Ok(true)
}

fn read_jpeg(path: &Path) -> AppResult<Option<MediaId>> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let jpeg = Jpeg::from_bytes(bytes).map_err(|e| AppError::Msg(format!("jpeg parse: {e}")))?;
    for seg in jpeg.segments_by_marker(markers::COM) {
        let contents = seg.contents();
        if let Some(json) = contents.strip_prefix(JPEG_MAGIC.as_bytes()) {
            if let Some(id) = parse_media_id(json) {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

// ---------- WebP: private RIFF chunk, id "aiSL" ----------

fn embed_webp(path: &Path, asset_id: &str, project_id: &str) -> AppResult<bool> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let mut webp = WebP::from_bytes(bytes).map_err(|e| AppError::Msg(format!("webp parse: {e}")))?;
    webp.chunks_mut().retain(|c| c.id() != WEBP_CHUNK_ID);
    let text = format!("{{\"assetId\":\"{asset_id}\",\"projectId\":\"{project_id}\"}}");
    let chunk = RiffChunk::new(WEBP_CHUNK_ID, RiffContent::Data(Bytes::from(text)));
    webp.chunks_mut().push(chunk);
    write_atomic(path, webp.encoder().bytes())?;
    Ok(true)
}

fn read_webp(path: &Path) -> AppResult<Option<MediaId>> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let webp = WebP::from_bytes(bytes).map_err(|e| AppError::Msg(format!("webp parse: {e}")))?;
    let Some(chunk) = webp.chunk_by_id(WEBP_CHUNK_ID) else {
        return Ok(None);
    };
    let RiffContent::Data(bytes) = chunk.content() else {
        return Ok(None);
    };
    Ok(parse_media_id(bytes))
}

// ---------- MP4/WebM: ffmpeg remux with -metadata tags ----------

/// Best-effort: remux (stream copy, no re-encode) into a temp file with the
/// two metadata tags set, then swap it in for the original. Returns `false`
/// without erroring when ffmpeg is unavailable or the remux fails — the
/// asset id/hash still land in the sidecar either way.
fn embed_video(path: &Path, asset_id: &str, project_id: &str, ffmpeg_path: &str) -> bool {
    let exe = ffmpeg_path.trim();
    if exe.is_empty() || !PathBuf::from(exe).is_file() {
        return false;
    }
    let tmp = tmp_sibling(path);
    let is_mp4 = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    let mut cmd = Command::new(exe);
    cmd.arg("-y").arg("-i").arg(path);
    // The mov/mp4 muxer otherwise only writes its fixed known-key atoms and
    // silently drops anything else — webm/matroska accepts arbitrary keys
    // (as SimpleTags) without this flag, and mov-only flags on a non-mov
    // muxer risk a spurious warning, so it's mp4-only.
    if is_mp4 {
        cmd.args(["-movflags", "use_metadata_tags"]);
    }
    let status = cmd
        .args(["-map_metadata", "0", "-c", "copy"])
        .args(["-metadata", &format!("aislap_asset_id={asset_id}")])
        .args(["-metadata", &format!("aislap_project_id={project_id}")])
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let ok = matches!(status, Ok(s) if s.success()) && tmp.exists();
    if ok {
        if std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// Reads the `aislap_asset_id`/`aislap_project_id` tags back out of ffmpeg's
/// `-i` stderr banner — mirrors `media::video_info_probe`'s no-ffprobe
/// approach, so no extra binary dependency.
fn read_video(path: &Path, ffmpeg_path: &str) -> Option<MediaId> {
    let exe = ffmpeg_path.trim();
    if exe.is_empty() || !PathBuf::from(exe).is_file() {
        return None;
    }
    let output = Command::new(exe)
        .arg("-i")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let banner = String::from_utf8_lossy(&output.stderr);
    let asset_id = banner_tag(&banner, "aislap_asset_id")?;
    let project_id = banner_tag(&banner, "aislap_project_id").unwrap_or_default();
    Some(MediaId {
        asset_id,
        project_id,
    })
}

/// Case-insensitive: the mov/mp4 muxer round-trips key case as given, but
/// the matroska/webm muxer uppercases metadata keys (`AISLAP_ASSET_ID`).
fn banner_tag(banner: &str, key: &str) -> Option<String> {
    for line in banner.lines() {
        let line = line.trim();
        if line.len() < key.len() {
            continue;
        }
        let (head, rest) = line.split_at(key.len());
        if !head.eq_ignore_ascii_case(key) {
            continue;
        }
        if let Some(value) = rest.trim_start().strip_prefix(':') {
            return Some(value.trim().to_string());
        }
    }
    None
}

// ---------- shared ----------

fn parse_media_id(json: &[u8]) -> Option<MediaId> {
    serde_json::from_slice::<MediaId>(json).ok()
}

fn write_atomic(path: &Path, bytes: Bytes) -> AppResult<()> {
    let tmp = tmp_sibling(path);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// A sibling temp path that keeps the original extension (so ffmpeg's
/// muxer-by-extension guess still works for `embed_video`) while staying
/// distinct across files that share a stem but differ in extension —
/// `with_extension("aislap_tmp")` would collapse `foo.png`/`foo.webp` onto
/// the same `foo.aislap_tmp`.
fn tmp_sibling(path: &Path) -> PathBuf {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    path.with_file_name(format!("{stem}.aislap_tmp.{ext}"))
}
