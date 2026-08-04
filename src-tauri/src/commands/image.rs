//! Image file operations: copy/move/rename of the media "triple" (primary +
//! `.json` sidecar + `.thumb.png`), version-stack moves, base64 PNG saves,
//! and revealing a path in the OS file manager.

use std::path::{Path, PathBuf};

use crate::commands::fsutil::{
    as_str, is_media_ext, next_version_name, project_root_for, relativize, sidecar_path,
    thumb_path, validate_filename_stem, TransferMode, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::media_id::{file_hash_impl, media_id_embed_impl};
use crate::commands::tags::tags_from_sidecar;
use crate::db::{self, AssetRecord, TagUpdate};
use crate::domain::{Config, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::{ensure_dir, read_json_or_default, write_json_atomic};

#[derive(Clone, Copy)]
enum CollisionPolicy {
    Overwrite,
    Error,
}

fn sibling_paths(p: &Path) -> AppResult<(String, String, PathBuf, PathBuf)> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?
        .to_string();
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no filename".into()))?
        .to_string();
    // Bail if there's no parent — keeps the returned sidecar/thumb paths valid.
    p.parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    Ok((stem, filename, sidecar_path(p), thumb_path(p)))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let na = a.canonicalize().ok();
    let nb = b.canonicalize().ok();
    if let (Some(x), Some(y)) = (na, nb) {
        return x == y;
    }
    as_str(a) == as_str(b)
}

fn transfer_one(mode: TransferMode, src: &Path, dest: &Path) -> std::io::Result<()> {
    match mode {
        TransferMode::Copy => std::fs::copy(src, dest).map(|_| ()),
        TransferMode::Move => move_one(src, dest),
    }
}

fn move_one(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            std::fs::copy(src, dest)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn transfer_triple_to_dir(
    src: &Path,
    dest_dir: &Path,
    mode: TransferMode,
    policy: CollisionPolicy,
) -> AppResult<PathBuf> {
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {}", as_str(src))));
    }
    if !dest_dir.is_dir() {
        ensure_dir(dest_dir)?;
    }
    let src_dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    if same_dir(src_dir, dest_dir) {
        return Err(AppError::Msg(
            "source and destination are the same directory".into(),
        ));
    }
    let (_stem, filename, src_sidecar, src_thumb) = sibling_paths(src)?;
    let dest_primary = dest_dir.join(&filename);
    if dest_primary.exists() && matches!(policy, CollisionPolicy::Error) {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {filename}")));
    }
    transfer_one(mode, src, &dest_primary)?;
    // Sidecar/thumb are best-effort companions; skip silently if unnamed.
    if let (true, Some(name)) = (src_sidecar.exists(), src_sidecar.file_name()) {
        if let Err(e) = transfer_one(mode, &src_sidecar, &dest_dir.join(name)) {
            tracing::warn!("sidecar {} failed: {e}", mode.label());
        }
    }
    if let (true, Some(name)) = (src_thumb.exists(), src_thumb.file_name()) {
        if let Err(e) = transfer_one(mode, &src_thumb, &dest_dir.join(name)) {
            tracing::warn!("thumb {} failed: {e}", mode.label());
        }
    }
    Ok(dest_primary)
}

/// (project_root, asset_id, new_rel_path) for a moved file's DB relink —
/// computed by the sync `_impl` fns (which already have the paths in hand
/// mid-move) and applied by the async command wrapper afterward, since the
/// DB layer is async and these `_impl` fns are plain blocking functions run
/// via `run_blocking`.
type RelinkInfo = (PathBuf, String, String);

/// Best-effort: `None` for an untracked file (no project root, no sidecar,
/// no `assetId`, or a path that can't be relativized) — callers just skip
/// the relink in that case, same as they always have for pre-Phase-1 files.
fn relink_info(dest: &Path) -> Option<RelinkInfo> {
    let root = project_root_for(dest).ok()?;
    let asset_id = sidecar_asset_id(dest)?;
    let rel_path = relativize(dest, &root)?;
    Some((root, asset_id, rel_path))
}

fn sidecar_asset_id(media_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(sidecar_path(media_path)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("assetId")?.as_str().map(String::from)
}

/// Push every collected relink through to the local asset index — fire and
/// log-only on failure, mirroring how `media_id_embed` failures are treated
/// elsewhere: this is enrichment, not the durable record (the sidecar/file
/// move already succeeded by the time this runs).
async fn apply_relinks(relinks: impl IntoIterator<Item = RelinkInfo>) {
    for (root, asset_id, rel_path) in relinks {
        if let Err(e) = crate::db::asset_relink(&root, &asset_id, &rel_path).await {
            tracing::warn!("asset relink failed for {asset_id}: {e}");
        }
    }
}

/// (project_root, record, tags) for a copy's freshly-minted identity —
/// computed by `reidentify_copy` (sync, mid-transfer) and ingested by the
/// async command wrapper afterward, mirroring `RelinkInfo`/`apply_relinks`.
/// The tags come along because the copied sidecar carries them but the index
/// rows are keyed by the *source's* asset id.
type NewAssetInfo = (PathBuf, AssetRecord, Vec<String>);

fn ffmpeg_path() -> String {
    crate::paths::config_path()
        .and_then(|p| read_json_or_default::<Config>(&p))
        .map(|c| c.ffmpeg_path)
        .unwrap_or_default()
}

/// After a **copy**, `transfer_triple_to_dir` has just duplicated the
/// sidecar byte-for-byte — including its `assetId` — so without this the two
/// files would share one identity forever (see plan Risks: "copying a file
/// duplicates its assetId"). Mint the copy a fresh id, re-embed it
/// (best-effort, same as `reconcile_one_file`'s legacy-backfill path) and
/// rewrite the copied sidecar, then hand back an `AssetRecord` for the async
/// wrapper to ingest as a brand new row — never a relink, since the source
/// keeps its own row pointing at the source file. `None` for untracked
/// copies (no project root, no sidecar, no prior `assetId`) — nothing to
/// re-identify, same as pre-Phase-1 files elsewhere.
fn reidentify_copy(dest: &Path) -> Option<NewAssetInfo> {
    let root = project_root_for(dest).ok()?;
    let sidecar = sidecar_path(dest);
    let text = std::fs::read_to_string(&sidecar).ok()?;
    let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let obj = value.as_object()?.clone();
    obj.get("assetId").and_then(|v| v.as_str())?;

    let project_id = db::read_project_id(&root).unwrap_or_default();
    let new_id = uuid::Uuid::new_v4().to_string();
    let _ = media_id_embed_impl(dest, &new_id, &project_id, &ffmpeg_path());
    let hash = file_hash_impl(dest).ok()?;

    if let Some(map) = value.as_object_mut() {
        map.insert("assetId".into(), serde_json::json!(new_id));
        map.insert("contentHash".into(), serde_json::json!(hash));
    }
    write_json_atomic(&sidecar, &value).ok()?;

    let rel_path = relativize(dest, &root)?;
    let now = chrono::Utc::now().to_rfc3339();
    Some((
        root,
        AssetRecord {
            id: new_id,
            project_id: Some(project_id),
            rel_path,
            content_hash: Some(hash),
            kind: db::media_kind(dest).to_string(),
            provider: obj
                .get("provider")
                .and_then(|v| v.as_str())
                .map(String::from),
            model_id: obj
                .get("modelId")
                .and_then(|v| v.as_str())
                .map(String::from),
            endpoint: obj
                .get("endpoint")
                .and_then(|v| v.as_str())
                .map(String::from),
            combined_prompt: obj
                .get("combinedPrompt")
                .and_then(|v| v.as_str())
                .map(String::from),
            settings_json: obj.get("settings").map(|v| v.to_string()),
            cost_usd: obj.get("costUsd").and_then(|v| v.as_f64()),
            created_at: obj
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| now.clone()),
            updated_at: Some(now),
            deleted_at: None,
        },
        tags_from_sidecar(&obj),
    ))
}

/// Push every freshly re-identified copy into the local asset index — fire
/// and log-only on failure, same treatment as `apply_relinks`.
async fn apply_new_assets(infos: impl IntoIterator<Item = NewAssetInfo>) {
    for (root, record, tags) in infos {
        let id = record.id.clone();
        if let Err(e) = db::asset_upsert(&root, record).await {
            tracing::warn!("asset upsert for copied asset {id} failed: {e}");
            continue;
        }
        if tags.is_empty() {
            continue;
        }
        let update = TagUpdate {
            asset_id: id.clone(),
            record: None,
            tags,
        };
        if let Err(e) = db::asset_tags_apply(&root, std::slice::from_ref(&update)).await {
            tracing::warn!("tag copy for copied asset {id} failed: {e}");
        }
    }
}

#[tauri::command]
pub async fn ref_copy_to_global_src(shot_path: String, source_path: String) -> AppResult<String> {
    let (out, new_asset) =
        run_blocking(move || ref_copy_to_global_src_impl(shot_path, source_path)).await?;
    apply_new_assets(new_asset).await;
    Ok(out)
}

fn ref_copy_to_global_src_impl(
    shot_path: String,
    source_path: String,
) -> AppResult<(String, Option<NewAssetInfo>)> {
    let src = PathBuf::from(&source_path);
    // Walk up to project.json rather than assuming shot → seq → project: a
    // PRISM shot's media root is `<entity>/Renders/AI`, two levels deeper.
    let project_dir = project_root_for(&PathBuf::from(&shot_path))?.join(SRC_DIR);
    ensure_dir(&project_dir)?;
    let dest = transfer_triple_to_dir(
        &src,
        &project_dir,
        TransferMode::Copy,
        CollisionPolicy::Overwrite,
    )?;
    let new_asset = reidentify_copy(&dest);
    Ok((as_str(&dest), new_asset))
}

#[tauri::command]
pub async fn image_copy_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    let (out, new_asset) =
        run_blocking(move || image_copy_to_dir_impl(source_path, dest_dir)).await?;
    apply_new_assets(new_asset).await;
    Ok(out)
}

fn image_copy_to_dir_impl(
    source_path: String,
    dest_dir: String,
) -> AppResult<(String, Option<NewAssetInfo>)> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = transfer_triple_to_dir(&src, &dest, TransferMode::Copy, CollisionPolicy::Error)?;
    let new_asset = reidentify_copy(&out);
    Ok((as_str(&out), new_asset))
}

#[tauri::command]
pub async fn image_move_to_dir(source_path: String, dest_dir: String) -> AppResult<String> {
    let (out, relink) = run_blocking(move || image_move_to_dir_impl(source_path, dest_dir)).await?;
    apply_relinks(relink).await;
    Ok(out)
}

fn image_move_to_dir_impl(
    source_path: String,
    dest_dir: String,
) -> AppResult<(String, Option<RelinkInfo>)> {
    let src = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    let out = transfer_triple_to_dir(&src, &dest, TransferMode::Move, CollisionPolicy::Error)?;
    let relink = relink_info(&out);
    Ok((as_str(&out), relink))
}

#[tauri::command]
pub async fn image_rename(source_path: String, new_stem: String) -> AppResult<String> {
    let (out, relink) = run_blocking(move || image_rename_impl(source_path, new_stem)).await?;
    apply_relinks(relink).await;
    Ok(out)
}

fn image_rename_impl(
    source_path: String,
    new_stem: String,
) -> AppResult<(String, Option<RelinkInfo>)> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::Msg(format!("not a file: {source_path}")));
    }
    let trimmed = new_stem.trim();
    validate_filename_stem(trimmed)?;
    let (old_stem, _filename, old_sidecar, old_thumb) = sibling_paths(&src)?;
    if trimmed == old_stem {
        return Err(AppError::Msg("name unchanged".into()));
    }
    let dir = src
        .parent()
        .ok_or_else(|| AppError::Msg("no parent dir".into()))?;
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let new_filename = match &ext {
        Some(e) if !e.is_empty() => format!("{trimmed}.{e}"),
        _ => trimmed.to_string(),
    };
    let new_primary = dir.join(&new_filename);
    let new_sidecar = dir.join(format!("{trimmed}.json"));
    let new_thumb = dir.join(format!("{trimmed}.thumb.png"));
    if new_primary.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {new_filename}")));
    }
    if old_sidecar.exists() && new_sidecar.exists() {
        return Err(AppError::Msg(format!("FILENAME_EXISTS: {trimmed}.json")));
    }
    if old_thumb.exists() && new_thumb.exists() {
        return Err(AppError::Msg(format!(
            "FILENAME_EXISTS: {trimmed}.thumb.png"
        )));
    }
    std::fs::rename(&src, &new_primary)?;
    if old_sidecar.exists() {
        if let Err(e) = std::fs::rename(&old_sidecar, &new_sidecar) {
            tracing::warn!("sidecar rename failed: {e}");
        }
    }
    if old_thumb.exists() {
        if let Err(e) = std::fs::rename(&old_thumb, &new_thumb) {
            tracing::warn!("thumb rename failed: {e}");
        }
    }
    let relink = relink_info(&new_primary);
    Ok((as_str(&new_primary), relink))
}

/// Move (or copy) every image file (plus its sidecar/thumb) from
/// `src_shot/src_version/` into `dst_shot/dst_version/`. When `dst_version` is
/// None or empty, the next version on `dst_shot` is allocated.
/// Returns the destination version's absolute path.
#[tauri::command]
pub async fn version_stack_move(
    src_shot: String,
    src_version: String,
    dst_shot: String,
    dst_version: Option<String>,
    copy: bool,
) -> AppResult<String> {
    let (out, relinks, new_assets) = run_blocking(move || {
        version_stack_move_impl(src_shot, src_version, dst_shot, dst_version, copy)
    })
    .await?;
    apply_relinks(relinks).await;
    apply_new_assets(new_assets).await;
    Ok(out)
}

fn version_stack_move_impl(
    src_shot: String,
    src_version: String,
    dst_shot: String,
    dst_version: Option<String>,
    copy: bool,
) -> AppResult<(String, Vec<RelinkInfo>, Vec<NewAssetInfo>)> {
    let src_dir = PathBuf::from(&src_shot).join(&src_version);
    if !src_dir.is_dir() {
        return Err(AppError::Msg(format!(
            "not a directory: {}",
            as_str(&src_dir)
        )));
    }

    let dst_root = PathBuf::from(&dst_shot);
    let dst_version_name = match dst_version {
        Some(v) if !v.is_empty() => v,
        _ => next_version_name(&dst_root),
    };
    let dst_dir = dst_root.join(&dst_version_name);
    ensure_dir(&dst_dir)?;

    let same = match (src_dir.canonicalize(), dst_dir.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return Ok((as_str(&dst_dir), Vec::new(), Vec::new()));
    }

    // Collect the media files (skip thumbs/json — they move as siblings).
    let mut moves: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(&src_dir)? {
        let entry = e?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let filename = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if filename.ends_with(".thumb.png") {
            continue;
        }
        if !is_media_ext(&p) {
            continue;
        }
        moves.push(p);
    }

    let mode = if copy {
        TransferMode::Copy
    } else {
        TransferMode::Move
    };
    // A move relinks the existing asset to its new path; a copy mints the
    // duplicate a fresh identity (see reidentify_copy) rather than letting
    // it share the source's assetId.
    let mut relinks = Vec::new();
    let mut new_assets = Vec::new();
    for src in &moves {
        let dest = transfer_triple_to_dir(src, &dst_dir, mode, CollisionPolicy::Error)?;
        match mode {
            TransferMode::Move => {
                if let Some(info) = relink_info(&dest) {
                    relinks.push(info);
                }
            }
            TransferMode::Copy => {
                if let Some(info) = reidentify_copy(&dest) {
                    new_assets.push(info);
                }
            }
        }
    }

    // Clearing the source's pinned select only makes sense for a move — a
    // copy leaves the source stack (and its select) untouched.
    if !copy {
        let src_sidecar_path = PathBuf::from(&src_shot).join(SHOT_SIDECAR);
        if src_sidecar_path.exists() {
            let mut sidecar: ShotSidecar = read_json_or_default(&src_sidecar_path)?;
            if sidecar.version_selects.remove(&src_version).is_some() {
                write_json_atomic(&src_sidecar_path, &sidecar)?;
            }
        }
    }

    Ok((as_str(&dst_dir), relinks, new_assets))
}

#[tauri::command]
pub fn save_png_base64(path: String, data_base64: String) -> AppResult<()> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(&data_base64)
        .map_err(|e| AppError::Msg(format!("base64 decode: {e}")))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }
    std::fs::write(&p, &bytes)?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum RevealOs {
    Windows,
    MacOs,
    Other,
}

const HOST_OS: RevealOs = if cfg!(target_os = "windows") {
    RevealOs::Windows
} else if cfg!(target_os = "macos") {
    RevealOs::MacOs
} else {
    RevealOs::Other
};

/// File-manager invocations to try in order (the first that spawns wins).
///
/// Every platform's shape is built here rather than behind `#[cfg]` so all of
/// them compile and are unit-tested on any host — a Mac-only code path that the
/// Windows build never sees is how the bundled-models bug reached a release.
/// `is_dir` is passed in rather than probed so the shapes stay testable.
fn reveal_argv(p: &Path, is_dir: bool, os: RevealOs) -> Vec<(&'static str, Vec<String>)> {
    let parent = p.parent().unwrap_or(p);
    match os {
        RevealOs::Windows => {
            // Explorer wants backslashes; the rest of the app stores forward slashes.
            let native = p.to_string_lossy().replace('/', "\\");
            if is_dir {
                vec![("explorer", vec![native])]
            } else {
                // /select opens the containing folder with the file highlighted;
                // virtual/cloud filesystems that don't support it fall back to
                // opening the folder alone.
                vec![
                    ("explorer", vec!["/select,".into(), native]),
                    (
                        "explorer",
                        vec![parent.to_string_lossy().replace('/', "\\")],
                    ),
                ]
            }
        }
        // `open -R` reveals a file in Finder with it selected. A directory is
        // opened as-is, since -R would select it in its parent instead.
        RevealOs::MacOs => {
            let path = p.to_string_lossy().to_string();
            if is_dir {
                vec![("open", vec![path])]
            } else {
                vec![("open", vec!["-R".into(), path])]
            }
        }
        // No portable reveal-and-select on Linux desktops, so open the
        // containing folder and let the user spot the file.
        RevealOs::Other => vec![(
            "xdg-open",
            vec![if is_dir { p } else { parent }
                .to_string_lossy()
                .to_string()],
        )],
    }
}

/// Show a path in the OS file manager — Explorer, Finder, or whatever the
/// desktop provides — with the file selected where that's supported. A
/// directory opens directly rather than being selected in its parent.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let mut last_err: Option<String> = None;
    for (program, args) in reveal_argv(&p, p.is_dir(), HOST_OS) {
        match std::process::Command::new(program).args(&args).spawn() {
            Ok(_) => return Ok(()),
            Err(e) => last_err = Some(format!("{program}: {e}")),
        }
    }
    Err(AppError::Msg(
        last_err.unwrap_or_else(|| "no file manager to open".into()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::fsutil::PROJECT_SIDECAR;
    use crate::db::{self, AssetRecord};
    use crate::domain::ProjectSidecar;
    use std::fs;

    /// Runs on every host, so the macOS and Linux shapes are checked from the
    /// Windows dev box (and vice versa on the release runners).
    #[test]
    fn reveal_argv_per_platform() {
        let file = Path::new("Z:/prj/seq/shot/v001/a.png");
        let dir = Path::new("Z:/prj/seq/shot/v001");

        // Windows: /select, with backslashes, then the folder alone as fallback.
        assert_eq!(
            reveal_argv(file, false, RevealOs::Windows),
            vec![
                (
                    "explorer",
                    vec![
                        "/select,".to_string(),
                        r"Z:\prj\seq\shot\v001\a.png".to_string()
                    ]
                ),
                ("explorer", vec![r"Z:\prj\seq\shot\v001".to_string()]),
            ]
        );
        assert_eq!(
            reveal_argv(dir, true, RevealOs::Windows),
            vec![("explorer", vec![r"Z:\prj\seq\shot\v001".to_string()])]
        );

        // macOS: `open -R` selects the file in Finder; a directory opens as-is.
        // Forward slashes are native here — no separator rewriting.
        assert_eq!(
            reveal_argv(file, false, RevealOs::MacOs),
            vec![(
                "open",
                vec![
                    "-R".to_string(),
                    "Z:/prj/seq/shot/v001/a.png".to_string()
                ]
            )]
        );
        assert_eq!(
            reveal_argv(dir, true, RevealOs::MacOs),
            vec![("open", vec!["Z:/prj/seq/shot/v001".to_string()])]
        );

        // Linux: no reveal-and-select, so the containing folder.
        assert_eq!(
            reveal_argv(file, false, RevealOs::Other),
            vec![("xdg-open", vec!["Z:/prj/seq/shot/v001".to_string()])]
        );
        assert_eq!(
            reveal_argv(dir, true, RevealOs::Other),
            vec![("xdg-open", vec!["Z:/prj/seq/shot/v001".to_string()])]
        );

        // A path with no parent must not panic or produce an empty argument.
        assert_eq!(
            reveal_argv(Path::new("/"), true, RevealOs::MacOs),
            vec![("open", vec!["/".to_string()])]
        );
    }

    #[test]
    fn host_os_matches_the_build_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(HOST_OS, RevealOs::Windows);
        #[cfg(target_os = "macos")]
        assert_eq!(HOST_OS, RevealOs::MacOs);
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(HOST_OS, RevealOs::Other);
    }

    /// A throwaway project under the OS temp dir, with a real project.json —
    /// same fixture shape as db::tests::test_project, duplicated here since
    /// that helper is private to the db module.
    fn test_project() -> (PathBuf, String) {
        let project_id = format!("test-image-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(&project_id);
        fs::create_dir_all(&root).unwrap();
        let sidecar = ProjectSidecar {
            project_id: project_id.clone(),
            ..Default::default()
        };
        write_json_atomic(&root.join(PROJECT_SIDECAR), &sidecar).unwrap();
        (root, project_id)
    }

    fn cleanup(root: &Path, project_id: &str) {
        let _ = fs::remove_dir_all(root);
        if let Ok(dir) = crate::paths::appdata_dir() {
            let _ = fs::remove_file(dir.join("db").join(format!("{project_id}.db")));
        }
    }

    fn write_media_with_sidecar(media_path: &Path, asset_id: &str) {
        fs::create_dir_all(media_path.parent().unwrap()).unwrap();
        fs::write(media_path, b"fake image bytes").unwrap();
        let sidecar = serde_json::json!({
            "model": "Test", "modelId": "m1", "endpoint": "e1",
            "settings": {}, "refs": [], "timestamp": "2024-01-01T00:00:00Z",
            "assetId": asset_id,
        });
        write_json_atomic(&sidecar_path(media_path), &sidecar).unwrap();
    }

    fn sidecar_asset_id_for_test(media_path: &Path) -> String {
        sidecar_asset_id(media_path).expect("sidecar has an assetId")
    }

    #[tokio::test]
    async fn copy_to_dir_mints_a_fresh_identity_and_leaves_the_source_indexed() {
        let (root, project_id) = test_project();
        let src = root.join("shot1").join("gen001").join("img.png");
        write_media_with_sidecar(&src, "asset-src-1");
        db::asset_upsert(
            &root,
            AssetRecord {
                id: "asset-src-1".to_string(),
                rel_path: "shot1/gen001/img.png".to_string(),
                kind: "image".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let dest_dir = root.join("shot1").join("gen002");
        let out = image_copy_to_dir(as_str(&src), as_str(&dest_dir))
            .await
            .unwrap();
        let dest = PathBuf::from(&out);

        // Copy got a brand new id, distinct from the source's.
        let new_id = sidecar_asset_id_for_test(&dest);
        assert_ne!(new_id, "asset-src-1");
        // Source sidecar untouched.
        assert_eq!(sidecar_asset_id_for_test(&src), "asset-src-1");

        // Source's DB row still points at the source file.
        let src_row = db::asset_lookup(&root, Some("asset-src-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(src_row.rel_path, "shot1/gen001/img.png");

        // The copy is indexed as its own row at its own path.
        let copy_row = db::asset_lookup(&root, Some(new_id), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(copy_row.rel_path, "shot1/gen002/img.png");

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn move_to_dir_relinks_the_indexed_asset_immediately() {
        let (root, project_id) = test_project();
        let src = root.join("shot1").join("gen001").join("img.png");
        write_media_with_sidecar(&src, "asset-move-1");
        db::asset_upsert(
            &root,
            AssetRecord {
                id: "asset-move-1".to_string(),
                rel_path: "shot1/gen001/img.png".to_string(),
                kind: "image".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let dest_dir = root.join("shot1").join("gen002");
        image_move_to_dir(as_str(&src), as_str(&dest_dir))
            .await
            .unwrap();

        let row = db::asset_lookup(&root, Some("asset-move-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.rel_path, "shot1/gen002/img.png");

        cleanup(&root, &project_id);
    }

    #[tokio::test]
    async fn rename_relinks_the_indexed_asset_immediately() {
        let (root, project_id) = test_project();
        let src = root.join("shot1").join("gen001").join("img.png");
        write_media_with_sidecar(&src, "asset-rename-1");
        db::asset_upsert(
            &root,
            AssetRecord {
                id: "asset-rename-1".to_string(),
                rel_path: "shot1/gen001/img.png".to_string(),
                kind: "image".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        image_rename(as_str(&src), "renamed".to_string())
            .await
            .unwrap();

        let row = db::asset_lookup(&root, Some("asset-rename-1".to_string()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.rel_path, "shot1/gen001/renamed.png");

        cleanup(&root, &project_id);
    }
}
