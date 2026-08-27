use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::fsutil::{as_str, project_root_for, rel_of, TransferMode, TRASH_DIR};
use crate::commands::image::{transfer_triple_to_dir, CollisionPolicy};
use crate::commands::prism;
use crate::error::{run_blocking, AppError, AppResult};
use crate::fsjson::write_json_atomic;

/// Drop a deleted file (or everything under a deleted directory) from the
/// local asset index, so tag queries don't keep returning it. Best-effort and
/// silent outside a project — the index is rebuildable either way.
async fn purge_index(path: &Path, is_dir: bool) {
    let Ok(root) = project_root_for(path) else {
        return;
    };
    let Some(rel) = rel_of(path, &root) else {
        return;
    };
    if let Err(e) = crate::db::assets_purge(&root, &rel, is_dir).await {
        tracing::warn!("index purge failed for {rel}: {e}");
    }
}

#[tauri::command]
pub fn image_metadata_read(image_path: String) -> AppResult<Option<Value>> {
    let p = PathBuf::from(&image_path);
    let meta = metadata_path_for(&p)?;
    if !meta.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&meta)?;
    let value: Value = serde_json::from_str(&text)?;
    Ok(Some(value))
}

#[tauri::command]
pub fn image_metadata_write(image_path: String, metadata: Value) -> AppResult<()> {
    let p = PathBuf::from(&image_path);
    let meta = metadata_path_for(&p)?;
    write_json_atomic(&meta, &metadata)
}

/// Move a media file — with its sidecar and thumbnail — into the project's
/// `TRASH/`, under a mirror of its project-relative path. Returns the new path.
///
/// There is deliberately no hard-delete command: a generated file and its
/// sidecar are the durable record (architecture.md §2 rule 1), and losing one
/// is unrecoverable. `TRASH/` is excluded from every traversal, so a trashed
/// file is invisible to the gallery, the scans and the index — moving it back
/// out is all a restore takes, and `project_reconcile` re-ingests it on the
/// next project open.
#[tauri::command]
pub async fn image_trash(image_path: String) -> AppResult<String> {
    let p = PathBuf::from(&image_path);
    let dest = run_blocking({
        let p = p.clone();
        move || image_trash_impl(&p)
    })
    .await?;
    // Purge rather than relink: TRASH is outside every scan, so a row pointing
    // into it would never be revisited by reconcile yet would still surface in
    // tag queries. Restoring re-ingests via the embedded asset id.
    purge_index(&p, false).await;
    Ok(as_str(&dest))
}

fn image_trash_impl(p: &Path) -> AppResult<PathBuf> {
    reject_in_prism(p)?;
    let root = project_root_for(p)?;
    let rel = rel_of(p, &root)
        .ok_or_else(|| AppError::Msg(format!("outside the project: {}", as_str(p))))?;
    // Mirror the project-relative *directory*; the filename is handled by the
    // transfer (which uniquifies it if this name has been trashed before).
    let rel_dir = PathBuf::from(&rel)
        .parent()
        .map(|d| d.to_path_buf())
        .unwrap_or_default();
    let dest_dir = root.join(TRASH_DIR).join(rel_dir);
    transfer_triple_to_dir(p, &dest_dir, TransferMode::Move, CollisionPolicy::Uniquify)
}

/// aiSLAP never removes anything inside a PRISM project — the pipeline owns
/// that tree. The UI hides the affordances; this is the backstop, so a stale
/// frontend or a direct IPC call can't get past it.
fn reject_in_prism(p: &Path) -> AppResult<()> {
    if prism::prism_root_for(p).is_some() {
        return Err(AppError::Msg(format!(
            "PRISM_NO_DELETE: aiSLAP does not remove files in a PRISM project: {}",
            as_str(p)
        )));
    }
    Ok(())
}

/// Remove a version folder. Gated in the UI to folders with no files in them,
/// so this removes a directory rather than media — media goes to `TRASH` via
/// [`image_trash`].
#[tauri::command]
pub async fn column_delete(column_path: String) -> AppResult<()> {
    let p = PathBuf::from(&column_path);
    run_blocking({
        let p = p.clone();
        move || {
            reject_in_prism(&p)?;
            if p.is_dir() {
                std::fs::remove_dir_all(&p)?;
            }
            Ok(())
        }
    })
    .await?;
    purge_index(&p, true).await;
    Ok(())
}

fn metadata_path_for(p: &Path) -> AppResult<PathBuf> {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Msg("no file stem".into()))?;
    let dir = p
        .parent()
        .ok_or_else(|| AppError::Msg("no parent".into()))?;
    Ok(dir.join(format!("{stem}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::fsutil::thumb_path;
    use crate::testutil::TestProject;

    /// The whole triple travels, and it lands under a mirror of the file's
    /// project-relative path rather than in a flat heap.
    #[test]
    fn trash_moves_the_triple_under_a_mirrored_path() {
        let project = TestProject::new("trash");
        let media = project.media("SQ01/sh010/v003/a.png", Some(serde_json::json!({})));
        std::fs::write(thumb_path(&media), b"thumb").unwrap();

        let dest = image_trash_impl(&media).unwrap();

        let trash_dir = project.root.join(TRASH_DIR).join("SQ01/sh010/v003");
        assert_eq!(dest, trash_dir.join("a.png"));
        assert!(dest.is_file());
        assert!(trash_dir.join("a.json").is_file(), "sidecar travels");
        assert!(trash_dir.join("a.thumb.jpg").is_file(), "thumb travels");
        assert!(!media.exists(), "source is gone");
        assert!(!media.with_extension("json").exists());
    }

    /// Trashing the same filename twice is routine — regenerate into the same
    /// column, trash again. The suffix has to land on all three companions, or
    /// the second file's sidecar would overwrite the first's.
    #[test]
    fn trashing_the_same_name_twice_uniquifies_the_whole_triple() {
        let project = TestProject::new("trash2");
        for _ in 0..2 {
            let media = project.media("SQ01/sh010/v003/a.png", Some(serde_json::json!({})));
            std::fs::write(thumb_path(&media), b"thumb").unwrap();
            image_trash_impl(&media).unwrap();
        }

        let trash_dir = project.root.join(TRASH_DIR).join("SQ01/sh010/v003");
        for name in [
            "a.png",
            "a.json",
            "a.thumb.jpg",
            "a_1.png",
            "a_1.json",
            "a_1.thumb.jpg",
        ] {
            assert!(trash_dir.join(name).is_file(), "missing {name}");
        }
    }

    /// The pipeline owns a PRISM project's files. The UI hides every
    /// affordance; this is the backstop behind it.
    #[test]
    fn trash_is_refused_inside_a_prism_project() {
        let project = TestProject::prism("trashprism");
        let media = project.media(
            "03_Production/Shots/SQ01/sh010/Renders/2dRender/AI/v0001/a.png",
            Some(serde_json::json!({})),
        );

        let err = image_trash_impl(&media).unwrap_err().to_string();
        assert!(err.contains("PRISM_NO_DELETE"), "unexpected error: {err}");
        assert!(media.is_file(), "the file is untouched");
    }
}
