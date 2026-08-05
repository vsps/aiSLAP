//! Path/naming helpers and constants shared by the session/gallery/image/
//! timeline command modules. No tauri commands live here.

use std::path::{Path, PathBuf};

use crate::domain::ProjectSidecar;
use crate::error::{AppError, AppResult};
use crate::fsjson::read_json_or_default;

pub(crate) const PROJECT_SIDECAR: &str = "project.json";
pub(crate) const SEQUENCE_SIDECAR: &str = "sequence.json";
pub(crate) const SHOT_SIDECAR: &str = "shot.json";
pub(crate) const TIMELINE_SIDECAR: &str = "timeline.json";
pub(crate) const SRC_DIR: &str = "SRC";
pub(crate) const SEL_DIR: &str = "SEL";

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm"];
const MODEL_3D_EXTS: &[&str] = &["glb", "gltf"];

/// Whether a file transfer is a copy (source kept) or a move (source gone) —
/// shared between the physical file transfer and the visible-set rekey that
/// follows it, since the two must agree on whether the source entry survives.
#[derive(Clone, Copy)]
pub(crate) enum TransferMode {
    Copy,
    Move,
}

impl TransferMode {
    pub(crate) fn label(self) -> &'static str {
        match self {
            TransferMode::Copy => "copy",
            TransferMode::Move => "move",
        }
    }
}

pub(crate) fn as_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Case-insensitive extension match against a static set, without allocating.
fn ext_matches(p: &Path, set: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| set.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

pub(crate) fn is_image_ext(p: &Path) -> bool {
    ext_matches(p, IMAGE_EXTS)
}
pub(crate) fn is_video_ext(p: &Path) -> bool {
    ext_matches(p, VIDEO_EXTS)
}
pub(crate) fn is_model3d_ext(p: &Path) -> bool {
    ext_matches(p, MODEL_3D_EXTS)
}
pub(crate) fn is_media_ext(p: &Path) -> bool {
    is_image_ext(p) || is_video_ext(p) || is_model3d_ext(p)
}

/// The suffix that marks a generated thumbnail. Every scan has to exclude
/// these, or a video's poster frame shows up in the gallery as a sibling image.
pub(crate) const THUMB_SUFFIX: &str = ".thumb.png";

/// Sidecar (`<stem>.json`) sitting next to a media file.
pub(crate) fn sidecar_path(media: &Path) -> PathBuf {
    media.with_extension("json")
}
/// Video thumbnail (`<stem>.thumb.png`) sitting next to a media file.
pub(crate) fn thumb_path(media: &Path) -> PathBuf {
    let stem = media.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    media.with_file_name(format!("{stem}{THUMB_SUFFIX}"))
}
/// Is this path a generated thumbnail rather than real media?
pub(crate) fn is_thumb(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(THUMB_SUFFIX))
}

/// Guard for every command that takes a directory path over IPC.
///
/// Was spelled out at eighteen call sites, with two different phrasings of the
/// same message depending on whether the caller had already normalised the
/// path. Normalises via `as_str` so the error reads with forward slashes
/// everywhere.
pub(crate) fn require_dir(p: &Path) -> AppResult<()> {
    if p.is_dir() {
        Ok(())
    } else {
        Err(AppError::Msg(format!("not a directory: {}", as_str(p))))
    }
}

/// Digits allowed in a version-folder name. aiSLAP mints 3 (`gen001`); PRISM
/// projects mint their configured padding, which is 4 out of the box
/// (`v0001`), so both have to read back as versions.
const VERSION_DIGITS: std::ops::RangeInclusive<usize> = 3..=6;

/// Split a version-folder name into its prefix and trailing digit run, or None
/// if it isn't shaped like one: `<letter-prefix><3..6 ASCII digits>`, where the
/// prefix starts with a letter and may also contain `_` or `-`.
fn split_version_name(name: &str) -> Option<(&str, &str)> {
    let digits_len = name
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if !VERSION_DIGITS.contains(&digits_len) {
        return None;
    }
    let (prefix, digits) = name.split_at(name.len() - digits_len);
    if prefix.is_empty() || !prefix.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    if !prefix
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
    {
        return None;
    }
    Some((prefix, digits))
}

/// Extract the numeric suffix of a version-folder name. `None` means the name
/// isn't shaped like a version at all, so this doubles as the "is it one?"
/// predicate.
pub(crate) fn version_number(name: &str) -> Option<u32> {
    split_version_name(name)?.1.parse::<u32>().ok()
}

/// Is this directory entry a directory? Uses the type the directory read
/// already returned rather than a fresh `stat` — free on Windows, where
/// `is_dir()` is another syscall per entry.
///
/// `file_type()` deliberately does *not* follow symlinks, so the explicit
/// symlink arm preserves the old behaviour: a junction pointing at a shot or
/// version folder is common on the network drives this app targets, and must
/// keep resolving as a directory.
pub(crate) fn entry_is_dir(entry: &std::fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(ft) if ft.is_dir() => true,
        Ok(ft) if ft.is_symlink() => entry.path().is_dir(),
        Ok(_) => false,
        Err(_) => entry.path().is_dir(),
    }
}

/// Highest version-*folder* number under `root`, or None if there are none.
///
/// One directory read answers both "are there any?" and "what's the highest?".
/// Only directories count: a stray *file* named `gen005` used to push
/// `next_version_name` to `gen006`, while `has_version_dir` ignored it — the two
/// disagreed.
pub(crate) fn highest_version_number(root: &Path) -> Option<u32> {
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(entry_is_dir)
        .filter_map(|e| e.file_name().to_str().and_then(version_number))
        .max()
}

/// Walk up the parent chain and return the *nearest* ancestor that contains a
/// `project.json`.
///
/// This used to return the topmost hit, to survive an orphan sidecar left
/// inside a project by a folder that had once been opened standalone. That
/// guard is now redundant — `project_open` refuses to write `project.json`
/// into any folder holding a `sequence.json`/`shot.json`, so a sequence or
/// shot folder can no longer be turned into a stray project through the UI.
/// Meanwhile the topmost rule actively broke the opposite (and far more
/// common) case: open `<parent>` once, open the real project nested inside it
/// later, and every path-derived lookup silently resolves to `<parent>` —
/// wrong tag vocabulary, wrong index DB, wrong version prefix. Nearest-wins
/// matches what the user actually opened.
/// One exception to nearest-wins: a PRISM root anywhere above beats a nearer
/// `project.json`. Opening `03_Production/Assets` (or a category inside it) as a
/// standalone project leaves a marker there, and resolving to it would key the
/// tag index and version naming to a folder the pipeline knows nothing about —
/// which is how a PRISM shot ended up minting `gen001` instead of `v0001`.
pub(crate) fn project_root_for(path: &Path) -> AppResult<PathBuf> {
    // One upward pass, not two. Both markers are checked at each level, and the
    // PRISM rule is preserved exactly: a pipeline root *anywhere* above wins, so
    // keep walking past the first `project.json` and only fall back to it if no
    // pipeline root turns up. (Note `prism_root_for` returns the nearest
    // pipeline root, so the first one found while ascending is the right one.)
    let mut nearest_project: Option<PathBuf> = None;
    let mut cur: Option<&Path> = Some(path);
    while let Some(p) = cur {
        if p.join(crate::commands::prism::PIPELINE_CONFIG).is_file() {
            return Ok(p.to_path_buf());
        }
        if nearest_project.is_none() && p.join(PROJECT_SIDECAR).is_file() {
            nearest_project = Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    nearest_project.ok_or_else(|| AppError::Msg(format!("no project root for {}", as_str(path))))
}

/// A project root with its canonical form resolved once.
///
/// [`relativize`] canonicalizes *both* sides on every call, and it is called
/// once per file during a gallery scan — a few hundred images meant twice that
/// many `canonicalize` syscalls per rescan, and a rescan follows every
/// generation. The root is invariant across a scan, so resolve it up front.
///
/// Canonicalizing at all is not optional: on Windows a UNC path canonicalizes to
/// the `\\?\UNC\...` form, so a plain `strip_prefix` of one against the other
/// fails outright on the network shares this app targets.
pub(crate) struct ProjectRoot {
    pub path: PathBuf,
    canonical: PathBuf,
}

impl ProjectRoot {
    pub(crate) fn resolve(any_path: &Path) -> AppResult<Self> {
        let path = project_root_for(any_path)?;
        Ok(Self::from_root(path))
    }

    pub(crate) fn from_root(path: PathBuf) -> Self {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        Self { path, canonical }
    }

    /// Forward-slash path relative to the root, or None if `p` is outside it.
    pub(crate) fn rel(&self, p: &Path) -> Option<String> {
        let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        Some(as_str(canon.strip_prefix(&self.canonical).ok()?))
    }
}

/// Forward-slash path relative to project root. Returns None if `path` is not
/// underneath `project_root`.
///
/// Prefer [`ProjectRoot`] when relativizing more than one path against the same
/// root — this resolves the root every time.
pub(crate) fn relativize(path: &Path, project_root: &Path) -> Option<String> {
    let p = path
        .canonicalize()
        .ok()
        .unwrap_or_else(|| path.to_path_buf());
    let r = project_root
        .canonicalize()
        .ok()
        .unwrap_or_else(|| project_root.to_path_buf());
    let stripped = p.strip_prefix(&r).ok()?;
    Some(as_str(stripped))
}

/// Forward-slash path relative to `root`, preferring a plain (non-canonicalized)
/// prefix strip and falling back to `relativize` (which canonicalizes both
/// sides) when `path` no longer exists under `root` as given — e.g. after a
/// move, where the source string still needs to resolve to its old location.
pub(crate) fn rel_of(path: &Path, root: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(as_str)
        .or_else(|| relativize(path, root))
}

/// How a project names its version folders.
///
/// Resolved together because both halves come from the same place: in a PRISM
/// project the prefix is `globals.versionFormat` and the padding is
/// `globals.versionPadding`, both inside `pipeline.json`. Asking for them
/// separately meant walking up to the pipeline root, reading and parsing that
/// file — twice, for every single version mint.
pub(crate) struct VersionNaming {
    pub prefix: String,
    pub padding: usize,
}

impl VersionNaming {
    pub(crate) fn for_path(path: &Path) -> Self {
        // PRISM's own naming wins outright: renders have to sit alongside the
        // rest of the pipeline's versions, so the project sidecar's prefix is
        // ignored entirely inside a pipeline.
        if let Some(layout) = crate::commands::prism::layout_for(path) {
            return Self {
                prefix: layout.version_prefix,
                padding: layout.version_padding,
            };
        }
        let prefix = project_root_for(path)
            .ok()
            .and_then(|root| {
                read_json_or_default::<ProjectSidecar>(&root.join(PROJECT_SIDECAR)).ok()
            })
            .map(|s| s.version_prefix)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "gen".into());
        Self { prefix, padding: 3 }
    }

    pub(crate) fn name(&self, n: u32) -> String {
        format!("{}{:0width$}", self.prefix, n, width = self.padding)
    }
}

/// Next unused version-folder name under `root` (e.g. "gen004", or "v0004" in
/// a PRISM project). Does not create the directory — callers `ensure_dir` the
/// result themselves.
pub(crate) fn next_version_name(root: &Path) -> String {
    next_version_name_with(root, &VersionNaming::for_path(root))
}

/// As `next_version_name`, for callers that already resolved the naming (or
/// need it for something else too) and shouldn't pay for it twice.
pub(crate) fn next_version_name_with(root: &Path, naming: &VersionNaming) -> String {
    naming.name(highest_version_number(root).unwrap_or(0) + 1)
}

pub(crate) fn list_dirs(root: &Path) -> AppResult<Vec<PathBuf>> {
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<_> = std::fs::read_dir(root)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            // Skip hidden + system dirs.
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.') && !n.starts_with('$'))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    Ok(out)
}

pub(crate) fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

pub(crate) fn validate_filename_stem(stem: &str) -> AppResult<()> {
    if stem.is_empty() {
        return Err(AppError::Msg("name is empty".into()));
    }
    for c in stem.chars() {
        if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
            return Err(AppError::Msg(format!("invalid character: {c:?}")));
        }
    }
    let upper = stem.to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&upper.as_str()) {
        return Err(AppError::Msg(format!("reserved name: {stem}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_names_accept_letter_prefixes_with_three_digits() {
        assert!(version_number("v001").is_some());
        assert!(version_number("gen001").is_some());
        assert!(version_number("ab-c123").is_some());
        assert!(version_number("a_b001").is_some());
    }

    #[test]
    fn version_names_accept_prism_padding() {
        // PRISM's default versionPadding is 4 — these have to read back as
        // versions or a PRISM shot's folders don't show up as columns.
        assert!(version_number("v0001").is_some());
        assert!(version_number("v0002").is_some());
        assert!(version_number("gen0001").is_some());
        assert!(version_number("v000001").is_some()); // padding 6, the widest accepted
        assert!(version_number("v0000001").is_none()); // 7 digits — out of range
    }

    #[test]
    fn version_names_reject_bad_shapes() {
        assert!(version_number("001").is_none()); // no prefix
        assert!(version_number("1bc001").is_none()); // prefix must start with a letter
        assert!(version_number("v01").is_none()); // fewer than 3 digits
        assert!(version_number("v0011x").is_none()); // non-digit suffix
        assert!(version_number("gen01a").is_none()); // digits required at the end
        assert!(version_number("").is_none());
    }

    #[test]
    fn version_number_extracts_suffix() {
        assert_eq!(version_number("gen001"), Some(1));
        assert_eq!(version_number("v123"), Some(123));
        assert_eq!(version_number("take999"), Some(999));
        assert_eq!(version_number("v0002"), Some(2));
        assert_eq!(version_number("v0123"), Some(123));
        assert_eq!(version_number("SRC"), None);
        assert_eq!(version_number("gen01"), None);
    }

    #[test]
    fn highest_version_number_sees_either_padding_and_ignores_non_versions() {
        let base = std::env::temp_dir().join(format!("aislap-vdir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(highest_version_number(&base).is_none());
        std::fs::create_dir_all(base.join("SRC")).unwrap();
        assert!(
            highest_version_number(&base).is_none(),
            "SRC is not a version"
        );
        std::fs::create_dir_all(base.join("v0002")).unwrap();
        assert_eq!(highest_version_number(&base), Some(2));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sanitize_replaces_reserved_chars() {
        assert_eq!(sanitize("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize("plain name"), "plain name");
        assert_eq!(sanitize("tab\there"), "tab_here");
    }

    #[test]
    fn project_root_is_the_nearest_marker_not_the_topmost() {
        // outer/project.json + outer/inner/project.json — a real layout
        // (a folder opened once as a project, with the actual project nested
        // inside it later). The inner one must win.
        let base = std::env::temp_dir().join(format!("aislap-root-{}", uuid::Uuid::new_v4()));
        let outer = base.join("outer");
        let inner = outer.join("inner");
        let deep = inner.join("seq").join("shot").join("gen001");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(outer.join(PROJECT_SIDECAR), "{}").unwrap();
        std::fs::write(inner.join(PROJECT_SIDECAR), "{}").unwrap();

        assert_eq!(
            project_root_for(&deep.join("a.png")).unwrap().file_name(),
            Some(std::ffi::OsStr::new("inner"))
        );
        // Only the outer marker in scope → that's the root.
        let sibling = outer.join("other");
        std::fs::create_dir_all(&sibling).unwrap();
        assert_eq!(
            project_root_for(&sibling).unwrap().file_name(),
            Some(std::ffi::OsStr::new("outer"))
        );
        // No marker anywhere above → an error, not a silent wrong answer.
        let orphan = std::env::temp_dir().join(format!("aislap-orphan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&orphan).unwrap();
        assert!(project_root_for(&orphan).is_err());

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&orphan);
    }

    /// The one exception to nearest-wins, and the subtle half of the single
    /// upward pass: a PRISM root *anywhere above* beats a nearer `project.json`.
    ///
    /// Opening `03_Production/Assets` (or a category inside it) as a standalone
    /// project leaves a stray marker down there. Resolving to it keys the tag
    /// index and version naming to a folder the pipeline knows nothing about —
    /// which is how a PRISM shot ended up minting `gen001` instead of `v0001`.
    #[test]
    fn a_prism_root_above_beats_a_nearer_project_json() {
        let base = std::env::temp_dir().join(format!("aislap-prismroot-{}", uuid::Uuid::new_v4()));
        let pipeline = base.join("00_Pipeline");
        std::fs::create_dir_all(&pipeline).unwrap();
        std::fs::write(pipeline.join("pipeline.json"), "{}").unwrap();
        std::fs::write(base.join(PROJECT_SIDECAR), "{}").unwrap();

        // The stray marker, several levels below the pipeline root.
        let assets = base.join("03_Production").join("Assets");
        let deep = assets.join("Signs").join("sign_a").join("Renders/AI/v0001");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(assets.join(PROJECT_SIDECAR), "{}").unwrap();

        assert_eq!(
            project_root_for(&deep.join("a.png")).unwrap(),
            base,
            "the pipeline root wins over the nearer stray project.json"
        );
        // And it still wins when the stray marker is the nearest thing there is.
        assert_eq!(project_root_for(&assets).unwrap(), base);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A canonicalized root strips the same way `relativize` does, and answers
    /// None for anything outside it.
    #[test]
    fn project_root_relativizes_consistently() {
        let base = std::env::temp_dir().join(format!("aislap-relroot-{}", uuid::Uuid::new_v4()));
        let deep = base.join("seq").join("shot").join("gen001");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(base.join(PROJECT_SIDECAR), "{}").unwrap();
        let media = deep.join("a.png");
        std::fs::write(&media, b"x").unwrap();

        let root = ProjectRoot::resolve(&media).unwrap();
        assert_eq!(root.path, base);
        assert_eq!(root.rel(&media).as_deref(), Some("seq/shot/gen001/a.png"));
        assert_eq!(root.rel(&media), relativize(&media, &base));

        let outside = std::env::temp_dir().join("aislap-definitely-elsewhere.png");
        assert_eq!(root.rel(&outside), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn filename_stems_validate() {
        assert!(validate_filename_stem("fine_name-01").is_ok());
        assert!(validate_filename_stem("").is_err());
        assert!(validate_filename_stem("bad/slash").is_err());
        assert!(validate_filename_stem("con").is_err()); // reserved (case-insensitive)
        assert!(validate_filename_stem("LPT3").is_err());
    }
}
