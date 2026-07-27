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

<!-- release-links:start -->
> **Windows SmartScreen warning:** the installer is self-signed. Click **More info -> Run anyway** to proceed.
> **macOS:** the app is signed and notarized by Apple, so it should open normally. If you still hit a Gatekeeper prompt, right-click the .dmg and choose **Open**, or allow it in **System Settings -> Privacy & Security -> Open Anyway**.

### Windows
| | |
|---|---|
| MSI installer | [aiSLAP_0.3.4_x64_en-US.msi](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_x64_en-US.msi) |
| EXE installer | [aiSLAP_0.3.4_x64-setup.exe](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_x64-setup.exe) |

### macOS
| | |
|---|---|
| Apple Silicon (M-series) | [aiSLAP_0.3.4_aarch64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_aarch64.dmg) |
| Intel | [aiSLAP_0.3.4_x64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_x64.dmg) |

### Linux
| | |
|---|---|
| AppImage | [aiSLAP_0.3.4_amd64.AppImage](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_amd64.AppImage) |
| .deb | [aiSLAP_0.3.4_amd64.deb](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.3.4/aiSLAP_0.3.4_amd64.deb) |
<!-- release-links:end -->

---

## Key Features:

- choice of API providers — fal.ai, replicate, and ByteDance (BytePlus Ark)
- maany models to choose from, new ones can be added via JSON — image, video, 3D, and utility (segmentation, depth)
- chain multiple prompts into a sequenced workflow
- parse a srcipt file to automatically create sequence and shot folders
- split prompts into multiple sub-prompts for generating variantions
- a simple NLE to edit bash sequences together
- image annotation / cropping
- LLM prompt enhancement
- prompt history
- full metadata sidecar saved with media
- per-model cost tracking — fal.ai's official pricing API plus manual overrides (any provider, resolution-aware) rolled up per shot/sequence/project, with fal's own live cost estimate stamped onto each successful generation
- generated assets keep a stable identity (embedded id + content hash) that survives renames, moves, and copies
- local SQLite asset index, rebuildable from the sidecars at any time, with optional sync to a shared Turso (cloud SQLite) database
- orphan recovery — reconnect to in-flight generations after a crash or restart
 
![aiSLAP](https://github.com/user-attachments/assets/dd66d818-f5a0-4ad3-b5e3-4c6ad7b881c9)

---
## CURRENTLY AVAILABLE MODELS

**Image**

- Nano Banana 2
- Nano Banana Pro
- Flux
- GPT Image 2
- Seedream 4.5 and 5.0 Lite
- Kling 3 Image

**Video**

- Veo 3
- Seedance 2 (fal.ai, replicate, and direct via ByteDance/BytePlus Ark)
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
npm install
npm run tauri dev       # dev mode
npm run tauri build     # installer → src-tauri/target/release/bundle
```

> Prefer pnpm? `npm install -g pnpm` then use `pnpm` in place of `npm run`.

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
5. (Optional) Add **reference images** — click the add button or drag files from your OS onto the panel. Click a thumbnail's top bar to assign a role:
   - `start` / `end` — exclusive slots for img2vid / first-last-frame models.
   - `@ElementN` — Kling-style named references. First image in a group is the frontal by default (★); toggle the checkbox to promote another.
6. Click **Generate**. The result lands in a new `vNNN/` column in the gallery and is saved with a sidecar containing the prompt, settings, and reference URLs used.

---

## An updated Library view

While all new reference images added from disk get saved to the GLOBAL SRC folder any generation can be promoted to be visible (eye icon).
Clicking the big eye button to the right of the thumbnails brings up all the promoted images in the entire project. This allows for quick cross referencing of images across sequences and shots.

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

## Architecture (for contributors)

```
src/                        React + Tailwind frontend
  components/               UI (Gallery, PromptColumn, Timeline, SettingsDialog, modals, …)
  stores/                   zustand stores (session, generation, models, prices, timeline, script, …)
  lib/
    providers/              provider abstraction — fal.ts, replicate.ts, bytedance.ts,
                            tos.ts (BytePlus object storage for ByteDance refs)
    generation/             job pipeline: prompts → enqueue → runner → output
    falPrices.ts            fal.ai price scraping + per-resolution extraction, cost math
    recovery.ts             orphan recovery for crashed/interrupted submissions
    tauri.ts                typed IPC wrappers for every Rust command
src-tauri/src/              Rust host (Tauri v2)
  fsjson.rs                 lenient JSON read / atomic write helpers
  pricing.rs                fal price-string parsing, mirrors falPrices.ts
  db/                       local SQLite (libSQL) asset index + Turso outbox sync
  commands/
    session.rs              project/sequence/shot CRUD, rename cascade, prompt history
    gallery.rs               column / stacked / starred scanning
    image.rs                 media triple copy/move/rename, version stack moves
    rename.rs                sequence/shot rename cascade helpers
    timeline.rs              latest-media scan + timeline sidecar
    visible.rs               starred ("visible") set persistence
    cost.rs                  project-wide cost rollup, backfills costUsd into sidecars
    fsutil.rs                shared path/naming helpers (+ unit tests)
    config.rs / models.rs / metadata.rs / download.rs / media.rs / pending.rs / prompt_history.rs
models/<provider>/*.json    model definitions, one family per file — add new models here
```

Checks: `npm run build` (tsc + vite), `cargo check` / `cargo test` in `src-tauri/`.

API keys live in `%APPDATA%\aiSLAP\.env` (not the repo root) — see `.env.example`.

---

## License

AGPL v3.0
I
