# PRISM projects

A picked folder holding `00_Pipeline/pipeline.json` is a PRISM project. Entities then
live under `03_Production/Shots/<SEQ>/<SHOT>` or
`03_Production/Assets/<CATEGORY>/<ASSET>` — roots parsed from `folder_structure`,
falling back to those defaults. The SessionBar grows a SHOT/ASSET toggle that picks
which tree the SEQUENCE dropdown lists.

For the end-user view of this, see [guides/](guides/). This file is the resolution
reference.

---

## The one idea to hold onto

> **`sessionStore.shotPath` becomes the media root `<entity>/Renders/AI`, not the
> entity folder.**

Everything below that path — version columns, `SRC`, `shot.json`, tags, version
selects, the `<shot>/<version>/<file>` layout that `image.rs` and the gallery rely on
— then works completely unchanged. `shotEntityPath` carries the entity separately, for
the dropdown.

Every consequence below follows from that one substitution.

---

## Consequences

**Names.** `basename(shotPath)` would read `"AI"`. Anything needing the sequence or
shot name — filename tokens, script-heading matching, thumbnails, timeline and queue
labels — uses `seqShotNames` / `seqShotNamesForMedia` from `lib/prism.ts`. Rust emits
entity names in `shot_name` and media roots in `shot_path`. The *project's* name works
the same way: `globals.project_name` (`PrismLayout.project_name`, `PrismInfo.projectName`)
wins over the project folder's basename wherever a human-readable project title is
needed — `project_title_for` in `commands/session.rs`, mirrored client-side in
`sessionStore.setProject` — see [storage.md](storage.md)'s `projects` table.

**Depth.** The project root is no longer `shotPath/../..`. Rust walks *up* to
`project.json` (`project_root_for`); the TypeScript side carries `projectPath` on
`JobSpec` / `DownloadCtx` (and on the pending record, for recovery) rather than
deriving it.

**Scans** that walk project → sequence → shot take the entity roots and hop through
`media_root_for`: `sequence_stacks_scan`, `timeline_init`, `project_cost_scan`,
`db::project_reconcile`. `project_tag_scan` strips the entity-root prefix before
grouping. `_`-prefixed entities — PRISM's `_sequence` pseudo-entity — are skipped
everywhere.

**Versions follow the pipeline, not the project sidecar.** Prefix from
`globals.versionFormat` (`"v#"` → `v`), padding from `globals.versionPadding` (4 →
`v0001`). `version_prefix_for` ignores `project.json`'s prefix in a PRISM project, and
`project_version_prefix_set` refuses outright. `is_version_name` accepts 3–6 digits so
both aiSLAP's native `gen001` and PRISM's `v0001` read back as versions.

**The asset tree has no fixed depth.** `Assets/@asset_path@` means an asset can sit
directly under `Assets` *or* inside a category — both shapes occur in real projects
(`Assets/aus_map` alongside `Assets/Signs/The_Corsk_Screw`). A folder is an asset when
it holds one of PRISM's entity directories (`Scenefiles`, `Export`, `Renders`,
`Playblasts`, `Textures`), mirroring PRISM's own non-strict detection.
`asset_sequences` offers the categories *plus the assets root itself* when assets sit
directly in it. `entities_in` is what every sequence-level scan walks, so the scans and
the dropdowns cannot disagree.

**A PRISM root beats a nearer `project.json`** (`project_root_for`). Opening
`03_Production/Assets` as a standalone project leaves a stray marker inside the
pipeline; resolving to that marker silently keyed version naming and the tag index to
the wrong root.

**aiSLAP's own files** — `project.json`, `script.md`, `SRC/` — sit at the PRISM
project root, which is why `project_root_for` has to find `project.json` by walking up
from a media path rather than assuming a fixed depth.

**PRISM owns entity creation.** `sequence_create` / `shot_create` refuse in a PRISM
project and the UI greys them out. aiSLAP only ever creates `Renders/AI` and its
version folders, via `prism_media_root_ensure`, called by `setShot` on first visit.

**A corrupt `pipeline.json` is still PRISM.** Detection falls back to the stock folder
structure rather than treating the project as native — deliberately, since the
alternative silently relocates where output lands.

---

## Mirroring

`src/lib/prism.ts` mirrors `src-tauri/src/commands/prism.rs`, but only in the
direction the frontend needs: entity ← media root, plus name resolution. There is
deliberately **no** TypeScript counterpart to `media_root_for`, because creating a
media root also creates directories — `setShot` calls `cmd.prism_media_root_ensure`
rather than deriving the path locally.
