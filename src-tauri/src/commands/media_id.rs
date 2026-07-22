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
use img_parts::ImageEXIF;
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
    png.set_exif(Some(exif_user_comment_bytes(asset_id, project_id)));
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
    if let Some(exif) = png.exif() {
        if let Some(id) = read_exif_user_comment(&exif) {
            return Ok(Some(id));
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
    // Set EXIF before the COM insert below — `Jpeg::set_exif` inserts at a
    // fixed segment index that assumes the segment count/order of the
    // freshly parsed file, so doing it first avoids any interaction with
    // our own insert.
    jpeg.set_exif(Some(exif_user_comment_bytes(asset_id, project_id)));
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
    if let Some(exif) = jpeg.exif() {
        if let Some(id) = read_exif_user_comment(&exif) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

// ---------- WebP: private RIFF chunk, id "aiSL" ----------

fn embed_webp(path: &Path, asset_id: &str, project_id: &str) -> AppResult<bool> {
    let bytes = Bytes::from(std::fs::read(path)?);
    let mut webp = WebP::from_bytes(bytes).map_err(|e| AppError::Msg(format!("webp parse: {e}")))?;
    webp.set_exif(Some(exif_user_comment_bytes(asset_id, project_id)));
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
    if let Some(chunk) = webp.chunk_by_id(WEBP_CHUNK_ID) {
        if let RiffContent::Data(bytes) = chunk.content() {
            if let Some(id) = parse_media_id(bytes) {
                return Ok(Some(id));
            }
        }
    }
    if let Some(exif) = webp.exif() {
        if let Some(id) = read_exif_user_comment(&exif) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

// ---------- EXIF UserComment: standard-tag replica of the same id, so it
// survives a resave by a tool that only knows to preserve real metadata
// (COM/tEXt/private-RIFF above are the primary, faster path; this is a
// secondary, more resave-durable one) ----------

const EXIF_TAG_EXIF_IFD: u16 = 0x8769;
const EXIF_TAG_USER_COMMENT: u16 = 0x9286;
const EXIF_TYPE_LONG: u16 = 4;
const EXIF_TYPE_UNDEFINED: u16 = 7;
const EXIF_ASCII_PREFIX: &[u8; 8] = b"ASCII\0\0\0";

/// Minimal little-endian single-tag TIFF/EXIF blob: IFD0 has one entry (the
/// ExifIFD pointer), the Exif SubIFD has one entry (UserComment), since
/// UserComment is only valid inside the Exif SubIFD, not IFD0. Layout is
/// fixed (offsets 8/26/44) because we control every byte being written;
/// `read_exif_user_comment` below makes no such assumption.
fn exif_user_comment_bytes(asset_id: &str, project_id: &str) -> Bytes {
    let json = format!("{{\"assetId\":\"{asset_id}\",\"projectId\":\"{project_id}\"}}");
    let comment_len = EXIF_ASCII_PREFIX.len() + json.len();

    let mut buf = Vec::with_capacity(44 + comment_len);
    buf.extend_from_slice(b"II");
    buf.extend_from_slice(&0x002Au16.to_le_bytes());
    buf.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset

    // IFD0: one entry — ExifIFD pointer -> SubIFD at offset 26.
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&EXIF_TAG_EXIF_IFD.to_le_bytes());
    buf.extend_from_slice(&EXIF_TYPE_LONG.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.extend_from_slice(&26u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // next IFD

    // Exif SubIFD: one entry — UserComment, value stored out-of-line at
    // offset 44 (its count is always > 4 bytes: the 8-byte code
    // designation prefix alone already exceeds that).
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&EXIF_TAG_USER_COMMENT.to_le_bytes());
    buf.extend_from_slice(&EXIF_TYPE_UNDEFINED.to_le_bytes());
    buf.extend_from_slice(&(comment_len as u32).to_le_bytes());
    buf.extend_from_slice(&44u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // next IFD

    debug_assert_eq!(buf.len(), 44);
    buf.extend_from_slice(EXIF_ASCII_PREFIX);
    buf.extend_from_slice(json.as_bytes());

    Bytes::from(buf)
}

fn exif_u16(b: &[u8], le: bool) -> u16 {
    if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
}

fn exif_u32(b: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }
}

/// Scans one IFD for `UserComment` directly, or follows an `ExifIFD`
/// pointer into a SubIFD and scans that (one level of indirection — matches
/// what any real EXIF writer produces, including a resave that rewrote byte
/// order or reordered/flattened tags). Bounds-checked throughout since this
/// may run against a TIFF blob written by a tool we don't control.
fn scan_ifd_for_user_comment(exif: &[u8], ifd_offset: usize, le: bool, depth: u8) -> Option<Bytes> {
    if depth > 1 {
        return None;
    }
    let count = exif_u16(exif.get(ifd_offset..ifd_offset + 2)?, le) as usize;
    let mut exif_ifd_offset: Option<usize> = None;
    for i in 0..count {
        let entry_off = ifd_offset + 2 + i * 12;
        let entry = exif.get(entry_off..entry_off + 12)?;
        let tag = exif_u16(&entry[0..2], le);
        match tag {
            EXIF_TAG_USER_COMMENT => {
                let cnt = exif_u32(&entry[4..8], le) as usize;
                let value = if cnt <= 4 {
                    entry.get(8..8 + cnt)?.to_vec()
                } else {
                    let off = exif_u32(&entry[8..12], le) as usize;
                    exif.get(off..off + cnt)?.to_vec()
                };
                return Some(Bytes::from(value));
            }
            EXIF_TAG_EXIF_IFD => {
                exif_ifd_offset = Some(exif_u32(&entry[8..12], le) as usize);
            }
            _ => {}
        }
    }
    scan_ifd_for_user_comment(exif, exif_ifd_offset?, le, depth + 1)
}

fn read_exif_user_comment(exif: &[u8]) -> Option<MediaId> {
    let le = match exif.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let ifd0_offset = exif_u32(exif.get(4..8)?, le) as usize;
    let value = scan_ifd_for_user_comment(exif, ifd0_offset, le, 0)?;
    let json = value.strip_prefix(EXIF_ASCII_PREFIX.as_slice())?;
    parse_media_id(json)
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

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::{BufMut, BytesMut};

    // A handful of placeholder segments ahead of SOS — `img-parts`'s own
    // `Jpeg::set_exif` inserts at a fixed segment index, which real encoder
    // output always has room for; this fixture mirrors that shape rather
    // than the bare-minimum a decoder would accept.
    fn minimal_jpeg_bytes() -> Bytes {
        let mut buf = BytesMut::new();
        buf.put_u8(0xFF);
        buf.put_u8(0xD8); // SOI
        for marker in [0xE0u8, 0xDB, 0xC0, 0xC4] {
            buf.put_u8(0xFF);
            buf.put_u8(marker);
            buf.put_u16(4);
            buf.put_u16(0x0000);
        }
        buf.put_u8(0xFF);
        buf.put_u8(0xDA); // SOS
        buf.put_u16(4);
        buf.put_u16(0x0000);
        buf.put_slice(&[0xDE, 0xAD, 0xBE, 0xEF]); // placeholder scan data
        buf.put_u8(0xFF);
        buf.put_u8(0xD9); // EOI
        buf.freeze()
    }

    fn minimal_png_bytes() -> Bytes {
        const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let mut ihdr = BytesMut::new();
        ihdr.put_u32(1); // width
        ihdr.put_u32(1); // height
        ihdr.put_u8(8); // bit depth
        ihdr.put_u8(0); // color type: grayscale
        ihdr.put_u8(0); // compression
        ihdr.put_u8(0); // filter
        ihdr.put_u8(0); // interlace

        let mut buf = BytesMut::new();
        buf.extend_from_slice(&SIGNATURE);
        buf.extend_from_slice(&PngChunk::new(*b"IHDR", ihdr.freeze()).encoder().bytes());
        buf.extend_from_slice(&PngChunk::new(*b"IDAT", Bytes::from_static(&[0x00])).encoder().bytes());
        buf.extend_from_slice(&PngChunk::new(*b"IEND", Bytes::new()).encoder().bytes());
        buf.freeze()
    }

    fn minimal_webp_bytes() -> Bytes {
        // Minimal valid VP8 keyframe header: 3-byte tag (LSB=0 -> keyframe),
        // the fixed magic bytes, then 1x1 width/height (LE u16 each) — this
        // crate's `kind()`/`infer_kind()` parse the frame header for real,
        // so an arbitrary placeholder isn't accepted here like it is for
        // the opaque JPEG/PNG chunk contents used elsewhere in this file.
        let vp8_frame = [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00];
        let vp8 = RiffChunk::new(*b"VP8 ", RiffContent::Data(Bytes::copy_from_slice(&vp8_frame)));
        let riff = RiffChunk::new(
            *b"RIFF",
            RiffContent::List {
                kind: Some(*b"WEBP"),
                subchunks: vec![vp8],
            },
        );
        riff.encoder().bytes()
    }

    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aislap_media_id_test_{name}_{}", std::process::id()));
        p
    }

    #[test]
    fn exif_user_comment_round_trips() {
        let exif = exif_user_comment_bytes("asset-1", "project-1");
        let id = read_exif_user_comment(&exif).expect("should parse own output");
        assert_eq!(id.asset_id, "asset-1");
        assert_eq!(id.project_id, "project-1");
    }

    #[test]
    fn exif_user_comment_reads_big_endian_direct_ifd0_entry() {
        // Not our own writer's layout: big-endian byte order, and
        // UserComment placed directly in IFD0 with no ExifIFD indirection —
        // proves the reader doesn't just mirror the writer's exact shape.
        let json = br#"{"assetId":"be-asset","projectId":"be-project"}"#;
        let comment_len = EXIF_ASCII_PREFIX.len() + json.len();

        let mut buf = Vec::new();
        buf.extend_from_slice(b"MM");
        buf.extend_from_slice(&0x002Au16.to_be_bytes());
        buf.extend_from_slice(&8u32.to_be_bytes());
        buf.extend_from_slice(&1u16.to_be_bytes()); // IFD0: 1 entry
        buf.extend_from_slice(&EXIF_TAG_USER_COMMENT.to_be_bytes());
        buf.extend_from_slice(&EXIF_TYPE_UNDEFINED.to_be_bytes());
        buf.extend_from_slice(&(comment_len as u32).to_be_bytes());
        buf.extend_from_slice(&26u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes()); // next IFD
        buf.extend_from_slice(EXIF_ASCII_PREFIX);
        buf.extend_from_slice(json);

        let id = read_exif_user_comment(&buf).expect("should parse BE + direct-IFD0 layout");
        assert_eq!(id.asset_id, "be-asset");
        assert_eq!(id.project_id, "be-project");
    }

    #[test]
    fn jpeg_exif_survives_com_strip() {
        let path = temp_path("jpeg");
        std::fs::write(&path, minimal_jpeg_bytes()).unwrap();

        embed_jpeg(&path, "jpeg-asset", "jpeg-project").unwrap();
        let id = read_jpeg(&path).unwrap().expect("primary COM marker readable");
        assert_eq!(id.asset_id, "jpeg-asset");

        let mut jpeg = Jpeg::from_bytes(Bytes::from(std::fs::read(&path).unwrap())).unwrap();
        jpeg.remove_segments_by_marker(markers::COM);
        std::fs::write(&path, jpeg.encoder().bytes()).unwrap();

        let id = read_jpeg(&path)
            .unwrap()
            .expect("EXIF UserComment still readable after COM strip");
        assert_eq!(id.asset_id, "jpeg-asset");
        assert_eq!(id.project_id, "jpeg-project");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn png_exif_survives_text_strip() {
        let path = temp_path("png");
        std::fs::write(&path, minimal_png_bytes()).unwrap();

        embed_png(&path, "png-asset", "png-project").unwrap();
        let id = read_png(&path).unwrap().expect("primary tEXt marker readable");
        assert_eq!(id.asset_id, "png-asset");

        let mut png = Png::from_bytes(Bytes::from(std::fs::read(&path).unwrap())).unwrap();
        png.remove_chunks_by_type(*b"tEXt");
        std::fs::write(&path, png.encoder().bytes()).unwrap();

        let id = read_png(&path)
            .unwrap()
            .expect("EXIF UserComment still readable after tEXt strip");
        assert_eq!(id.asset_id, "png-asset");
        assert_eq!(id.project_id, "png-project");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn webp_exif_survives_private_chunk_strip() {
        let path = temp_path("webp");
        std::fs::write(&path, minimal_webp_bytes()).unwrap();

        embed_webp(&path, "webp-asset", "webp-project").unwrap();
        let id = read_webp(&path).unwrap().expect("primary private chunk readable");
        assert_eq!(id.asset_id, "webp-asset");

        let mut webp = WebP::from_bytes(Bytes::from(std::fs::read(&path).unwrap())).unwrap();
        webp.chunks_mut().retain(|c| c.id() != WEBP_CHUNK_ID);
        std::fs::write(&path, webp.encoder().bytes()).unwrap();

        let id = read_webp(&path)
            .unwrap()
            .expect("EXIF UserComment still readable after private-chunk strip");
        assert_eq!(id.asset_id, "webp-asset");
        assert_eq!(id.project_id, "webp-project");

        std::fs::remove_file(&path).ok();
    }
}
