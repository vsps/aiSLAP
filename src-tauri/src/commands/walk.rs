//! The project → sequence → shot → version → media traversal, in one place.
//!
//! Five call sites used to walk this tree independently — the reconcile pass,
//! the cost rollup, the gallery's column and stacked scans, and the timeline's
//! latest-media scan. Two of them carried comments saying they mirrored a
//! third, which is duplication admitting itself. They had also drifted: the
//! timeline treated `SEL` as an ordinary version folder (so a SEL image could
//! win "latest media" purely on sort order), while reconcile and cost happily
//! descended into `$RECYCLE.BIN` and other hidden directories.
//!
//! # The policy
//!
//! `SRC`, `SEL`, and any name starting with `.` or `$` are **never** sequences,
//! entities or version folders. `SRC` holds inputs, `SEL` is legacy (superseded
//! by the `select` tag — nothing is written into it any more), and the prefixes
//! cover OS and tooling directories. This is deliberate and uniform; see
//! `docs/architecture.md` § Invariants.
//!
//! PRISM resolution is folded in here too, so callers never branch on it: in a
//! PRISM project the entity folder holds pipeline directories and aiSLAP's
//! media lives down in `Renders/2dRender/AI`, which is what [`ShotEntry`]
//! separates as `entity_dir` (the name) and `media_root` (the files).

use std::path::{Path, PathBuf};

use crate::commands::fsutil::{is_media_ext, is_thumb, list_dirs, SEL_DIR, SRC_DIR, TRASH_DIR};
use crate::commands::prism;
use crate::error::AppResult;

/// One shot, with both halves of its PRISM identity resolved.
///
/// The split is the whole point: under PRISM the folder carrying the *name* a
/// user recognises is not the folder carrying the *files*. Callers that label
/// something want `shot_name`; callers that read or write want `media_root`.
/// (The entity directory itself is recoverable from the media root via
/// `prism::entity_for`, so it isn't carried here until something needs it.)
pub(crate) struct ShotEntry {
    /// Where aiSLAP's media actually lives: `<entity>/Renders/2dRender/AI`
    /// under PRISM (or the legacy `Renders/AI`),
    /// the entity folder itself otherwise. Guaranteed to be a directory.
    pub media_root: PathBuf,
    /// The entity folder's name.
    pub shot_name: String,
}

/// Is this directory name a real sequence/entity/version, rather than an input
/// folder, dead legacy, trashed media, or something the OS left lying around?
fn is_content_dir(name: &str) -> bool {
    !name.starts_with('.')
        && !name.starts_with('$')
        && name != SRC_DIR
        && name != SEL_DIR
        && name != TRASH_DIR
}

fn dir_name(p: &Path) -> Option<String> {
    p.file_name().and_then(|n| n.to_str()).map(str::to_string)
}

/// A project's sequences, with the PRISM layout resolved once.
///
/// Callers that only want files should use [`project_shots`]. Callers that roll
/// results *up* per sequence — the cost scan — need this, because a sequence
/// with no shots still has a `sequence.json` to write.
pub(crate) struct ProjectWalk {
    layout: Option<prism::PrismLayout>,
    /// In discovery order: shot tree then asset tree, each alphabetical.
    pub sequences: Vec<PathBuf>,
}

impl ProjectWalk {
    pub fn shots(&self, seq_dir: &Path) -> AppResult<Vec<ShotEntry>> {
        shots_in(seq_dir, self.layout.as_ref())
    }
}

/// Sequences live under the entity roots in a PRISM project — walking the
/// project folder directly would treat `00_Pipeline`, `01_Management` and
/// friends as sequences, and write cost fields into `sequence.json` inside them.
/// Both trees are walked, so a project total covers shots and assets.
pub(crate) fn project_walk(project_root: &Path) -> AppResult<ProjectWalk> {
    let layout = prism::detect(project_root);
    let seq_parents: Vec<PathBuf> = match &layout {
        Some(l) => vec![l.entity_root(Some("shot")), l.entity_root(Some("asset"))],
        None => vec![project_root.to_path_buf()],
    };

    let mut sequences = Vec::new();
    for parent in &seq_parents {
        if !parent.is_dir() {
            continue;
        }
        for seq_dir in list_dirs(parent)? {
            if dir_name(&seq_dir).is_some_and(|n| is_content_dir(&n)) {
                sequences.push(seq_dir);
            }
        }
    }
    Ok(ProjectWalk { layout, sequences })
}

/// Every shot in the project, across both PRISM trees, flattened.
pub(crate) fn project_shots(project_root: &Path) -> AppResult<Vec<ShotEntry>> {
    let walk = project_walk(project_root)?;
    let mut out = Vec::new();
    for seq_dir in &walk.sequences {
        out.extend(walk.shots(seq_dir)?);
    }
    Ok(out)
}

/// Every shot in one sequence. Resolves the PRISM layout by walking up, so this
/// works when handed a sequence path directly (as the gallery and timeline are).
pub(crate) fn sequence_shots(seq_dir: &Path) -> AppResult<Vec<ShotEntry>> {
    let layout = prism::layout_for(seq_dir);
    shots_in(seq_dir, layout.as_ref())
}

fn shots_in(seq_dir: &Path, layout: Option<&prism::PrismLayout>) -> AppResult<Vec<ShotEntry>> {
    // `entities_in` is what the sequence dropdowns use, so the scans and the
    // dropdowns cannot disagree about what counts as an entity — which matters
    // in the asset tree, where a category is not an asset.
    let entity_dirs = match layout {
        Some(l) => prism::entities_in(l, seq_dir)?,
        None => list_dirs(seq_dir)?,
    };

    let mut out = Vec::new();
    for entity_dir in entity_dirs {
        let Some(shot_name) = dir_name(&entity_dir) else {
            continue;
        };
        if !is_content_dir(&shot_name) {
            continue;
        }
        let media_root = match layout {
            Some(_) => prism::media_root_for(&entity_dir),
            None => entity_dir.clone(),
        };
        // A PRISM entity that has never been generated into has no AI root.
        if !media_root.is_dir() {
            continue;
        }
        out.push(ShotEntry {
            media_root,
            shot_name,
        });
    }
    Ok(out)
}

/// A shot's version folders, sorted. Order is load-bearing: the timeline takes
/// the last entry as "latest".
pub(crate) fn shot_versions(media_root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = list_dirs(media_root)?
        .into_iter()
        .filter(|p| dir_name(p).is_some_and(|n| is_content_dir(&n)))
        .collect();
    out.sort();
    Ok(out)
}

/// Media files directly inside `dir`, sorted by name. Thumbnails excluded —
/// they are companions to their media, not media in their own right.
pub(crate) fn dir_media(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file() && !is_thumb(&path) && is_media_ext(&path) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

/// Every `(version_dir, media_path)` pair under a shot, in version then
/// filename order.
pub(crate) fn shot_media(media_root: &Path) -> AppResult<Vec<(PathBuf, PathBuf)>> {
    let mut out = Vec::new();
    for version in shot_versions(media_root)? {
        for media in dir_media(&version)? {
            out.push((version.clone(), media));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestProject;

    /// The policy, stated once and pinned. These names are excluded at *every*
    /// level — sequence, entity and version.
    #[test]
    fn src_sel_and_hidden_dirs_are_never_content() {
        assert!(is_content_dir("gen001"));
        assert!(is_content_dir("v0001"));
        assert!(is_content_dir("shot_010"));
        assert!(!is_content_dir(SRC_DIR));
        assert!(!is_content_dir(SEL_DIR));
        assert!(!is_content_dir(TRASH_DIR));
        assert!(!is_content_dir(".git"));
        assert!(!is_content_dir("$RECYCLE.BIN"));
    }

    #[test]
    fn native_project_walks_sequences_and_shots() {
        let p = TestProject::new("walk-native");
        p.media("seq1/shot1/gen001/a.png", None);
        p.media("seq1/shot1/gen002/b.png", None);
        p.media("seq1/shot2/gen001/c.png", None);
        p.media("seq2/shotA/gen001/d.png", None);
        // None of these are shots or versions.
        p.media("SRC/global-ref.png", None);
        p.media("seq1/SRC/seq-ref.png", None);
        p.media("seq1/shot1/SRC/shot-ref.png", None);
        p.media("seq1/shot1/SEL/kept.png", None);
        p.dir("seq1/shot1/$RECYCLE.BIN");

        let shots = project_shots(&p.root).unwrap();
        let mut names: Vec<_> = shots.iter().map(|s| s.shot_name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["shot1", "shot2", "shotA"]);

        let shot1 = shots
            .iter()
            .find(|s| s.shot_name == "shot1")
            .expect("shot1");
        // SRC, SEL and the hidden dir are all absent.
        let versions: Vec<String> = shot_versions(&shot1.media_root)
            .unwrap()
            .iter()
            .filter_map(|p| dir_name(p))
            .collect();
        assert_eq!(versions, vec!["gen001", "gen002"]);

        let media: Vec<String> = shot_media(&shot1.media_root)
            .unwrap()
            .iter()
            .filter_map(|(_, m)| dir_name(m))
            .collect();
        assert_eq!(media, vec!["a.png", "b.png"]);
    }

    #[test]
    fn thumbnails_are_not_media() {
        let p = TestProject::new("walk-thumbs");
        p.media("seq1/shot1/gen001/clip.mp4", None);
        // Both suffixes: the JPEG a new poster gets, and the PNG every
        // pre-switch project is full of.
        std::fs::write(p.root.join("seq1/shot1/gen001/clip.thumb.jpg"), b"t").unwrap();
        std::fs::write(p.root.join("seq1/shot1/gen001/legacy.thumb.png"), b"t").unwrap();
        std::fs::write(p.root.join("seq1/shot1/gen001/notes.txt"), b"x").unwrap();

        let media: Vec<String> = dir_media(&p.root.join("seq1/shot1/gen001"))
            .unwrap()
            .iter()
            .filter_map(|m| dir_name(m))
            .collect();
        assert_eq!(media, vec!["clip.mp4"]);
    }

    #[test]
    fn prism_project_walks_both_trees_and_lands_on_the_ai_render_product() {
        let p = TestProject::prism("walk-prism");
        p.media(
            "03_Production/Shots/MOD/s0010/Renders/2dRender/AI/v0001/a.png",
            None,
        );
        p.dir("03_Production/Shots/MOD/s0020/Scenefiles"); // never generated into
        p.dir("03_Production/Shots/MOD/_sequence/Export"); // PRISM pseudo-entity
                                                           // Generated into before v0.5.1 — still found, at the old location.
        p.media("03_Production/Shots/MOD/s0030/Renders/AI/v0001/b.png", None);
        p.media(
            "03_Production/Assets/PROPS/cube/Renders/2dRender/AI/v0001/c.png",
            None,
        );

        let shots = project_shots(&p.root).unwrap();
        let names: Vec<_> = shots.iter().map(|s| s.shot_name.clone()).collect();

        assert!(names.contains(&"s0010".to_string()), "shot tree walked");
        assert!(names.contains(&"cube".to_string()), "asset tree walked");
        assert!(
            !names.contains(&"s0020".to_string()),
            "an entity with no AI render product has no media root"
        );
        assert!(
            !names.contains(&"_sequence".to_string()),
            "PRISM's _sequence pseudo-entity is skipped"
        );

        let s0010 = shots.iter().find(|s| s.shot_name == "s0010").unwrap();
        assert!(
            s0010.media_root.ends_with("AI"),
            "media root is the AI folder, got {}",
            s0010.media_root.display()
        );
        assert!(
            s0010.media_root.to_string_lossy().contains("s0010"),
            "and it still sits under the entity the name came from"
        );

        let s0030 = shots.iter().find(|s| s.shot_name == "s0030").unwrap();
        assert!(
            s0030.media_root.ends_with("Renders/AI"),
            "a pre-v0.5.1 shot keeps its media root, got {}",
            s0030.media_root.display()
        );
    }

    /// The state right after "New Project", and the easiest thing to break.
    #[test]
    fn an_empty_project_yields_nothing_rather_than_erroring() {
        let p = TestProject::new("walk-empty");
        assert!(project_shots(&p.root).unwrap().is_empty());
    }

    #[test]
    fn sequence_shots_matches_the_project_walk_for_that_sequence() {
        let p = TestProject::new("walk-seq");
        p.media("seq1/shot1/gen001/a.png", None);
        p.media("seq1/shot2/gen001/b.png", None);
        p.media("seq2/shotA/gen001/c.png", None);

        let mut from_seq: Vec<_> = sequence_shots(&p.root.join("seq1"))
            .unwrap()
            .iter()
            .map(|s| s.shot_name.clone())
            .collect();
        from_seq.sort();
        assert_eq!(from_seq, vec!["shot1", "shot2"]);
    }
}
