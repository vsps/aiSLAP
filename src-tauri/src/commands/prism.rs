//! PRISM Pipeline awareness.
//!
//! A project is a PRISM project when it holds `00_Pipeline/pipeline.json`.
//! That file's `folder_structure` block tells us where entities live — for the
//! stock structure, `03_Production/Shots/<SEQ>/<SHOT>` and
//! `03_Production/Assets/<CATEGORY>/<ASSET>`.
//!
//! aiSLAP writes into `<entity>/Renders/AI`, and that media root is what the
//! session carries as its "shot path" — so version columns, `SRC`, sidecars,
//! tags and the `<shot>/<version>/<file>` layout every other module assumes all
//! keep working unchanged. The `Renders/AI` suffix is also what makes entity
//! naming stateless: a path ending in it has its entity two levels up.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::fsutil::{as_str, highest_version_number, list_dirs, VersionNaming, SRC_DIR};
use crate::error::AppResult;
use crate::fsjson::ensure_dir;

/// Marker that identifies a PRISM project root.
pub(crate) const PIPELINE_CONFIG: &str = "00_Pipeline/pipeline.json";

/// Where aiSLAP output lives inside a PRISM entity folder.
pub(crate) const AI_MEDIA_SUBPATH: &str = "Renders/AI";

const DEFAULT_SHOTS_REL: &str = "03_Production/Shots";
const DEFAULT_ASSETS_REL: &str = "03_Production/Assets";
const DEFAULT_VERSION_PADDING: usize = 4;
const DEFAULT_VERSION_PREFIX: &str = "v";

#[derive(Clone, Debug)]
pub(crate) struct PrismLayout {
    pub root: PathBuf,
    /// Project-relative dir holding sequence folders, e.g. "03_Production/Shots".
    pub shots_rel: String,
    /// Project-relative dir holding asset category folders.
    pub assets_rel: String,
    /// Digits in a version folder name — PRISM's `globals.versionPadding`.
    pub version_padding: usize,
    /// Letters before the digits, from PRISM's `globals.versionFormat` ("v#").
    pub version_prefix: String,
    pub project_name: String,
}

impl PrismLayout {
    /// Dir holding the sequence folders for an entity type ("asset" or, for
    /// anything else, shots — the default).
    pub fn entity_root(&self, entity_type: Option<&str>) -> PathBuf {
        let rel = if entity_type == Some("asset") {
            &self.assets_rel
        } else {
            &self.shots_rel
        };
        self.root.join(rel)
    }
}

/// Serializable view handed to the frontend by `prism_detect`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrismInfo {
    pub root: String,
    pub shots_root: String,
    pub assets_root: String,
    pub version_padding: usize,
    pub project_name: String,
}

/// Pull one `folder_structure.<key>.value` template down to a project-relative
/// directory: strip the leading `@project_path@/`, then cut at the first
/// remaining `@` token (`/@sequence@`, `/@asset_path@`). PRISM also allows
/// Python expression templates (`[expression,...]`), which we can't evaluate —
/// those, and anything unparseable, fall back to the stock structure.
fn rel_dir_from_template(cfg: &serde_json::Value, key: &str, fallback: &str) -> String {
    let raw = cfg
        .get("folder_structure")
        .and_then(|f| f.get(key))
        .and_then(|k| k.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if raw.is_empty() || raw.starts_with("[expression,") {
        return fallback.to_string();
    }
    let after_root = match raw.strip_prefix("@project_path@/") {
        Some(rest) => rest,
        None => return fallback.to_string(),
    };
    let cut = after_root.find('@').unwrap_or(after_root.len());
    let rel = after_root[..cut].trim_matches('/').replace('\\', "/");
    if rel.is_empty() {
        fallback.to_string()
    } else {
        rel
    }
}

/// Letters leading PRISM's `versionFormat` ("v#" -> "v"). Anything after the
/// first non-letter is the number placeholder.
fn prefix_from_format(format: &str) -> String {
    format
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect()
}

/// Read the PRISM layout for a project root, or None when it isn't one.
pub(crate) fn detect(root: &Path) -> Option<PrismLayout> {
    let config_path = root.join(PIPELINE_CONFIG);
    if !config_path.is_file() {
        return None;
    }
    // A PRISM project with an unreadable pipeline.json is still a PRISM
    // project — fall back to the stock structure rather than silently
    // treating it as a plain aiSLAP folder.
    let cfg: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let globals = cfg.get("globals");
    Some(PrismLayout {
        root: root.to_path_buf(),
        shots_rel: rel_dir_from_template(&cfg, "sequences", DEFAULT_SHOTS_REL),
        assets_rel: rel_dir_from_template(&cfg, "assets", DEFAULT_ASSETS_REL),
        version_padding: globals
            .and_then(|g| g.get("versionPadding"))
            .and_then(|v| v.as_u64())
            .filter(|n| (1..=6).contains(n))
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_VERSION_PADDING),
        version_prefix: globals
            .and_then(|g| g.get("versionFormat"))
            .and_then(|v| v.as_str())
            .map(prefix_from_format)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| DEFAULT_VERSION_PREFIX.to_string()),
        project_name: globals
            .and_then(|g| g.get("project_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Nearest ancestor (including `path`) that holds `00_Pipeline/pipeline.json`.
///
/// Deliberately independent of aiSLAP's own `project.json`: opening a folder
/// deep inside a pipeline as a standalone project leaves a marker there, and
/// resolving through those would make everything below it look non-PRISM.
pub(crate) fn prism_root_for(path: &Path) -> Option<PathBuf> {
    let mut cur = Some(path);
    while let Some(p) = cur {
        if p.join(PIPELINE_CONFIG).is_file() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

/// PRISM layout for any path inside a pipeline project.
pub(crate) fn layout_for(path: &Path) -> Option<PrismLayout> {
    detect(&prism_root_for(path)?)
}

/// Subfolders PRISM creates inside an entity. Their presence is what separates
/// an asset from a category folder: `03_Production/Assets/@asset_path@` is an
/// arbitrarily deep path, so `Assets/aus_map` (an asset) and `Assets/Signs`
/// (a category holding assets) both sit at the same level. This mirrors PRISM's
/// own non-strict asset detection (`globals.useStrictAssetDetection: false`).
const ENTITY_MARKERS: &[&str] = &["Scenefiles", "Export", "Renders", "Playblasts", "Textures"];

pub(crate) fn is_asset_entity(dir: &Path) -> bool {
    ENTITY_MARKERS.iter().any(|m| dir.join(m).is_dir())
}

/// Names that are never entities or categories — aiSLAP's own leftovers from a
/// folder that was once opened as a standalone project.
fn is_ignored_entity_name(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('$')
        || name.starts_with('_')
        || name == SRC_DIR
        || name == "SEL"
}

/// The "sequence" level of the asset tree: every category folder, plus the
/// assets root itself when assets sit directly inside it (as `Assets/aus_map`
/// does) — otherwise those assets would be unreachable through a UI that always
/// goes sequence -> shot.
pub(crate) fn asset_sequences(assets_root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut has_direct_asset = false;
    for dir in list_dirs(assets_root)? {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_ignored_entity_name(name) {
            continue;
        }
        if is_asset_entity(&dir) {
            has_direct_asset = true;
        } else {
            out.push(dir);
        }
    }
    if has_direct_asset {
        out.insert(0, assets_root.to_path_buf());
    }
    Ok(out)
}

/// Asset entities directly inside one asset-tree "sequence" (a category, or the
/// assets root itself).
pub(crate) fn asset_entities_in(seq_dir: &Path) -> AppResult<Vec<PathBuf>> {
    Ok(list_dirs(seq_dir)?
        .into_iter()
        .filter(|d| {
            d.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !is_ignored_entity_name(n))
                && is_asset_entity(d)
        })
        .collect())
}

/// Entity folders inside one sequence-level dir, for both trees. Every
/// sequence-level scan (gallery stacks, timeline, cost, reconcile) goes through
/// this so what they walk matches what the SHOT/ASSET dropdown offers.
pub(crate) fn entities_in(layout: &PrismLayout, seq_dir: &Path) -> AppResult<Vec<PathBuf>> {
    if is_in_asset_tree(layout, seq_dir) {
        return asset_entities_in(seq_dir);
    }
    Ok(list_dirs(seq_dir)?
        .into_iter()
        .filter(|d| {
            d.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !is_ignored_entity_name(n))
        })
        .collect())
}

/// Whether `path` sits in (or is) the layout's asset tree.
pub(crate) fn is_in_asset_tree(layout: &PrismLayout, path: &Path) -> bool {
    let root = as_str(&layout.entity_root(Some("asset")));
    let p = as_str(path);
    p == root || p.starts_with(&format!("{root}/"))
}

/// `<entity>/Renders/AI` — where aiSLAP media for this entity lives.
pub(crate) fn media_root_for(entity: &Path) -> PathBuf {
    entity.join("Renders").join("AI")
}

/// Inverse of `media_root_for`: the entity folder a media root belongs to, or
/// None when `path` isn't one.
pub(crate) fn entity_for(path: &Path) -> Option<PathBuf> {
    let s = as_str(path);
    let stripped = s.strip_suffix(&format!("/{AI_MEDIA_SUBPATH}"))?;
    Some(PathBuf::from(stripped))
}

/// True when `path` already points at an AI media root.
pub(crate) fn is_media_root(path: &Path) -> bool {
    entity_for(path).is_some()
}

/// Version-folder digit count for newly minted folders under `path`: PRISM's
/// configured padding, else aiSLAP's historical 3.

// ---------- Commands ----------

#[tauri::command]
pub fn prism_detect(project_path: String) -> Option<PrismInfo> {
    let layout = detect(&PathBuf::from(&project_path))?;
    Some(PrismInfo {
        root: as_str(&layout.root),
        shots_root: as_str(&layout.entity_root(Some("shot"))),
        assets_root: as_str(&layout.entity_root(Some("asset"))),
        version_padding: layout.version_padding,
        project_name: layout.project_name,
    })
}

/// Ensure `<entity>/Renders/AI` (plus its `SRC` and a first version folder)
/// and return it. Creating this is always allowed — it's an output folder
/// inside an entity PRISM already made, not a pipeline entity itself.
/// Idempotent: handed a media root, it returns it unchanged.
#[tauri::command]
pub fn prism_media_root_ensure(entity_path: String) -> AppResult<String> {
    let entity = PathBuf::from(&entity_path);
    let media_root = if is_media_root(&entity) {
        entity
    } else {
        media_root_for(&entity)
    };
    ensure_dir(&media_root)?;
    ensure_dir(&media_root.join(SRC_DIR))?;
    // Only seed a version folder for a brand-new media root; an existing one
    // keeps whatever versions it has.
    //
    // One `read_dir` answers both "are there any versions?" and "what is the
    // highest?" — this used to scan the directory twice and parse pipeline.json
    // twice on top of that.
    let highest = highest_version_number(&media_root);
    if highest.is_none() {
        let naming = VersionNaming::for_path(&media_root);
        ensure_dir(&media_root.join(naming.name(1)))?;
    }
    Ok(as_str(&media_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn templates_resolve_to_project_relative_dirs() {
        let c = cfg(r#"{"folder_structure":{
                "sequences":{"value":"@project_path@/03_Production/Shots/@sequence@"},
                "assets":{"value":"@project_path@/03_Production/Assets/@asset_path@"}
            }}"#);
        assert_eq!(
            rel_dir_from_template(&c, "sequences", DEFAULT_SHOTS_REL),
            "03_Production/Shots"
        );
        assert_eq!(
            rel_dir_from_template(&c, "assets", DEFAULT_ASSETS_REL),
            "03_Production/Assets"
        );
    }

    #[test]
    fn templates_fall_back_when_unusable() {
        // Expression template, missing key, and a non-@project_path@ root all
        // fall back rather than producing a bogus directory.
        let c = cfg(r#"{"folder_structure":{
                "sequences":{"value":"[expression,template = \"x\"]"},
                "assets":{"value":"/mnt/elsewhere/@asset_path@"}
            }}"#);
        assert_eq!(
            rel_dir_from_template(&c, "sequences", DEFAULT_SHOTS_REL),
            DEFAULT_SHOTS_REL
        );
        assert_eq!(
            rel_dir_from_template(&c, "assets", DEFAULT_ASSETS_REL),
            DEFAULT_ASSETS_REL
        );
        assert_eq!(
            rel_dir_from_template(&cfg("{}"), "sequences", DEFAULT_SHOTS_REL),
            DEFAULT_SHOTS_REL
        );
    }

    #[test]
    fn media_root_and_entity_round_trip() {
        let entity = PathBuf::from("Z:/prj/03_Production/Shots/MOD/s0010");
        let media = media_root_for(&entity);
        assert_eq!(
            as_str(&media),
            "Z:/prj/03_Production/Shots/MOD/s0010/Renders/AI"
        );
        assert_eq!(
            entity_for(&media).map(|p| as_str(&p)),
            Some(as_str(&entity))
        );
        assert!(is_media_root(&media));
        // Not a media root: the entity itself, or a version folder inside one.
        assert!(!is_media_root(&entity));
        assert!(!is_media_root(&media.join("v0001")));
        // Backslashes normalize the same way (as_str does the conversion).
        let win = PathBuf::from(r"Z:\prj\03_Production\Shots\MOD\s0010\Renders\AI");
        assert_eq!(entity_for(&win).map(|p| as_str(&p)), Some(as_str(&entity)));
    }

    /// A PRISM project shaped like the real one on disk: two entity trees, a
    /// `_sequence` pseudo-entity, one shot that has never been generated into
    /// and one that already has a v0002.
    fn make_project() -> PathBuf {
        let base = std::env::temp_dir().join(format!("aislap-prismprj-{}", uuid::Uuid::new_v4()));
        let pipeline = base.join("00_Pipeline");
        std::fs::create_dir_all(&pipeline).unwrap();
        std::fs::write(
            pipeline.join("pipeline.json"),
            r#"{"globals":{"project_name":"11488_DEJAVU","versionPadding":4},
                "folder_structure":{
                  "sequences":{"value":"@project_path@/03_Production/Shots/@sequence@"},
                  "assets":{"value":"@project_path@/03_Production/Assets/@asset_path@"}}}"#,
        )
        .unwrap();
        // No project.json — `project_open` writes aiSLAP's marker at the PRISM
        // root on first open, which is also what seeds the "v" version prefix.
        let shots = base.join("03_Production/Shots/MOD");
        std::fs::create_dir_all(shots.join("_sequence/Export")).unwrap();
        std::fs::create_dir_all(shots.join("s0010/Scenefiles")).unwrap();
        std::fs::create_dir_all(shots.join("s0020/Renders/AI/v0002")).unwrap();
        std::fs::create_dir_all(base.join("03_Production/Assets/PROPS/cube/Export")).unwrap();
        base
    }

    /// The AMAROK project's real shape: an asset directly under `Assets`
    /// (`aus_map`, with an old `ai/` output folder inside it), a category
    /// (`Signs`) holding two assets, and stray `project.json` markers left by
    /// opening `Assets` and `Assets/Signs` as standalone projects.
    fn make_mixed_asset_project() -> PathBuf {
        let base = make_project();
        let assets = base.join("03_Production/Assets");
        for marker in ["Export", "Playblasts", "Renders", "Scenefiles", "Textures"] {
            std::fs::create_dir_all(assets.join("aus_map").join(marker)).unwrap();
            std::fs::create_dir_all(assets.join("Signs/Corc_River_Raptors").join(marker)).unwrap();
            std::fs::create_dir_all(assets.join("Signs/The_Corsk_Screw").join(marker)).unwrap();
        }
        // Old aiSLAP output inside an asset — must never be offered as an asset.
        std::fs::create_dir_all(assets.join("aus_map/ai/gen001")).unwrap();
        std::fs::create_dir_all(assets.join("aus_map/ai/Renders")).unwrap();
        std::fs::create_dir_all(assets.join("Signs/SRC")).unwrap();
        std::fs::write(assets.join(crate::commands::fsutil::PROJECT_SIDECAR), "{}").unwrap();
        std::fs::write(
            assets
                .join("Signs")
                .join(crate::commands::fsutil::PROJECT_SIDECAR),
            r#"{"versionPrefix":"gen"}"#,
        )
        .unwrap();
        base
    }

    #[test]
    fn asset_tree_separates_categories_from_assets_at_any_depth() {
        let base = make_mixed_asset_project();
        let p = as_str(&base);
        let assets = format!("{p}/03_Production/Assets");

        // Sequence level: the assets root (because aus_map sits directly in it)
        // followed by the real categories. `SRC` is not a category.
        let seqs = crate::commands::session::project_open(p.clone(), Some("asset".into())).unwrap();
        assert_eq!(
            seqs,
            vec![
                assets.clone(),
                format!("{assets}/PROPS"),
                format!("{assets}/Signs"),
            ]
        );

        // The root entry lists only the asset, not the category beside it.
        let root_entities = crate::commands::session::sequence_open(assets.clone()).unwrap();
        assert_eq!(root_entities.shots, vec![format!("{assets}/aus_map")]);

        // The category lists its assets — and `SRC` is filtered out.
        let signs = crate::commands::session::sequence_open(format!("{assets}/Signs")).unwrap();
        assert_eq!(
            signs.shots,
            vec![
                format!("{assets}/Signs/Corc_River_Raptors"),
                format!("{assets}/Signs/The_Corsk_Screw"),
            ]
        );

        // The old `ai/` output folder inside aus_map is not an asset, so
        // descending into aus_map is never offered in the first place.
        assert!(!is_asset_entity(&base.join("03_Production/Assets/Signs")));
        assert!(is_asset_entity(&base.join("03_Production/Assets/aus_map")));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The bug behind `gen001`: a stray `project.json` deeper in the pipeline
    /// shadowed the PRISM root, so version naming fell back to the sidecar's
    /// prefix and aiSLAP's 3-digit padding.
    #[test]
    fn a_stray_project_marker_does_not_shadow_the_prism_root() {
        let base = make_mixed_asset_project();
        let p = as_str(&base);
        let asset = base.join("03_Production/Assets/Signs/The_Corsk_Screw");

        assert_eq!(
            as_str(&crate::commands::fsutil::project_root_for(&asset).unwrap()),
            p,
            "PRISM root must win over Assets/Signs/project.json"
        );
        assert!(layout_for(&asset).is_some());

        let media = prism_media_root_ensure(as_str(&asset)).unwrap();
        assert!(
            PathBuf::from(&media).join("v0001").is_dir(),
            "expected v0001 in {media}"
        );
        assert_eq!(
            crate::commands::fsutil::VersionNaming::for_path(&PathBuf::from(&media)).prefix,
            "v"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_open_lists_the_selected_entity_tree() {
        let base = make_project();
        let p = as_str(&base);

        let shots = crate::commands::session::project_open(p.clone(), Some("shot".into())).unwrap();
        assert_eq!(shots, vec![format!("{p}/03_Production/Shots/MOD")]);

        let assets =
            crate::commands::session::project_open(p.clone(), Some("asset".into())).unwrap();
        assert_eq!(assets, vec![format!("{p}/03_Production/Assets/PROPS")]);

        // No entity type → shots, the default tree.
        assert_eq!(
            crate::commands::session::project_open(p.clone(), None).unwrap(),
            shots
        );

        // `_sequence` is PRISM's sequence-level entity, not a shot.
        let opened =
            crate::commands::session::sequence_open(format!("{p}/03_Production/Shots/MOD"))
                .unwrap();
        assert_eq!(
            opened.shots,
            vec![
                format!("{p}/03_Production/Shots/MOD/s0010"),
                format!("{p}/03_Production/Shots/MOD/s0020"),
            ]
        );

        // Entity creation belongs to PRISM.
        assert!(crate::commands::session::sequence_create(p.clone(), "NEW".into()).is_err());
        assert!(crate::commands::session::shot_create(
            format!("{p}/03_Production/Shots/MOD"),
            "s0030".into()
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// PRISM's own versionFormat wins over whatever the project sidecar says —
    /// the renders have to sit alongside the rest of the pipeline's versions.
    #[test]
    fn prism_version_naming_ignores_the_project_prefix() {
        let base = make_project();
        let p = as_str(&base);
        crate::commands::session::project_open(p.clone(), Some("shot".into())).unwrap();

        // Force the sidecar to the aiSLAP default a native project would use.
        let sidecar_path = base.join(crate::commands::fsutil::PROJECT_SIDECAR);
        let mut sidecar: crate::domain::ProjectSidecar =
            crate::fsjson::read_json_or_default(&sidecar_path).unwrap();
        sidecar.version_prefix = "gen".into();
        crate::fsjson::write_json_atomic(&sidecar_path, &sidecar).unwrap();

        let media = prism_media_root_ensure(format!("{p}/03_Production/Shots/MOD/s0010")).unwrap();
        assert_eq!(
            crate::commands::fsutil::next_version_name(&PathBuf::from(&media)),
            "v0002",
            "PRISM prefix + padding, not the sidecar's gen001"
        );
        // What the UI reports is what's actually used.
        assert_eq!(
            crate::commands::session::project_version_prefix_get(p.clone()).unwrap(),
            "v"
        );
        // And it can't be overridden from aiSLAP.
        assert!(
            crate::commands::session::project_version_prefix_set(p.clone(), "gen".into()).is_err()
        );

        assert_eq!(prefix_from_format("v#"), "v");
        assert_eq!(prefix_from_format("ver###"), "ver");
        assert_eq!(
            prefix_from_format("###"),
            "",
            "falls back to \"v\" in detect"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn media_root_ensure_seeds_a_padded_version_and_leaves_existing_ones() {
        let base = make_project();
        let p = as_str(&base);
        // Opening the project is what mints project.json — and for a PRISM
        // project it seeds the "v" prefix to match PRISM's versionFormat.
        crate::commands::session::project_open(p.clone(), Some("shot".into())).unwrap();
        assert_eq!(
            crate::commands::session::project_version_prefix_get(p.clone()).unwrap(),
            "v"
        );

        // Fresh shot: creates Renders/AI with SRC and a padded first version.
        let media = prism_media_root_ensure(format!("{p}/03_Production/Shots/MOD/s0010")).unwrap();
        assert_eq!(
            media,
            format!("{p}/03_Production/Shots/MOD/s0010/Renders/AI")
        );
        assert!(PathBuf::from(&media).join(SRC_DIR).is_dir());
        assert!(
            PathBuf::from(&media).join("v0001").is_dir(),
            "first version folder should use PRISM's 4-digit padding"
        );

        // Idempotent, and a media root passed straight in is accepted.
        assert_eq!(prism_media_root_ensure(media.clone()).unwrap(), media);

        // Existing versions are left alone, and the next one continues the run.
        let existing =
            prism_media_root_ensure(format!("{p}/03_Production/Shots/MOD/s0020")).unwrap();
        let existing = PathBuf::from(&existing);
        assert!(existing.join("v0002").is_dir());
        assert!(!existing.join("v0001").is_dir(), "must not backfill v0001");
        assert_eq!(
            crate::commands::fsutil::next_version_name(&existing),
            "v0003"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn detect_reads_padding_and_name() {
        let base = std::env::temp_dir().join(format!("aislap-prism-{}", uuid::Uuid::new_v4()));
        let pipeline = base.join("00_Pipeline");
        std::fs::create_dir_all(&pipeline).unwrap();
        assert!(detect(&base).is_none(), "no pipeline.json → not PRISM");

        std::fs::write(
            pipeline.join("pipeline.json"),
            r#"{"globals":{"project_name":"11488_DEJAVU","versionPadding":4},
                "folder_structure":{"sequences":{"value":"@project_path@/03_Production/Shots/@sequence@"}}}"#,
        )
        .unwrap();
        let l = detect(&base).expect("PRISM");
        assert_eq!(l.version_padding, 4);
        assert_eq!(l.project_name, "11488_DEJAVU");
        assert_eq!(l.shots_rel, "03_Production/Shots");
        assert_eq!(l.assets_rel, DEFAULT_ASSETS_REL);
        assert_eq!(
            as_str(&l.entity_root(Some("asset"))),
            format!("{}/03_Production/Assets", as_str(&base))
        );

        // Corrupt config still reads as PRISM, on the stock structure.
        std::fs::write(pipeline.join("pipeline.json"), "{not json").unwrap();
        let l = detect(&base).expect("still PRISM");
        assert_eq!(l.shots_rel, DEFAULT_SHOTS_REL);
        assert_eq!(l.version_padding, DEFAULT_VERSION_PADDING);

        let _ = std::fs::remove_dir_all(&base);
    }
}
