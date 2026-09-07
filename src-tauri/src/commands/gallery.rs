//! Gallery scanning: shot version columns and the stacked sequence view.
//!
//! Every scan resolves each file's tags from a `TagIndex` loaded once by the
//! async command wrapper (see `tag_index_for`), falling back to the file's
//! own sidecar only for files the index has never seen.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{
    as_str, existing_thumb_path, is_image_ext, is_model3d_ext, is_thumb, is_video_ext, list_dirs,
    project_root_for, require_dir, sidecar_path, ProjectRoot, SEL_DIR, SHOT_SIDECAR, SRC_DIR,
};
use crate::commands::refroots;
use crate::commands::tags::{generated_by_from_sidecar, tags_from_sidecar};
use crate::commands::thumbs::ThumbCtx;
use crate::commands::walk;
use crate::db::TagIndex;
use crate::domain::{DirChildren, GalleryColumn, GalleryImage, RefScope, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::read_json_or_default;

/// Load the tag index for the project `path` belongs to. Best-effort: a
/// missing or broken index just means every image scans as untagged (and the
/// sidecar fallback in `tags_for_file` fills most of it back in).
pub(crate) async fn tag_index_for(path: &Path) -> TagIndex {
    let Ok(root) = project_root_for(path) else {
        return TagIndex::default();
    };
    match crate::db::tags_all(&root).await {
        Ok(idx) => idx,
        Err(e) => {
            tracing::warn!("tag index load failed for {}: {e}", as_str(path));
            TagIndex::default()
        }
    }
}

pub(crate) fn scan_shot_columns(root: &Path, tags: &TagIndex) -> AppResult<Vec<GalleryColumn>> {
    let mut cols: Vec<GalleryColumn> = Vec::new();
    // Resolved once per scan: `relativize` canonicalizes both sides, and it is
    // called for every file in every column.
    let project_root = ProjectRoot::resolve(root).ok();

    // Include the project-level reference root as "GLOBAL SRC". Resolved by
    // walking up to project.json rather than by depth: a PRISM shot's media
    // root sits several levels deeper (`<entity>/Renders/2dRender/AI`), so
    // shot → seq → project doesn't hold there.
    if let Some(project) = project_root.as_ref() {
        let global_src = refroots::global_ref_root(&project.path);
        if let Some(col) = ref_column(
            &global_src,
            "GLOBAL SRC",
            Some(RefScope::Global),
            project_root.as_ref(),
            tags,
        )? {
            cols.push(col);
        }
    }

    // Per-shot reference root — sits to the right of GLOBAL SRC, holds
    // shot-level reference images copied in by the ref panel or drag-drop.
    if let Some(col) = ref_column(
        &refroots::shot_ref_root(root),
        "SHOT SRC",
        Some(RefScope::Shot),
        project_root.as_ref(),
        tags,
    )? {
        cols.push(col);
    }

    // Version columns. SRC and SEL are handled separately above and below.
    for p in walk::shot_versions(root)? {
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let images = scan_directory_images(&p, project_root.as_ref(), tags)?;
        cols.push(GalleryColumn {
            id: name.clone(),
            version: name,
            is_src: false,
            images,
            src_images: Vec::new(),
            subdirs: Vec::new(),
            dest_dir: None,
            ref_scope: None,
            timestamp: None,
            model_name: None,
        });
    }

    // SEL column — sits at the far right, contains user-selected keeps.
    // Deliberate legacy: nothing is written into one any more, so it gets no
    // `dest_dir`, but it still lists subfolders like any other ref column.
    let shot_sel = root.join(SEL_DIR);
    if shot_sel.is_dir() {
        cols.push(ref_column_at(
            &shot_sel,
            SEL_DIR,
            None,
            project_root.as_ref(),
            tags,
        )?);
    }

    cols.sort_by(|a, b| match (a.is_src, b.is_src) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.version.cmp(&b.version),
    });

    // SEL must always sit immediately after SHOT SRC (falling back to right
    // after GLOBAL SRC, or the front, if this shot has no SRC folder yet) —
    // independent of the alphabetical sort above, which would otherwise
    // place it wherever its name happens to fall (e.g. before SHOT SRC).
    if let Some(sel_idx) = cols.iter().position(|c| c.version == SEL_DIR) {
        let sel_col = cols.remove(sel_idx);
        let insert_at = cols
            .iter()
            .position(|c| c.version == "SHOT SRC")
            .or_else(|| cols.iter().position(|c| c.version == "GLOBAL SRC"))
            .map(|i| i + 1)
            .unwrap_or(0);
        cols.insert(insert_at, sel_col);
    }

    Ok(cols)
}

/// A reference column for `dir`, or `None` when that directory doesn't exist.
///
/// The directory is a *browsing root*: its loose media becomes the column's
/// images and its immediate subfolders become sections the frontend can open.
/// Their contents are deliberately not read here — see `dir_children_scan`.
fn ref_column(
    dir: &Path,
    version: &str,
    scope: Option<RefScope>,
    project_root: Option<&ProjectRoot>,
    tags: &TagIndex,
) -> AppResult<Option<GalleryColumn>> {
    if !dir.is_dir() {
        return Ok(None);
    }
    Ok(Some(ref_column_at(
        dir,
        version,
        scope,
        project_root,
        tags,
    )?))
}

/// `ref_column` without the existence check, for callers that already made it.
fn ref_column_at(
    dir: &Path,
    version: &str,
    scope: Option<RefScope>,
    project_root: Option<&ProjectRoot>,
    tags: &TagIndex,
) -> AppResult<GalleryColumn> {
    let children = dir_children(dir, project_root, tags)?;
    // Scope-gated, not computed for every reference column: `SEL` is deliberate
    // legacy that nothing writes into any more, and it must not sprout a
    // `SEL/SRC` to write into now. Only worth sending when it differs from the
    // column directory — natively that directory already is `SRC`, and
    // `default_ref_dir` hands it straight back.
    let dest_dir = scope
        .map(|_| refroots::default_ref_dir(dir))
        .filter(|dest| dest != dir)
        .map(|dest| as_str(&dest));
    Ok(GalleryColumn {
        id: as_str(dir),
        version: version.to_string(),
        is_src: true,
        images: children.images,
        src_images: Vec::new(),
        subdirs: children.subdirs,
        dest_dir,
        ref_scope: scope,
        timestamp: None,
        model_name: None,
    })
}

/// One directory's loose media plus its immediate subfolders. Two `read_dir`s,
/// no descent — the whole point is that a resources folder pointing at a
/// texture library costs nothing until a section is actually opened.
fn dir_children(
    dir: &Path,
    project_root: Option<&ProjectRoot>,
    tags: &TagIndex,
) -> AppResult<DirChildren> {
    Ok(DirChildren {
        images: scan_directory_images(dir, project_root, tags)?,
        subdirs: ref_subdirs(dir)?,
    })
}

/// The folders a reference directory offers as sections, `SRC` first.
///
/// `list_dirs` already drops `.`/`$`-prefixed names and `TRASH`, which is
/// exactly the filter wanted here. It does *not* drop `SRC` or `Resources` —
/// and must not: under PRISM those are where aiSLAP's own references live, so
/// they have to show up as sections. That is the opposite of what
/// `prism::is_ignored_entity_name` does with the same names, deliberately: one
/// gate answers "is this a shot?", this one answers "is this a folder of
/// pictures?".
///
/// `SRC` is floated to the front rather than left in alphabetical order because
/// it is where new references land — same reasoning as the `SEL` fixup in
/// `scan_shot_columns`.
fn ref_subdirs(dir: &Path) -> AppResult<Vec<String>> {
    let mut dirs = list_dirs(dir)?;
    if let Some(i) = dirs
        .iter()
        .position(|p| p.file_name().and_then(|n| n.to_str()) == Some(SRC_DIR))
    {
        let src = dirs.remove(i);
        dirs.insert(0, src);
    }
    Ok(dirs.iter().map(|p| as_str(p)).collect())
}

/// Read one section of a reference column, when the user opens it.
///
/// The path comes from the frontend, so it is checked against the project it
/// claims to be in: a section path left over from a previously-open project
/// would otherwise read an arbitrary directory off disk.
#[tauri::command]
pub async fn dir_children_scan(dir: String) -> AppResult<DirChildren> {
    let path = PathBuf::from(&dir);
    require_dir(&path)?;
    let index = tag_index_for(&path).await;
    run_blocking(move || {
        let project_root = ProjectRoot::resolve(&path)?;
        if project_root.rel(&path).is_none() {
            return Err(AppError::Msg(format!(
                "not inside a project: {}",
                as_str(&path)
            )));
        }
        dir_children(&path, Some(&project_root), &index)
    })
    .await
}

/// Classify a single file as a `GalleryImage`, or `None` if it's not a
/// recognized media file (or is a `.thumb.*` adjunct). `tags` are passed in
/// rather than resolved here since callers differ on how they know them: a
/// directory scan looks each file up in the index, while a scan driven by the
/// index itself already has them in hand.
pub(crate) fn try_make_gallery_image(
    path: &Path,
    tags: Vec<String>,
    generated_by: Option<String>,
    thumbs: Option<&ThumbCtx>,
) -> Option<GalleryImage> {
    let filename = path.file_name().and_then(|n| n.to_str())?.to_string();
    if is_thumb(path) {
        return None;
    }
    let is_image = is_image_ext(path);
    let is_video = is_video_ext(path);
    let is_model_3d = is_model3d_ext(path);
    if !is_image && !is_video && !is_model_3d {
        return None;
    }
    let meta_path = sidecar_path(path);
    // Stills get a thumbnail now too — the whole point of the cache. Without a
    // `ThumbCtx` (a caller outside a project root) fall back to the legacy
    // sibling lookup, which is what every scan did before the cache existed.
    let thumb_path = match thumbs {
        Some(ctx) => ctx.lookup(path).map(|t| as_str(&t)),
        None if is_video || is_model_3d => existing_thumb_path(path).map(|t| as_str(&t)),
        None => None,
    };
    Some(GalleryImage {
        filename,
        path: as_str(path),
        metadata_path: as_str(&meta_path),
        is_video,
        is_model_3d,
        thumb_path,
        tags,
        generated_by,
    })
}

/// Tags for one file: the index if it knows the file, otherwise the file's
/// own sidecar. The fallback only fires for media the index has never seen
/// (legacy files, anything dropped in from outside the app), so a warm
/// project costs zero extra reads per scan.
fn tags_for_file(path: &Path, project_root: Option<&ProjectRoot>, index: &TagIndex) -> Vec<String> {
    let rel = project_root.and_then(|r| r.rel(path));
    match rel {
        Some(rel) if index.is_indexed(&rel) => index.tags_for(&rel),
        _ => match std::fs::read_to_string(sidecar_path(path)) {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .as_ref()
                .and_then(|v| v.as_object())
                .map(tags_from_sidecar)
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        },
    }
}

/// `generatedBy` for one file, mirroring `tags_for_file`'s index-with-sidecar-
/// fallback shape. `None` for SRC/ref images, which were never generated.
fn generated_by_for_file(
    path: &Path,
    project_root: Option<&ProjectRoot>,
    index: &TagIndex,
) -> Option<String> {
    let rel = project_root.and_then(|r| r.rel(path));
    match rel {
        Some(rel) if index.is_indexed(&rel) => index.generated_by_for(&rel),
        _ => std::fs::read_to_string(sidecar_path(path))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|v| v.as_object().and_then(generated_by_from_sidecar)),
    }
}

fn scan_directory_images(
    dir: &Path,
    project_root: Option<&ProjectRoot>,
    index: &TagIndex,
) -> AppResult<Vec<GalleryImage>> {
    // One cache-key snapshot per directory rather than per file: the set is
    // memoised per project for the session, so this is a map lookup after the
    // first call and never a second `read_dir` of the cache.
    let thumbs = project_root.map(|r| ThumbCtx::for_project(&r.path));
    let mut out: Vec<GalleryImage> = Vec::new();
    for path in walk::dir_media(dir)? {
        let tags = tags_for_file(&path, project_root, index);
        let generated_by = generated_by_for_file(&path, project_root, index);
        if let Some(img) = try_make_gallery_image(&path, tags, generated_by, thumbs.as_ref()) {
            out.push(img);
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[tauri::command]
pub async fn shot_rescan(shot_path: String) -> AppResult<Vec<GalleryColumn>> {
    let root = PathBuf::from(&shot_path);
    // One index query up front — the scan itself is blocking, and the DB
    // layer is async (same split as image.rs's `_impl` + async wrapper).
    let index = tag_index_for(&root).await;
    run_blocking(move || scan_shot_columns(&root, &index)).await
}

// ---------- Stacked sequence view ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionStack {
    pub version: String,
    pub images: Vec<GalleryImage>,
    pub selected_filename: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotStack {
    pub shot_path: String,
    pub shot_name: String,
    pub versions: Vec<VersionStack>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub clip_media_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceStacks {
    /// The resolved project-level reference root — `04_Resources` under PRISM.
    /// Sent so the stacked view's drop target doesn't have to rebuild a path
    /// the frontend can no longer derive. Empty when there is no project root.
    pub global_src_root: String,
    pub global_src_images: Vec<GalleryImage>,
    pub shots: Vec<ShotStack>,
}

#[tauri::command]
pub async fn sequence_stacks_scan(sequence_path: String) -> AppResult<SequenceStacks> {
    let index = tag_index_for(&PathBuf::from(&sequence_path)).await;
    run_blocking(move || sequence_stacks_scan_impl(sequence_path, &index)).await
}

fn sequence_stacks_scan_impl(sequence_path: String, tags: &TagIndex) -> AppResult<SequenceStacks> {
    let seq_root = PathBuf::from(&sequence_path);
    require_dir(&seq_root)?;

    let project_root = ProjectRoot::resolve(&seq_root).ok();

    // Project-level GLOBAL SRC. Loose media only — the stacked view is one row
    // per shot and has no room for the section tree the columns view gets.
    let global_src = project_root
        .as_ref()
        .map(|root| refroots::global_ref_root(&root.path));
    let global_src_images = match global_src.as_ref() {
        Some(dir) if dir.is_dir() => scan_directory_images(dir, project_root.as_ref(), tags)?,
        _ => vec![],
    };
    let global_src_root = global_src.as_deref().map(as_str).unwrap_or_default();

    // Walk shots in this sequence. In a PRISM project the entity folder holds
    // pipeline dirs (Scenefiles/Export/...) and aiSLAP's versions live down in
    // `Renders/2dRender/AI` — the row keeps the entity name, the scan uses the
    // media root.
    let mut shots: Vec<ShotStack> = Vec::new();
    for shot in walk::sequence_shots(&seq_root)? {
        let shot_name = shot.shot_name;
        let shot_dir = shot.media_root;

        let sidecar: ShotSidecar = read_json_or_default(&shot_dir.join(SHOT_SIDECAR))?;

        let mut versions: Vec<VersionStack> = Vec::new();
        for v_dir in walk::shot_versions(&shot_dir)? {
            let vname = match v_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let images = scan_directory_images(&v_dir, project_root.as_ref(), tags)?;
            // Resolve the select:
            //   pinned + file still exists → use it
            //   else → last image in the sorted array (the "latest")
            let pinned = sidecar.version_selects.get(&vname).cloned();
            let resolved = pinned
                .filter(|p| images.iter().any(|i| &i.filename == p))
                .or_else(|| images.last().map(|i| i.filename.clone()))
                .unwrap_or_default();
            versions.push(VersionStack {
                version: vname,
                images,
                selected_filename: resolved,
            });
        }
        versions.sort_by(|a, b| a.version.cmp(&b.version));

        shots.push(ShotStack {
            shot_path: as_str(&shot_dir),
            shot_name,
            versions,
            clip_media_path: sidecar.clip_media_path.clone(),
        });
    }
    shots.sort_by(|a, b| a.shot_name.cmp(&b.shot_name));

    Ok(SequenceStacks {
        global_src_root,
        global_src_images,
        shots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::fsutil::THUMB_SUFFIXES;
    use crate::testutil::TestProject;

    /// The gallery has to hand the frontend whichever poster a clip actually
    /// has: new videos get `.thumb.jpg`, but every project generated before
    /// the switch is full of `.thumb.png` and must keep showing its tiles.
    #[test]
    fn gallery_finds_either_thumbnail_suffix() {
        let project = TestProject::new("gallery-thumbs");
        for (rel, suffix) in [
            ("SQ01/sh010/v001/new.mp4", Some(".thumb.jpg")),
            ("SQ01/sh010/v001/old.mp4", Some(".thumb.png")),
            ("SQ01/sh010/v001/bare.mp4", None),
        ] {
            let media = project.media(rel, Some(serde_json::json!({})));
            if let Some(suffix) = suffix {
                let stem = media.file_stem().unwrap().to_str().unwrap();
                std::fs::write(media.with_file_name(format!("{stem}{suffix}")), b"t").unwrap();
            }
            let img = try_make_gallery_image(&media, Vec::new(), None, None).unwrap();
            assert!(img.is_video, "{rel} classified as video");
            match suffix {
                Some(suffix) => assert!(
                    img.thumb_path.as_deref().unwrap().ends_with(suffix),
                    "{rel} should resolve its {suffix} poster, got {:?}",
                    img.thumb_path
                ),
                None => assert_eq!(img.thumb_path, None, "{rel} has no poster"),
            }
        }

        // And a poster is never itself a gallery tile, whichever suffix it has.
        for suffix in THUMB_SUFFIXES {
            let thumb = project.root.join(format!("SQ01/sh010/v001/x{suffix}"));
            std::fs::write(&thumb, b"t").unwrap();
            assert!(
                try_make_gallery_image(&thumb, Vec::new(), None, None).is_none(),
                "{suffix} must not scan as media"
            );
        }
    }

    fn col<'a>(cols: &'a [GalleryColumn], version: &str) -> &'a GalleryColumn {
        cols.iter()
            .find(|c| c.version == version)
            .unwrap_or_else(|| panic!("no {version} column in {:?}", names(cols)))
    }

    fn names(cols: &[GalleryColumn]) -> Vec<&str> {
        cols.iter().map(|c| c.version.as_str()).collect()
    }

    /// A native project's reference columns are unchanged by the PRISM work:
    /// still `<project>/SRC` and `<shot>/SRC`, and each is its own write
    /// target, so nothing acquires a nested `SRC/SRC`.
    #[test]
    fn native_reference_columns_keep_their_paths_and_need_no_dest_dir() {
        let p = TestProject::new("gallery-native-src");
        p.media("SRC/global.png", None);
        p.media("SQ01/sh010/SRC/shot.png", None);
        p.media("SQ01/sh010/v001/out.png", None);

        let cols = scan_shot_columns(&p.root.join("SQ01/sh010"), &TagIndex::default()).unwrap();

        let global = col(&cols, "GLOBAL SRC");
        assert_eq!(global.id, as_str(&p.root.join("SRC")));
        assert_eq!(global.dest_dir, None, "a native root already is SRC");
        assert_eq!(global.ref_scope, Some(RefScope::Global));
        assert_eq!(global.images.len(), 1);

        let shot = col(&cols, "SHOT SRC");
        assert_eq!(shot.id, as_str(&p.root.join("SQ01/sh010/SRC")));
        assert_eq!(shot.dest_dir, None);
        assert_eq!(shot.ref_scope, Some(RefScope::Shot));

        // Version columns are untouched by any of this.
        let v = col(&cols, "v001");
        assert!(v.subdirs.is_empty() && v.dest_dir.is_none() && v.ref_scope.is_none());
    }

    /// The move itself: PRISM reference columns read the pipeline's own
    /// resources folders, and write into an `SRC` inside each.
    #[test]
    fn prism_reference_columns_read_the_resources_folders() {
        let p = TestProject::prism("gallery-prism-src");
        let entity = p.root.join("03_Production/Shots/AMA/s0010");
        let media_root = entity.join("Renders/2dRender/AI");
        p.media("04_Resources/loose.png", None);
        p.media("04_Resources/SRC/global.png", None);
        p.media("04_Resources/clouds/sky.png", None);
        p.media("03_Production/Shots/AMA/s0010/Resources/SRC/shot.png", None);
        p.media(
            "03_Production/Shots/AMA/s0010/Renders/2dRender/AI/v0001/out.png",
            None,
        );

        let cols = scan_shot_columns(&media_root, &TagIndex::default()).unwrap();

        let global = col(&cols, "GLOBAL SRC");
        assert_eq!(global.id, as_str(&p.root.join("04_Resources")));
        assert_eq!(
            global.dest_dir.as_deref(),
            Some(as_str(&p.root.join("04_Resources/SRC")).as_str()),
        );
        // Loose media at the root is the column's own list; the folders are
        // sections, and their contents are NOT read here.
        assert_eq!(global.images.len(), 1, "only the loose file");
        assert_eq!(
            global.subdirs,
            vec![
                as_str(&p.root.join("04_Resources/SRC")),
                as_str(&p.root.join("04_Resources/clouds")),
            ],
            "SRC floats to the front, the rest stay alphabetical"
        );

        let shot = col(&cols, "SHOT SRC");
        assert_eq!(shot.id, as_str(&entity.join("Resources")));
        assert_eq!(
            shot.dest_dir.as_deref(),
            Some(as_str(&entity.join("Resources/SRC")).as_str()),
        );
    }

    /// Nothing migrates: files at the pre-move PRISM locations stay on disk and
    /// stop being listed. Pins the deliberate absence of a legacy fallback.
    #[test]
    fn the_old_prism_src_locations_are_no_longer_read() {
        let p = TestProject::prism("gallery-prism-legacy-src");
        let media_root = p
            .root
            .join("03_Production/Shots/AMA/s0010/Renders/2dRender/AI");
        let old_global = p.media("SRC/stranded.png", None);
        let old_shot = p.media(
            "03_Production/Shots/AMA/s0010/Renders/2dRender/AI/SRC/stranded.png",
            None,
        );

        let cols = scan_shot_columns(&media_root, &TagIndex::default()).unwrap();
        let listed: Vec<&str> = cols
            .iter()
            .flat_map(|c| c.images.iter().map(|i| i.filename.as_str()))
            .collect();
        assert!(listed.is_empty(), "nothing from the old paths: {listed:?}");
        assert!(old_global.is_file() && old_shot.is_file(), "left on disk");
    }

    /// A section is read only when asked for, and reports its own subfolders so
    /// the frontend can nest without the backend recursing.
    #[test]
    fn dir_children_returns_one_level_and_its_own_subdirs() {
        let p = TestProject::prism("gallery-sections");
        p.media("04_Resources/Libraries/top.png", None);
        p.media("04_Resources/Libraries/PolyHaven/deep.png", None);

        let children = dir_children(
            &p.root.join("04_Resources/Libraries"),
            None,
            &TagIndex::default(),
        )
        .unwrap();
        assert_eq!(children.images.len(), 1, "own files only, no descent");
        assert_eq!(
            children.subdirs,
            vec![as_str(&p.root.join("04_Resources/Libraries/PolyHaven"))],
        );
    }
}
