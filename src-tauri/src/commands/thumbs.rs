//! The thumbnail cache: one flat `<project>/.aislap/thumbs/` per project.
//!
//! Before this existed, only videos and 3D models had a derivative. A still
//! rendered its full-resolution original into an 80–500px tile, so a shot of
//! 110 stills pulled ~208MB across the network on every gallery mount — and a
//! tab switch remounts the gallery. The legacy `.thumb.png` posters were worse
//! still at ~8MB apiece.
//!
//! Everything here is derived and disposable (`architecture.md` §2): deleting
//! the cache costs a re-sweep and nothing else.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use serde::Serialize;

use crate::commands::fsutil::{
    as_str, existing_thumb_path, is_image_ext, is_model3d_ext, is_video_ext, list_dirs,
    project_root_for, rel_of, thumb_cache_dir, thumb_cache_key, thumb_cache_path, thumb_stat,
    ProjectRoot, THUMB_CACHE_EXT, TRASH_DIR,
};
use crate::commands::prism::prism_root_for;
use crate::commands::walk;
use crate::error::{run_blocking, AppError, AppResult};

/// Longest edge of a cached thumbnail, in pixels. The widest a tile ever
/// renders is `THUMB_WIDTH_RANGE[1]` = 500 CSS px, so this covers a 2x display
/// with room to spare. Sources smaller than this are never upscaled.
pub(crate) const THUMB_MAX_EDGE: u32 = 1024;
/// JPEG quality. 80 puts a 16:9 frame at roughly 60-90KB.
const THUMB_QUALITY: u8 = 80;

/// What one sweep did. Surfaced in the UI so "nothing happened" and "ffmpeg
/// isn't configured, so your videos have no posters" are distinguishable.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbsReport {
    pub images_encoded: usize,
    pub posters_upgraded: usize,
    pub posters_extracted: usize,
    pub skipped_no_ffmpeg: usize,
    pub pruned: usize,
    pub failed: usize,
}

// ---------- the in-memory index ----------
//
// Membership has to be answerable without touching the disk. A gallery rescan
// runs after every generation iteration and asks about every file in the shot;
// stat-ing the cache per file would be a few hundred extra SMB round trips each
// time. One `read_dir` of the flat cache directory per project per session
// answers all of them, and every write keeps it current.
//
// Same shape and the same reasoning as `db::LOCAL_DBS`.
static THUMB_INDEX: OnceLock<Mutex<HashMap<PathBuf, HashSet<String>>>> = OnceLock::new();

fn index() -> &'static Mutex<HashMap<PathBuf, HashSet<String>>> {
    THUMB_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache keys present for `project_root`, reading the directory once per
/// session. A missing directory is an empty set, not an error — a project that
/// has never been swept is the normal first-run state.
fn keys_for(project_root: &Path) -> HashSet<String> {
    let mut guard = index().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.get(project_root) {
        return set.clone();
    }
    let mut set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(thumb_cache_dir(project_root)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some(THUMB_CACHE_EXT) {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                set.insert(stem.to_string());
            }
        }
    }
    guard.insert(project_root.to_path_buf(), set.clone());
    set
}

fn index_insert(project_root: &Path, key: String) {
    let mut guard = index().lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(project_root.to_path_buf())
        .or_default()
        .insert(key);
}

fn index_remove(project_root: &Path, key: &str) {
    let mut guard = index().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.get_mut(project_root) {
        set.remove(key);
    }
}

// ---------- lookup, for the gallery scan ----------

/// The cache key a media file would use, from metadata already in hand.
pub(crate) fn key_for(
    root: &ProjectRoot,
    media: &Path,
    meta: &std::fs::Metadata,
) -> Option<String> {
    let rel = root.rel(media)?;
    let (mtime_ms, len) = thumb_stat(meta);
    Some(thumb_cache_key(&rel, mtime_ms, len))
}

/// Everything a directory scan needs to resolve thumbnails without touching the
/// disk: the project root it is relativizing against, and that project's cache
/// keys read once up front.
pub(crate) struct ThumbCtx {
    root: ProjectRoot,
    keys: HashSet<String>,
}

impl ThumbCtx {
    pub(crate) fn for_project(project_root: &Path) -> Self {
        Self {
            root: ProjectRoot::from_root(project_root.to_path_buf()),
            keys: keys_for(project_root),
        }
    }

    /// The thumbnail a media file should render, or `None` for "no derivative
    /// yet" — in which case the frontend shows the original for a still and an
    /// icon for a video.
    ///
    /// 3D previews are deliberately excluded from the cache: they arrive from
    /// the provider as RGBA and flattening them to JPEG would cost the
    /// transparency that is the point of them, so they keep the sibling
    /// `.thumb.png` (`storage.md`).
    pub(crate) fn lookup(&self, media: &Path) -> Option<PathBuf> {
        if is_model3d_ext(media) {
            return existing_thumb_path(media);
        }
        let key = media
            .metadata()
            .ok()
            .and_then(|meta| key_for(&self.root, media, &meta));
        if let Some(key) = key {
            if self.keys.contains(&key) {
                return Some(thumb_cache_path(&self.root.path, &key));
            }
        }
        // Not swept yet. A legacy sibling is still better than nothing — for a
        // video it is the only thing standing between the tile and a real
        // `<video>` element mounted to read the container header.
        existing_thumb_path(media)
    }
}

/// The cached thumbnail for one media path, for callers that hold a bare path
/// rather than a scanned `GalleryImage` — the timeline strip, whose clips point
/// at media by path and never went through a gallery scan.
///
/// `None` means "render the original" (or, for a video, an icon). Not an error
/// when the path is outside any project: the timeline can reference media that
/// has been moved out from under it.
#[tauri::command]
pub async fn thumb_lookup(path: String) -> AppResult<Option<String>> {
    run_blocking(move || {
        let media = PathBuf::from(path);
        let Ok(root) = project_root_for(&media) else {
            return Ok(None);
        };
        Ok(ThumbCtx::for_project(&root)
            .lookup(&media)
            .map(|t| as_str(&t)))
    })
    .await
}

// ---------- encoding ----------

/// Decode, downscale, and write a JPEG. Written to a temp name and renamed, so
/// an interrupted sweep leaves either the old file or the new one, never a
/// half-written image that would render as a broken tile forever.
fn encode_thumb(src: &Path, dst: &Path) -> AppResult<()> {
    let img =
        image::open(src).map_err(|e| AppError::Msg(format!("decode {}: {e}", as_str(src))))?;
    let (w, h) = (img.width(), img.height());
    // Never upscale — a 512px source stays 512px.
    let scaled = if w > THUMB_MAX_EDGE || h > THUMB_MAX_EDGE {
        img.resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, FilterType::Triangle)
    } else {
        img
    };
    // JPEG has no alpha. `to_rgb8` composites onto black, which is what the
    // tile renders against anyway (`bg-bg` behind an `object-cover` image), so
    // a masked output still reads correctly.
    let rgb = scaled.to_rgb8();

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = dst.with_extension("jpg.tmp");
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY)
            .encode_image(&rgb)
            .map_err(|e| AppError::Msg(format!("encode {}: {e}", as_str(dst))))?;
    }
    // Windows won't rename onto an existing file.
    let _ = std::fs::remove_file(dst);
    std::fs::rename(&tmp, dst).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// Outcome of considering one media file. Drives the counters in [`ThumbsReport`].
enum Outcome {
    Skipped,
    ImageEncoded,
    PosterUpgraded,
    PosterExtracted,
    NoFfmpeg,
    Failed,
}

/// The decision tree, one media file at a time.
///
/// Every arm is an existence check, which is what makes a sweep idempotent and
/// safe to interrupt and re-run.
fn ensure_one(
    root: &ProjectRoot,
    keys: &HashSet<String>,
    media: &Path,
    ffmpeg: &str,
    in_prism: bool,
) -> Outcome {
    // 3D keeps its sibling RGBA preview, always.
    if is_model3d_ext(media) {
        return Outcome::Skipped;
    }
    let Ok(meta) = media.metadata() else {
        return Outcome::Failed;
    };
    let Some(key) = key_for(root, media, &meta) else {
        return Outcome::Failed;
    };
    if keys.contains(&key) {
        return Outcome::Skipped;
    }
    let dst = thumb_cache_path(&root.path, &key);

    // A legacy sibling poster is a decoded frame we already have — re-encoding
    // it is far cheaper than asking ffmpeg to seek the video again, and it is
    // the only path available when ffmpeg isn't configured.
    let legacy = existing_thumb_path(media);
    if let Some(ref legacy_path) = legacy {
        return match encode_thumb(legacy_path, &dst) {
            Ok(()) => {
                index_insert(&root.path, key);
                // aiSLAP never removes files in a PRISM project. Leaving the
                // PNG costs disk, not correctness — nothing reads it once the
                // cache entry exists.
                if !in_prism {
                    let _ = std::fs::remove_file(legacy_path);
                }
                Outcome::PosterUpgraded
            }
            Err(e) => {
                tracing::warn!("thumb upgrade failed for {}: {e}", as_str(media));
                Outcome::Failed
            }
        };
    }

    if is_image_ext(media) {
        return match encode_thumb(media, &dst) {
            Ok(()) => {
                index_insert(&root.path, key);
                Outcome::ImageEncoded
            }
            Err(e) => {
                tracing::warn!("thumb encode failed for {}: {e}", as_str(media));
                Outcome::Failed
            }
        };
    }

    if is_video_ext(media) {
        if ffmpeg.trim().is_empty() {
            return Outcome::NoFfmpeg;
        }
        // ffmpeg writes the scaled JPEG straight into the cache — no second
        // encode pass, and `thumb_args` already caps it at THUMB_MAX_EDGE.
        let extracted = crate::commands::media::extract_poster(media, &dst, ffmpeg);
        return match extracted {
            Ok(true) => {
                index_insert(&root.path, key);
                Outcome::PosterExtracted
            }
            Ok(false) => Outcome::NoFfmpeg,
            Err(e) => {
                tracing::warn!("poster extract failed for {}: {e}", as_str(media));
                Outcome::Failed
            }
        };
    }

    Outcome::Skipped
}

// ---------- move/rename support ----------

/// Follow a media file's cache entry to its new path.
///
/// The key contains the project-relative path, so without this a move would
/// orphan the entry and the tile would fall back to the full-resolution
/// original until the next sweep. Best-effort throughout: a miss just means the
/// next sweep re-encodes it.
pub(crate) fn rename_cache_entry(from: &Path, to: &Path) {
    let Ok(root_path) = project_root_for(to) else {
        return;
    };
    let root = ProjectRoot::from_root(root_path);
    // `to` exists (the move already happened), `from` does not — so both keys
    // have to be built from the destination's metadata.
    let Ok(meta) = to.metadata() else { return };
    let (mtime_ms, len) = thumb_stat(&meta);
    // `from` no longer exists, so it can't be canonicalized — `rel_of` falls
    // back to a plain prefix strip for exactly this case.
    let (Some(rel_from), Some(rel_to)) = (rel_of(from, &root.path), root.rel(to)) else {
        return;
    };
    let old_key = thumb_cache_key(&rel_from, mtime_ms, len);
    let new_key = thumb_cache_key(&rel_to, mtime_ms, len);
    if old_key == new_key {
        return;
    }
    let old = thumb_cache_path(&root.path, &old_key);
    let new = thumb_cache_path(&root.path, &new_key);
    if !old.is_file() {
        return;
    }
    let _ = std::fs::remove_file(&new);
    if std::fs::rename(&old, &new).is_ok() {
        index_remove(&root.path, &old_key);
        index_insert(&root.path, new_key);
    }
}

/// Copy a media file's cache entry alongside a copied file.
pub(crate) fn copy_cache_entry(from: &Path, to: &Path) {
    let Ok(root_path) = project_root_for(to) else {
        return;
    };
    let root = ProjectRoot::from_root(root_path);
    let (Ok(from_meta), Ok(to_meta)) = (from.metadata(), to.metadata()) else {
        return;
    };
    let (Some(rel_from), Some(rel_to)) = (root.rel(from), root.rel(to)) else {
        return;
    };
    let (fm, fl) = thumb_stat(&from_meta);
    let (tm, tl) = thumb_stat(&to_meta);
    let old_key = thumb_cache_key(&rel_from, fm, fl);
    let new_key = thumb_cache_key(&rel_to, tm, tl);
    if old_key == new_key {
        return;
    }
    let old = thumb_cache_path(&root.path, &old_key);
    let new = thumb_cache_path(&root.path, &new_key);
    if !old.is_file() {
        return;
    }
    if std::fs::copy(&old, &new).is_ok() {
        index_insert(&root.path, new_key);
    }
}

// ---------- the sweep ----------

/// Build any missing thumbnails under `root`.
///
/// `recursive` walks the whole project (and prunes); otherwise only the given
/// directory and its immediate version/SRC folders — the per-shot case that
/// runs after a rescan.
///
/// Sequential on purpose: these projects live on SMB, which rewards one or two
/// readers and punishes a hundred.
#[tauri::command]
pub async fn thumbs_ensure(
    root: String,
    recursive: bool,
    ffmpeg_path: String,
) -> AppResult<ThumbsReport> {
    run_blocking(move || thumbs_ensure_impl(&PathBuf::from(root), recursive, &ffmpeg_path)).await
}

fn thumbs_ensure_impl(root: &Path, recursive: bool, ffmpeg: &str) -> AppResult<ThumbsReport> {
    let project_root = project_root_for(root)?;
    let project = ProjectRoot::from_root(project_root);
    let in_prism = prism_root_for(&project.path).is_some();
    let keys = keys_for(&project.path);

    let media = collect_media(root, recursive)?;
    let mut report = ThumbsReport::default();
    for path in &media {
        match ensure_one(&project, &keys, path, ffmpeg, in_prism) {
            Outcome::Skipped => {}
            Outcome::ImageEncoded => report.images_encoded += 1,
            Outcome::PosterUpgraded => report.posters_upgraded += 1,
            Outcome::PosterExtracted => report.posters_extracted += 1,
            Outcome::NoFfmpeg => report.skipped_no_ffmpeg += 1,
            Outcome::Failed => report.failed += 1,
        }
    }

    if recursive {
        report.pruned = prune(&project, &media);
    }
    Ok(report)
}

/// Media files to consider, in gallery order so the columns a user is looking
/// at get their thumbnails first.
fn collect_media(root: &Path, recursive: bool) -> AppResult<Vec<PathBuf>> {
    let mut out = Vec::new();
    if recursive {
        collect_recursive(root, &mut out);
    } else {
        // A shot: its own files, then each version/SRC folder under it.
        out.extend(walk::dir_media(root).unwrap_or_default());
        for dir in list_dirs(root).unwrap_or_default() {
            if dir
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'))
            {
                continue;
            }
            out.extend(walk::dir_media(&dir).unwrap_or_default());
        }
    }
    Ok(out)
}

fn collect_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    out.extend(walk::dir_media(dir).unwrap_or_default());
    for sub in list_dirs(dir).unwrap_or_default() {
        let Some(name) = sub.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // `.aislap` (the cache itself), `$`-prefixed pipeline scratch, and
        // TRASH — the same exclusions every other traversal makes.
        if name.starts_with('.') || name.starts_with('$') || name == TRASH_DIR {
            continue;
        }
        collect_recursive(&sub, out);
    }
}

/// Delete cache entries that no live media file claims.
///
/// Only runs on a full recursive sweep, because only then is `live` actually
/// the complete set — pruning off a single shot's walk would delete the rest of
/// the project's thumbnails.
fn prune(project: &ProjectRoot, live_media: &[PathBuf]) -> usize {
    let mut live: HashSet<String> = HashSet::new();
    for path in live_media {
        if let Ok(meta) = path.metadata() {
            if let Some(k) = key_for(project, path, &meta) {
                live.insert(k);
            }
        }
    }
    let dir = thumb_cache_dir(&project.path);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut pruned = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // A `.jpg.tmp` is an encode that was killed between create and rename.
        // Nothing will ever claim it, so a full sweep is where it gets cleaned.
        if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
            if std::fs::remove_file(&path).is_ok() {
                pruned += 1;
            }
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some(THUMB_CACHE_EXT) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if live.contains(stem) {
            continue;
        }
        let key = stem.to_string();
        if std::fs::remove_file(&path).is_ok() {
            index_remove(&project.path, &key);
            pruned += 1;
        }
    }
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::fsutil::CACHE_DIR;
    use crate::testutil::TestProject;

    #[test]
    fn cache_key_changes_with_mtime_and_size() {
        let a = thumb_cache_key("shots/s10/v001/a.png", 1000, 500);
        assert_eq!(a, thumb_cache_key("shots/s10/v001/a.png", 1000, 500));
        assert_ne!(a, thumb_cache_key("shots/s10/v001/a.png", 1001, 500));
        assert_ne!(a, thumb_cache_key("shots/s10/v001/a.png", 1000, 501));
        assert_ne!(a, thumb_cache_key("shots/s10/v002/a.png", 1000, 500));
    }

    #[test]
    fn cache_key_is_case_insensitive() {
        assert_eq!(
            thumb_cache_key("Shots/S10/A.PNG", 7, 9),
            thumb_cache_key("shots/s10/a.png", 7, 9)
        );
    }

    /// The cache lives inside the project it belongs to, so the only thing
    /// keeping it out of every gallery scan is that `.aislap` is `.`-prefixed
    /// and `list_dirs` skips those. Renaming the constant without that property
    /// would silently start scanning thumbnails as media.
    #[test]
    fn cache_dir_is_hidden_from_traversal() {
        assert!(CACHE_DIR.starts_with('.'));
        let dir = std::env::temp_dir().join("aislap-cache-hidden-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(CACHE_DIR).join("thumbs")).unwrap();
        std::fs::create_dir_all(dir.join("v001")).unwrap();
        let dirs = list_dirs(&dir).unwrap();
        assert_eq!(dirs.len(), 1, "only v001 should be listed, got {dirs:?}");
        assert!(dirs[0].ends_with("v001"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aislap-thumbs-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Write a solid-colour PNG of the given size, as a stand-in for a render.
    fn write_png(path: &Path, w: u32, h: u32) {
        let buf = image::RgbImage::from_pixel(w, h, image::Rgb([10, 120, 200]));
        image::DynamicImage::ImageRgb8(buf).save(path).unwrap();
    }

    /// The whole point: a full-resolution still must come out small enough that
    /// a few hundred of them can be read over a network share.
    #[test]
    fn encode_downscales_a_full_res_still() {
        let dir = scratch("downscale");
        let src = dir.join("big.png");
        write_png(&src, 1920, 1080);
        let dst = dir.join("out.jpg");
        encode_thumb(&src, &dst).unwrap();

        let dims = imagesize::size(&dst).unwrap();
        assert_eq!(dims.width, THUMB_MAX_EDGE as usize);
        assert_eq!(dims.height, 576, "aspect must be preserved");
        let src_len = std::fs::metadata(&src).unwrap().len();
        let dst_len = std::fs::metadata(&dst).unwrap().len();
        assert!(
            dst_len < src_len,
            "thumb ({dst_len}B) must be smaller than source ({src_len}B)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Blowing a 256px source up to 1024 would make the cache *bigger* than the
    /// file it stands in for.
    #[test]
    fn encode_never_upscales() {
        let dir = scratch("noupscale");
        let src = dir.join("small.png");
        write_png(&src, 256, 128);
        let dst = dir.join("out.jpg");
        encode_thumb(&src, &dst).unwrap();

        let dims = imagesize::size(&dst).unwrap();
        assert_eq!((dims.width, dims.height), (256, 128));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An interrupted encode must not leave a `.jpg.tmp` masquerading as a
    /// cache entry, and a re-encode over an existing entry must succeed on
    /// Windows (where rename onto an existing file fails).
    #[test]
    fn encode_leaves_no_temp_and_overwrites() {
        let dir = scratch("tmp");
        let src = dir.join("a.png");
        write_png(&src, 640, 480);
        let dst = dir.join("out.jpg");
        encode_thumb(&src, &dst).unwrap();
        encode_thumb(&src, &dst).unwrap();
        assert!(dst.is_file());
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cache entry sits under `<project>/.aislap/thumbs/`, never beside its
    /// media — that is the whole difference from the legacy sibling scheme.
    #[test]
    fn cache_path_is_project_level() {
        let root = Path::new("C:/proj");
        let p = thumb_cache_path(root, "abc123");
        assert!(p.starts_with(root.join(CACHE_DIR)));
        assert!(as_str(&p).ends_with("/.aislap/thumbs/abc123.jpg"));
    }

    // ---------- the sweep, end to end ----------

    /// A real still at `rel`, since the sweep has to actually decode it.
    fn still(project: &TestProject, rel: &str, w: u32, h: u32) -> PathBuf {
        let path = project.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_png(&path, w, h);
        path
    }

    /// The headline behaviour: a still that never had a derivative gets one, in
    /// the cache rather than beside itself.
    #[test]
    fn sweep_gives_a_still_a_cache_entry() {
        let project = TestProject::new("thumbs-still");
        let media = still(&project, "SQ01/sh010/v0001/a.png", 1600, 900);
        let shot = project.root.join("SQ01/sh010");

        let report = thumbs_ensure_impl(&shot, false, "").unwrap();
        assert_eq!(report.images_encoded, 1, "{report:?}");

        let ctx = ThumbCtx::for_project(&project.root);
        let thumb = ctx.lookup(&media).expect("thumbnail resolved");
        assert!(thumb.starts_with(thumb_cache_dir(&project.root)));
        assert!(thumb.is_file());
        // Nothing was written beside the media.
        assert!(existing_thumb_path(&media).is_none());

        // And it is idempotent — a second sweep finds nothing to do.
        let again = thumbs_ensure_impl(&shot, false, "").unwrap();
        assert_eq!(again.images_encoded, 0, "{again:?}");
    }

    /// Legacy posters are the single biggest win (~8MB each in the wild), and
    /// outside PRISM the superseded PNG is disposable.
    #[test]
    fn sweep_upgrades_a_legacy_poster_and_removes_it() {
        let project = TestProject::new("thumbs-legacy");
        let video = project.media("SQ01/sh010/v0001/clip.mp4", None);
        let legacy = video.with_file_name("clip.thumb.png");
        write_png(&legacy, 1920, 1080);

        let report = thumbs_ensure_impl(&project.root.join("SQ01/sh010"), false, "").unwrap();
        assert_eq!(report.posters_upgraded, 1, "{report:?}");
        assert!(!legacy.exists(), "the superseded PNG should be gone");
        assert!(ThumbCtx::for_project(&project.root)
            .lookup(&video)
            .is_some_and(|t| t.starts_with(thumb_cache_dir(&project.root))));
    }

    /// Same upgrade, but aiSLAP never removes files in a PRISM project. The
    /// PNG stays and is simply never read again.
    #[test]
    fn sweep_keeps_a_legacy_poster_in_prism() {
        let project = TestProject::prism("thumbs-legacy-prism");
        let video = project.media(
            "03_Production/Shots/SQ01/s010/Renders/AI/v0001/clip.mp4",
            None,
        );
        let legacy = video.with_file_name("clip.thumb.png");
        write_png(&legacy, 1920, 1080);

        let report = thumbs_ensure_impl(video.parent().unwrap(), false, "").unwrap();
        assert_eq!(report.posters_upgraded, 1, "{report:?}");
        assert!(legacy.exists(), "PRISM_NO_DELETE: the PNG must survive");
    }

    /// 3D previews arrive from the provider as RGBA. Flattening one to JPEG
    /// would cost the transparency that is the point of it, so the sweep must
    /// leave both the sibling and the cache alone.
    #[test]
    fn sweep_never_touches_a_3d_preview() {
        let project = TestProject::new("thumbs-3d");
        let model = project.media("SQ01/sh010/v0001/mesh.glb", None);
        let preview = model.with_file_name("mesh.thumb.png");
        write_png(&preview, 512, 512);

        let report = thumbs_ensure_impl(&project.root.join("SQ01/sh010"), false, "").unwrap();
        assert_eq!(report.images_encoded, 0, "{report:?}");
        assert_eq!(report.posters_upgraded, 0, "{report:?}");
        assert!(preview.exists(), "the RGBA preview must survive");
        // And it still resolves — via the sibling, not the cache.
        assert_eq!(
            ThumbCtx::for_project(&project.root).lookup(&model),
            Some(preview)
        );
    }

    /// A video with no poster and no ffmpeg is reported, not silently skipped —
    /// it's the difference between "nothing to do" and "your videos can't have
    /// posters until you configure a path".
    #[test]
    fn sweep_reports_videos_it_cannot_poster() {
        let project = TestProject::new("thumbs-noffmpeg");
        project.media("SQ01/sh010/SRC/layout.mp4", None);
        let report = thumbs_ensure_impl(&project.root.join("SQ01/sh010"), false, "").unwrap();
        assert_eq!(report.skipped_no_ffmpeg, 1, "{report:?}");
        assert_eq!(report.failed, 0, "{report:?}");
    }

    /// Only a full sweep prunes, and it must not take live entries with it —
    /// pruning off a single shot's walk would delete the rest of the project.
    #[test]
    fn full_sweep_prunes_orphans_but_keeps_live_entries() {
        let project = TestProject::new("thumbs-prune");
        let keeper = still(&project, "SQ01/sh010/v0001/keep.png", 800, 600);
        let doomed = still(&project, "SQ01/sh010/v0001/gone.png", 800, 600);

        thumbs_ensure_impl(&project.root, true, "").unwrap();
        let ctx = ThumbCtx::for_project(&project.root);
        let keeper_thumb = ctx.lookup(&keeper).unwrap();
        let doomed_thumb = ctx.lookup(&doomed).unwrap();
        assert!(keeper_thumb.is_file() && doomed_thumb.is_file());

        // Media removed behind aiSLAP's back — the orphan case.
        std::fs::remove_file(&doomed).unwrap();
        let report = thumbs_ensure_impl(&project.root, true, "").unwrap();
        assert_eq!(report.pruned, 1, "{report:?}");
        assert!(keeper_thumb.is_file(), "the live entry must survive");
        assert!(!doomed_thumb.exists(), "the orphan must be gone");
    }

    /// The cache is keyed by relative path, so a rename would orphan the entry
    /// and blank the tile. `image.rs` carries it across; this is that contract.
    #[test]
    fn a_rename_carries_the_cache_entry() {
        let project = TestProject::new("thumbs-rename");
        let before = still(&project, "SQ01/sh010/v0001/a.png", 800, 600);
        thumbs_ensure_impl(&project.root.join("SQ01/sh010"), false, "").unwrap();
        let old_thumb = ThumbCtx::for_project(&project.root)
            .lookup(&before)
            .unwrap();

        let after = before.with_file_name("b.png");
        std::fs::rename(&before, &after).unwrap();
        rename_cache_entry(&before, &after);

        let thumb = ThumbCtx::for_project(&project.root).lookup(&after);
        assert!(
            thumb.as_ref().is_some_and(|t| t.is_file()),
            "renamed media should still resolve a cached thumbnail, got {thumb:?}"
        );
        assert!(!old_thumb.exists(), "the old key should not be left behind");
    }

    /// A shot-scoped sweep walks the shot's own files and its version/SRC
    /// folders, and must not wander into the cache directory it just wrote.
    #[test]
    fn shot_sweep_covers_version_folders_and_skips_the_cache() {
        let project = TestProject::new("thumbs-scope");
        still(&project, "SQ01/sh010/v0001/a.png", 400, 300);
        still(&project, "SQ01/sh010/v0002/b.png", 400, 300);
        still(&project, "SQ01/sh010/SRC/c.png", 400, 300);
        let shot = project.root.join("SQ01/sh010");

        let report = thumbs_ensure_impl(&shot, false, "").unwrap();
        assert_eq!(report.images_encoded, 3, "{report:?}");

        // A full re-sweep must not treat the three cache entries as new media.
        let again = thumbs_ensure_impl(&project.root, true, "").unwrap();
        assert_eq!(again.images_encoded, 0, "{again:?}");
        assert_eq!(again.pruned, 0, "cache entries are not orphans: {again:?}");
    }
}
