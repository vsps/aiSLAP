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

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm"];
const MODEL_3D_EXTS: &[&str] = &["glb", "gltf"];

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

/// A version-folder name is `<letter-prefix><3 ASCII digits>`, where the
/// prefix is at least one letter and may also contain `_` or `-`. Old `v###`
/// folders still match; the project's configured prefix decides what newly
/// minted folders are named (see `version_prefix_for`).
pub(crate) fn is_version_name(name: &str) -> bool {
    if name.len() < 4 {
        return false;
    }
    let (prefix, digits) = name.split_at(name.len() - 3);
    if prefix.is_empty() {
        return false;
    }
    let mut chars = prefix.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    first_ok
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
        && digits.chars().all(|c| c.is_ascii_digit())
}

/// Extract the 3-digit numeric suffix of a version-folder name.
pub(crate) fn version_number(name: &str) -> Option<u32> {
    if !is_version_name(name) {
        return None;
    }
    name[name.len() - 3..].parse::<u32>().ok()
}

/// Read the project's configured version-folder prefix, falling back to "gen"
/// for projects that don't have the field set yet.
pub(crate) fn version_prefix_for(path: &Path) -> String {
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

/// Walk up the parent chain and return the *topmost* ancestor that contains a
/// `project.json`. Going to the top (rather than stopping at the first hit)
/// protects against orphan sidecars accidentally left inside a project — e.g.,
/// from a folder that was once opened as a standalone project.
pub(crate) fn project_root_for(path: &Path) -> AppResult<PathBuf> {
    let mut found: Option<PathBuf> = None;
    let mut cur: Option<&Path> = Some(path);
    while let Some(p) = cur {
        if p.join(PROJECT_SIDECAR).is_file() {
            found = Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    found.ok_or_else(|| AppError::Msg(format!("no project root for {}", as_str(path))))
}

/// Forward-slash path relative to project root. Returns None if `path` is not
/// underneath `project_root`.
pub(crate) fn relativize(path: &Path, project_root: &Path) -> Option<String> {
    let p = path.canonicalize().ok().unwrap_or_else(|| path.to_path_buf());
    let r = project_root
        .canonicalize()
        .ok()
        .unwrap_or_else(|| project_root.to_path_buf());
    let stripped = p.strip_prefix(&r).ok()?;
    Some(as_str(stripped))
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
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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
    fn version_names_reject_bad_shapes() {
        assert!(!is_version_name("001")); // no prefix
        assert!(!is_version_name("1bc001")); // prefix must start with a letter
        assert!(!is_version_name("v01")); // len < 4
        assert!(!is_version_name("v0011x")); // non-digit suffix
        assert!(!is_version_name("gen01a")); // digits required at the end
        assert!(!is_version_name(""));
    }

    #[test]
    fn version_number_extracts_suffix() {
        assert_eq!(version_number("gen001"), Some(1));
        assert_eq!(version_number("v123"), Some(123));
        assert_eq!(version_number("take999"), Some(999));
        assert_eq!(version_number("SRC"), None);
        assert_eq!(version_number("gen01"), None);
    }

    #[test]
    fn sanitize_replaces_reserved_chars() {
        assert_eq!(sanitize("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize("plain name"), "plain name");
        assert_eq!(sanitize("tab\there"), "tab_here");
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
