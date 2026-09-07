//! Where reference images live, resolved in one place.
//!
//! Two levels, and under PRISM neither is where you would guess:
//!
//! ```text
//! native                          PRISM
//! <project>/SRC                   <project>/04_Resources
//! <shot>/SRC                      <entity>/Resources
//! ```
//!
//! A PRISM project already has a folder for reference material —
//! `04_Resources`, which real projects fill with `clouds/`, `Libraries/` and so
//! on — and burying aiSLAP's own copy in `<project>/SRC` put it somewhere the
//! pipeline knows nothing about. The shot level was worse: `<mediaRoot>/SRC`
//! sits *inside* `Renders/2dRender/AI`, an output tree, so reference input was
//! filed under render output.
//!
//! **These roots hold subfolders**, which is the other half of why this module
//! exists. A root is a browsing root, not a bucket: the gallery lists its loose
//! media and renders each subfolder as a section. New references go into
//! [`default_ref_dir`] — a `SRC` folder *inside* the root under PRISM, and the
//! root itself in a native project, where the root already is `SRC`.
//!
//! Nothing migrates. Files at the pre-existing locations are left exactly where
//! they are and simply stop being listed — same policy as the
//! `Renders/2dRender/AI` move, and for the same reason: relocating files inside
//! a pipeline is PRISM's job.
//!
//! # Why every caller comes through here
//!
//! The shot root is no longer derivable by appending `/SRC` to the shot path,
//! because under PRISM it is not below the shot path at all. Five TypeScript
//! call sites and three Rust ones used to build these paths by concatenation;
//! they now ask for a resolved path instead. `src/lib/prism.ts` deliberately has
//! no counterpart to any of this — see `docs/prism.md` § Mirroring.

use std::path::{Path, PathBuf};

use crate::commands::fsutil::SRC_DIR;
use crate::commands::prism;

/// Project-wide reference root: `<project>/04_Resources` under PRISM,
/// `<project>/SRC` otherwise.
///
/// Takes the project root itself, so callers that already resolved one (via
/// `ProjectRoot::resolve`, which walks up to `project.json` and prefers a
/// pipeline root above it) don't resolve it twice.
pub(crate) fn global_ref_root(project_root: &Path) -> PathBuf {
    match prism::detect(project_root) {
        Some(layout) => layout.resources_root(),
        None => project_root.join(SRC_DIR),
    }
}

/// Shot-level reference root: `<entity>/Resources` under PRISM,
/// `<mediaRoot>/SRC` otherwise.
///
/// `media_root` is what the session carries as its shot path. `entity_for`
/// answers "is this a PRISM media root, and whose?" for both the current and
/// the legacy `AI` layout, so a pre-v0.5.1 shot resolves to the same entity
/// folder as a fresh one — the two histories share a resources folder even
/// though they don't share a render product.
pub(crate) fn shot_ref_root(media_root: &Path) -> PathBuf {
    match prism::entity_for(media_root) {
        Some(entity) => entity.join(prism::ENTITY_RESOURCES_DIR),
        None => media_root.join(SRC_DIR),
    }
}

/// Where a *new* reference is written, given either root above.
///
/// Under PRISM this is a `SRC` folder inside the root, so aiSLAP's own copies
/// stay separate from whatever else lives there — dropping a reference into a
/// PRISM project must not scatter files through `04_Resources` alongside a
/// person's `clouds/` and `Libraries/`. Natively the root already *is* `SRC`,
/// and nesting another one inside it would be silly, so the root is returned
/// unchanged.
pub(crate) fn default_ref_dir(ref_root: &Path) -> PathBuf {
    if ref_root.file_name().and_then(|n| n.to_str()) == Some(SRC_DIR) {
        return ref_root.to_path_buf();
    }
    ref_root.join(SRC_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestProject;

    #[test]
    fn native_roots_are_the_src_folders_and_are_their_own_write_target() {
        let p = TestProject::new("refroots-native");
        let shot = p.root.join("seq1/shot1");

        let global = global_ref_root(&p.root);
        let shot_root = shot_ref_root(&shot);
        assert_eq!(global, p.root.join("SRC"));
        assert_eq!(shot_root, shot.join("SRC"));
        // A native root already is SRC — no SRC/SRC.
        assert_eq!(default_ref_dir(&global), global);
        assert_eq!(default_ref_dir(&shot_root), shot_root);
    }

    #[test]
    fn prism_roots_are_the_resources_folders_with_src_inside() {
        let p = TestProject::prism("refroots-prism");
        let entity = p.root.join("03_Production/Shots/AMA/s0010");
        let media_root = entity.join("Renders/2dRender/AI");

        let global = global_ref_root(&p.root);
        assert_eq!(global, p.root.join("04_Resources"));
        assert_eq!(default_ref_dir(&global), p.root.join("04_Resources/SRC"));

        let shot_root = shot_ref_root(&media_root);
        assert_eq!(shot_root, entity.join("Resources"));
        assert_eq!(default_ref_dir(&shot_root), entity.join("Resources/SRC"));
    }

    /// A shot generated into before v0.5.1 resolves to the same entity
    /// resources folder as a fresh one — the render products differ, the
    /// reference folder does not.
    #[test]
    fn a_legacy_prism_media_root_resolves_to_the_same_resources_folder() {
        let p = TestProject::prism("refroots-prism-legacy");
        let entity = p.root.join("03_Production/Shots/AMA/s0030");

        assert_eq!(
            shot_ref_root(&entity.join("Renders/AI")),
            shot_ref_root(&entity.join("Renders/2dRender/AI")),
        );
    }
}
