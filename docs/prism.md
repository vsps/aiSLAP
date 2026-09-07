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

> **`sessionStore.shotPath` becomes the media root `<entity>/Renders/2dRender/AI`,
> not the entity folder.**

Everything below that path — version columns, `SRC`, `shot.json`, tags, version
selects, the `<shot>/<version>/<file>` layout that `image.rs` and the gallery rely on
— then works completely unchanged. `shotEntityPath` carries the entity separately, for
the dropdown.

Every consequence below follows from that one substitution.

---

## Consequences

**Two media roots, one per entity.** `AI` is a render product in the pipeline's 2D
render tree, so the media root is `<entity>/Renders/2dRender/AI`. Everything generated
before v0.5.1 sits in `<entity>/Renders/AI` instead. `media_root_for` returns the old
path when *that entity* already has one and the new path otherwise, and `entity_for`
strips either suffix — so a pre-v0.5.1 shot keeps its whole history in one column set
and a fresh one lands where PRISM expects a render product. The choice is per entity,
not per project: two shots in the same sequence can legitimately disagree. Nothing
migrates automatically; moving a shot's renders is PRISM's job.

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

**aiSLAP's own files** — `project.json` and `script.md` — sit at the PRISM project
root, which is why `project_root_for` has to find `project.json` by walking up from a
media path rather than assuming a fixed depth.

**References live in the pipeline's own folders, not in `SRC/`.** `commands/refroots.rs`
resolves both levels and every caller goes through it:

| | native | PRISM |
|---|---|---|
| project-level | `<project>/SRC` | `<project>/04_Resources` |
| shot-level | `<shot>/SRC` | `<entity>/Resources` |

Each is a **browsing root**, not a bucket: the gallery lists its loose media and renders
each subfolder as a collapsible section, read only when opened (`dir_children_scan`).
New references go to `default_ref_dir` — a `SRC` folder *inside* the root under PRISM,
the root itself natively, where it already is `SRC`.

`04_Resources` is not declared in `folder_structure`. The stock name is used whenever
that folder exists; only when it doesn't is the dir inferred from the `textures`
template's first segment, and then only if that segment isn't one of the entity trees —
see `resources_rel_from` for why a bare derivation fails silently. `<entity>/Resources`
is aiSLAP's own convention; PRISM neither declares nor always creates it.

**Nothing migrated.** Files at the old `<project>/SRC` and `<mediaRoot>/SRC` stay on
disk and simply stop being listed — same policy as the `Renders/2dRender/AI` move, and
for the same reason: relocating files inside a pipeline is PRISM's job.

**PRISM owns entity creation.** `sequence_create` / `shot_create` refuse in a PRISM
project and the UI greys them out. Inside an entity PRISM already made, aiSLAP creates
`Renders/2dRender/AI` and its version folders plus `Resources/SRC`, via
`prism_media_root_ensure`, called by `setShot` on first visit. The media root is fatal
if it can't be made; the reference folder is best-effort, so a read-only share still
opens the shot. `project_open` does the same for the project-level root.

**PRISM owns removal too — aiSLAP never deletes or trashes inside a pipeline.**
`image_trash` and `column_delete` both refuse with `PRISM_NO_DELETE` when
`prism_root_for` finds a pipeline root above the path, and no `TRASH/` folder is ever
created. The frontend hides every affordance ahead of that (`sessionStore.prism` is
non-null): the gallery trashcan, the context-menu entry, the zoom-modal buttons and the
per-column delete. The refusal in Rust is the backstop behind a stale UI, not the
primary gate. See [storage.md](storage.md) for what trashing does in a native project.

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

The same rule covers reference roots, and there the frontend has no choice: the shot's
is `<entity>/Resources`, which is not below `shotPath` at all, so no amount of joining
gets there. `cmd.ref_dir_ensure(shotPath, scope)` resolves and creates it; the gallery
columns carry their own `id` / `destDir` for everything else.
