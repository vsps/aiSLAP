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

/// Sidecar (`<stem>.json`) sitting next to a media file.
pub(crate) fn sidecar_path(media: &Path) -> PathBuf {
    media.with_extension("json")
}
/// Video thumbnail (`<stem>.thumb.png`) sitting next to a media file.
pub(crate) fn thumb_path(media: &Path) -> PathBuf {
    let stem = media.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    media.with_file_name(format!("{stem}.thumb.png"))
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

pub(crate) fn is_version_name(name: &str) -> bool {
    split_version_name(name).is_some()
}

/// Extract the numeric suffix of a version-folder name.
pub(crate) fn version_number(name: &str) -> Option<u32> {
    split_version_name(name)?.1.parse::<u32>().ok()
}

/// Whether `root` already holds at least one version folder.
pub(crate) fn has_version_dir(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok_and(|it| {
        it.flatten().any(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| is_version_name(n) && e.path().is_dir())
        })
    })
}

/// Version-folder prefix for newly minted folders under `path`.
///
/// A PRISM project follows the pipeline's own `versionFormat` ("v#" -> "v") and
/// ignores the project sidecar's prefix entirely — its renders have to sit
/// alongside the rest of the pipeline's versions. Otherwise it's the project's
/// configured prefix, falling back to "gen".
pub(crate) fn version_prefix_for(path: &Path) -> String {
    if let Some(layout) = crate::commands::prism::layout_for(path) {
        return layout.version_prefix;
    }
    let root = match project_root_for(path) {
        Ok(r) => r,
        Err(_) => return "gen".into(),
    };
    let sidecar: ProjectSidecar =
        read_json_or_default(&root.join(PROJECT_SIDECAR)).unwrap_or_default();
    if sidecar.version_prefix.is_empty() {
        "gen".into()
    } else {
        sidecar.version_prefix
    }
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
    if let Some(prism_root) = crate::commands::prism::prism_root_for(path) {
        return Ok(prism_root);
    }
    let mut cur: Option<&Path> = Some(path);
    while let Some(p) = cur {
        if p.join(PROJECT_SIDECAR).is_file() {
            return Ok(p.to_path_buf());
        }
        cur = p.parent();
    }
    Err(AppError::Msg(format!("no project root for {}", as_str(path))))
}

/// Forward-slash path relative to project root. Returns None if `path` is not
/// underneath `project_root`.
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

/// Next unused version-folder name under `root` (e.g. "gen004", or "v0004" in
/// a PRISM project). Prefix comes from the project sidecar, digit count from
/// PRISM's padding where there is one. Does not create the directory — callers
/// `ensure_dir` the result themselves.
pub(crate) fn next_version_name(root: &Path) -> String {
    let mut max_n = 0u32;
    if let Ok(it) = std::fs::read_dir(root) {
        for e in it.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if let Some(n) = version_number(name) {
                    if n > max_n {
                        max_n = n;
                    }
                }
            }
        }
    }
    let padding = crate::commands::prism::version_padding_for(root);
    format!(
        "{}{:0width$}",
        version_prefix_for(root),
        max_n + 1,
        width = padding
    )
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
        assert!(is_version_name("v001"));
        assert!(is_version_name("gen001"));
        assert!(is_version_name("ab-c123"));
        assert!(is_version_name("a_b001"));
    }

    #[test]
    fn version_names_accept_prism_padding() {
        // PRISM's default versionPadding is 4 — these have to read back as
        // versions or a PRISM shot's folders don't show up as columns.
        assert!(is_version_name("v0001"));
        assert!(is_version_name("v0002"));
        assert!(is_version_name("gen0001"));
        assert!(is_version_name("v000001")); // padding 6, the widest accepted
        assert!(!is_version_name("v0000001")); // 7 digits — out of range
    }

    #[test]
    fn version_names_reject_bad_shapes() {
        assert!(!is_version_name("001")); // no prefix
        assert!(!is_version_name("1bc001")); // prefix must start with a letter
        assert!(!is_version_name("v01")); // fewer than 3 digits
        assert!(!is_version_name("v0011x")); // non-digit suffix
        assert!(!is_version_name("gen01a")); // digits required at the end
        assert!(!is_version_name(""));
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
    fn has_version_dir_sees_either_padding() {
        let base = std::env::temp_dir().join(format!("aislap-vdir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(!has_version_dir(&base));
        std::fs::create_dir_all(base.join("SRC")).unwrap();
        assert!(!has_version_dir(&base), "SRC is not a version");
        std::fs::create_dir_all(base.join("v0002")).unwrap();
        assert!(has_version_dir(&base));
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

    #[test]
    fn filename_stems_validate() {
        assert!(validate_filename_stem("fine_name-01").is_ok());
        assert!(validate_filename_stem("").is_err());
        assert!(validate_filename_stem("bad/slash").is_err());
        assert!(validate_filename_stem("con").is_err()); // reserved (case-insensitive)
        assert!(validate_filename_stem("LPT3").is_err());
    }
}
