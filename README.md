<pre>
 ▄▄▄       ██▓      ▄██████  ██▓    ▄▄▄       ██▓███
░████▄    ▒▄▄▒     ▒██    ▒ ▓██▒   ▓████▄    ░██░  ██░
▒██  ▀█▄  ▒██▒     ░ ▓██▄   ▒██░   ▒██  ▀█▄  ▓██░ ▄█▓▒
░██▄▄▄▄██ ░██░       ▒  ▀██░▒██░   ░██▄▄▄▄██ ▒████▓ ▒
 ▓█   ▓██░░██░ ██   ██████▒▒░██████▒▓█   ▓██░▒██▒ ▒ ░
 ▒█   ▓█▓░░▓   █▓▒ ▒ ▒▓▒ ▒ ░░ ▒░▓  ░▒█   ▓█▓░▒██░ ░ ░
  ▒   ▒▒ ░ ▒ ░ ░▒  ░ ░▒  ░ ░░ ░ ▒  ░ ▒   ▒▒ ░░█▒░
  ░   ▒    ▒ ░ ░   ░  ░  ░    ░ ░    ░   ▒   ░▒
      ░  ░ ░    ░        ░      ░  ░     ░    ░
                ░
</pre>

---

# aiSLAP

A desktop GUI for generative image/video APIs — [fal.ai](https://fal.ai), [replicate](https://replicate.com), and ByteDance (BytePlus Ark).
Built around a **project / sequence / shot** file layout — meant for iterating on generative image & video shots as part of a larger production pipeline at speed while saving all media to disk.

It features a built in NLE to quickly assemble rough edits and a prompt linking mechanism to facilitate simple automation.

This tool was designed as an antidote to overcomplicated node graphs which in many cases end up quite linear regardless. **Complexity is not a flex**.

Built with React + Tailwind (frontend) on a Rust + Tauri (native) host. Windows is the primary target; macOS and Linux should build from source.

ENTIRELY VIBE CODED SO GOOD LUCK EVERYBODY!

![aiSLAP 0.2.6](https://github.com/user-attachments/assets/a44c39e4-2cde-4738-b379-dad411c1d9c5)

---

# Releases

Pre-built installers are available on the [Releases page](https://github.com/vsps/aiSLAP/releases). Builds track the `main` branch. Only Windows is actively tested — macOS/Linux feedback welcome.

<!-- Everything between the two markers below is machine-written by
     .github/workflows/release.yaml on `main`. Do not hand-edit it, and do not move,
     rename or reformat the markers — anything written in there is overwritten at the
     next release. The table lags behind on `dev`; the `main` copy is the accurate one. -->
<!-- release-links:start -->
> **Windows SmartScreen warning:** the installer is self-signed. Click **More info -> Run anyway** to proceed.
> **macOS:** the app is signed and notarized by Apple, so it should open normally. If you still hit a Gatekeeper prompt, right-click the .dmg and choose **Open**, or allow it in **System Settings -> Privacy & Security -> Open Anyway**.

### Windows
| | |
|---|---|
| MSI installer | [aiSLAP_0.6.7_x64_en-US.msi](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_x64_en-US.msi) |
| EXE installer | [aiSLAP_0.6.7_x64-setup.exe](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_x64-setup.exe) |

### macOS
| | |
|---|---|
| Apple Silicon (M-series) | [aiSLAP_0.6.7_aarch64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_aarch64.dmg) |
| Intel | [aiSLAP_0.6.7_x64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_x64.dmg) |

### Linux
| | |
|---|---|
| AppImage | [aiSLAP_0.6.7_amd64.AppImage](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_amd64.AppImage) |
| .deb | [aiSLAP_0.6.7_amd64.deb](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.6.7/aiSLAP_0.6.7_amd64.deb) |
<!-- release-links:end -->

---

## Key Features:

**Generating**

- choice of API providers — fal.ai, replicate, and ByteDance (BytePlus Ark)
- many models to choose from, new ones can be added via JSON — image, video, 3D, and utility (segmentation, depth)
- chain multiple prompts into a sequenced workflow, and save a whole chain as a reusable preset
- a job queue with a live per-iteration checklist
- batch a submit into several iterations at once
- split prompts into multiple sub-prompts for generating variations
- put `---` in a prompt to split off a negative prompt, on models that accept one
- parse a script file to automatically create sequence and shot folders
- LLM prompt enhancement, and prompt history per sequence and shot
- audio references for models that accept them
- BytePlus VOD AI MediaKit video enhancement (uses its own separate key)

**Reviewing and organising**

- user-defined colored tags on any media, stored in its sidecar so they follow the file through copies, moves, and renames — filter the gallery by them, or export by them
- a project-wide tag view, grouped by sequence and shot
- version stacks and a stacked view for comparing versions across a whole sequence
- compare mode in the preview column
- trace view — walk any image's reference lineage backwards through the project
- image annotation / cropping, and a point/box editor for segmentation models
- a 3D viewer for `.glb` output
- a simple NLE to edit batch sequences together, with export
- resizable, collapsible, persistent column layout, plus an in-app log window

**Under the hood**

- full metadata sidecar saved with media
- per-model cost tracking — fal.ai's official pricing API plus manual overrides (any provider, resolution-aware) rolled up per shot/sequence/project, with fal's own live cost estimate stamped onto each successful generation
- generated assets keep a stable identity (embedded id + content hash) that survives renames, moves, and copies
- local SQLite asset index, rebuildable from the sidecars at any time, with optional sync to a shared Turso (cloud SQLite) database
- orphan recovery — reconnect to in-flight generations after a crash or restart
- separate per-project settings, alongside the app-wide ones
 
![aiSLAP](https://github.com/user-attachments/assets/dd66d818-f5a0-4ad3-b5e3-4c6ad7b881c9)

---
## CURRENTLY AVAILABLE MODELS

**Image**

- Nano Banana 2
- Nano Banana Pro
- Flux
- GPT Image 2
- Seedream 4.5, 5.0 Lite, and 5.0 Pro
- Kling 3 Image

**Video**

- Veo 3 / 3.1 (txt2vid, img2vid, first + last frame)
- Seedance 2.5 (fal.ai, replicate, and direct via ByteDance/BytePlus Ark)
- Kling 3
- Happy Horse
- Depth Anything (video depth estimation)

**3D**

- Meshy v6 (image / multi-image → 3D)
- SAM 3 (3D body / objects / align)

**Utility**

- SAM 3 (image / video segmentation, masks, embeddings)
- Topaz (upscaling)

Most models are available on both fal.ai and replicate where the underlying API supports it; the registry in `models/` determines which provider serves which model.

---

## Installation

**Prerequisites**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- Windows: Microsoft C++ Build Tools + WebView2 (bundled with Windows 11)
- An API key for at least one provider: [fal.ai](https://fal.ai/dashboard/keys), [replicate](https://replicate.com/account/api-tokens), or ByteDance (BytePlus Ark)

```bash
git clone -b dev https://github.com/vsps/aiSLAP.git
cd aiSLAP
pnpm install
pnpm tauri dev          # dev mode
pnpm tauri build        # installer → src-tauri/target/release/bundle
```

> **pnpm is the supported package manager** — `pnpm-lock.yaml` is the tracked
> lockfile and what CI installs from. Get it with `npm install -g pnpm`, or
> `corepack enable` for a zero-install path.
>
> npm works, but `npm install` generates a `package-lock.json` that nothing reads
> and may resolve different versions than CI.

---

## Configure

On first launch the app creates `%APPDATA%\aiSLAP\` (Windows) or the equivalent config dir on other OSes with:

- `.env` — provider keys, all set via the **Settings** dialog (gear icon, top-right) or dropped in manually:
  - `FAL_KEY`, `REPLICATE_API_TOKEN`, `BYTEDANCE_API_KEY`
  - `TOS_ACCESS_KEY_ID` / `TOS_SECRET_ACCESS_KEY` — BytePlus TOS object storage, used to host reference images/video/audio as fetchable URLs for ByteDance generations (Ark doesn't accept inline data)
  - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — optional, enables syncing the local asset index to a shared cloud database (see below)
- `config.json` — project path, last-used sequence/shot/model, ffmpeg path, cached fal.ai prices + manual price overrides, TOS bucket/region/retention settings.
- `app-state.json` — prompts, settings, reference-image roles (restored on launch).

**ffmpeg** is required for video thumbnail extraction. Point to it in Settings if it isn't on `PATH`.

---

## Basic usage

1. Pick a **project directory** (top bar). This is any folder — aiSLAP creates `sequence/shot/{SRC,v001,…}` subdirectories as you go.
2. Create or pick a **sequence**, then a **shot**.
3. Choose a **model** from the left column. Its parameters appear below.
4. Type a **SEQUENCE** and/or **SHOT** prompt. The sequence prompt is prepended to every shot in that sequence.
5. (Optional) Add **reference images** — click the add button or drag files from your OS onto the panel. Each thumbnail is numbered by its position in its row (`1: shot_a.jpg`); that number is the index the model sees, so it's what a prompt token like Seedance's `@image1` refers to. Drag the bottom bar to reorder. Click a thumbnail's top bar to assign a role instead:
   - `start` / `end` — exclusive slots for img2vid / first-last-frame models.
   - `@ElementN` — Kling-style named references. First image in a group is the frontal by default (★); toggle the checkbox to promote another.
   - `@ImageN` — pins a reference to a specific slot in the model's image array (Seedance ref2vid, Happy Horse vid2vid) so `@image1` stays put regardless of drag order. Untagged references follow the pinned ones.
6. Click **Generate**. The result lands in a new `vNNN/` column in the gallery and is saved with a sidecar containing the prompt, settings, and reference URLs used.

---

## PRISM projects

Point the project picker at a [PRISM](https://prism-pipeline.com/) project — the folder
holding `00_Pipeline/pipeline.json` — and aiSLAP reads the pipeline's own layout instead of
its native one:

- A **SHOT / ASSET** toggle appears next to the project path, choosing which tree the
  SEQUENCE dropdown lists: `03_Production/Shots/<SEQ>/<SHOT>` or
  `03_Production/Assets/<CATEGORY>/<ASSET>`.
- Generations and references go to **`<SHOT>/Renders/2dRender/AI/`** — version folders (`v0001`,
  `v0002`, … padded to the pipeline's `versionPadding`) and a `SRC/` for that shot's refs.
  The folder is created the first time you open a shot.
- Sequences and shots are **created in PRISM**, not here; those buttons are greyed out.
  aiSLAP only ever writes inside `Renders/2dRender/AI`.
- aiSLAP's own `project.json` (tag vocabulary), `script.md` and GLOBAL `SRC/` live at the
  project root, alongside the pipeline folders.

Everything else — the gallery, tags, timeline, chains, cost rollups — behaves exactly as in a
native project.

---

## Tags and the tag view

Any media can carry user-defined coloured tags. They're stored **in the file's own
metadata sidecar**, so they travel with it through copies, moves and renames — there's
no separate list to get out of sync, and no file ever gets moved just to mark it.

- The chip row above the gallery filters the current shot by tag, in ANY or ALL mode.
- The **tag view** shows every tagged item across the whole project, grouped by
  sequence and shot — quick cross-referencing of images between sequences and shots.
- Tags also drive **export**: pull every "hero" shot out of a project in one go,
  either flattened or with the folder structure preserved.
- The tag vocabulary and its colours are managed per project, in Project Settings.

Upgrading a project made before tags existed converts it once, automatically: anything
starred becomes `fav`, anything sitting in a `SEL/` folder becomes `select`. The files
themselves stay exactly where they are.

---

## Prompt enhancement

All text inputs can now be enhanced through an LLM of your choice. Click the sparkles to see the enhancement options. (Routed through fal.ai's OpenRouter proxy — needs a `FAL_KEY` set even if fal isn't your generation provider.)

---

## Local index & optional cloud sync

The `.json` sidecar next to each generated file is always the source of truth — nothing here changes that, and the app works fully offline with just the file system.

Alongside it, aiSLAP keeps a local **SQLite (libSQL) index** per project at `%APPDATA%\aiSLAP\db\<project-id>.db`, aggregating each asset's path, content hash, provider/model/prompt/settings, cost, and reference chain for fast lookups (cost rollups, cross-shot querying) without re-reading every sidecar on disk. It's entirely derived and disposable — delete it and it rebuilds from the sidecars.

A **reconcile pass** runs automatically in the background whenever a project is opened: it assigns a stable id + content hash to any pre-existing file that doesn't have one yet, and relinks index rows for anything moved or renamed outside the app (e.g. in Explorer) since the last scan. Copying, moving, or renaming a file from within aiSLAP updates the index immediately instead of waiting for the next reconcile.

Setting `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` in Settings (optional) additionally syncs that local index to a shared [Turso](https://turso.tech) (cloud libSQL) database via an outbox queue, flushed after every asset write and once per project open. This is purely additive — useful for a team sharing a project across machines/a shared drive who want one searchable index; leaving it unset keeps everything local-only and nothing breaks.

---

## Documentation

- **[docs/guides/](docs/guides/)** — walkthroughs: your first generation, img2img,
  img2video.
- **[docs/](docs/README.md)** — how it all works, for contributors.

---

## Architecture (for contributors)

React 19 + Tailwind 4 frontend on a Rust + Tauri v2 host, with typed IPC through a
single module (`src/lib/tauri.ts`). Models are declared as JSON in `models/` — no code
needed to add one. The `.json` sidecar next to each file on disk is the source of
truth; the SQLite index alongside it is derived and rebuildable.

Full documentation: **[docs/](docs/README.md)** —
[architecture](docs/architecture.md) ·
[generation pipeline](docs/generation-pipeline.md) ·
[model registry](docs/model-registry.md) ·
[providers](docs/providers.md) ·
[storage](docs/storage.md) ·
[PRISM](docs/prism.md) ·
[tags](docs/tags.md)

Checks: `pnpm build` (tsc + vite), and `cargo fmt --check` / `cargo clippy` /
`cargo test` in `src-tauri/`. CI runs all of them on every PR.

API keys live in `%APPDATA%\aiSLAP\.env` (not the repo root) — see `.env.example`.

---

## License

AGPL v3.0
