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

A desktop GUI for [fal.ai](https://fal.ai) and now [replicate](https://replicate.com).
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
### [LATEST BUILDS](https://github.com/vsps/aiSLAP/releases) — v0.2.11

> **Windows SmartScreen warning:** the installer is self-signed. Click **More info -> Run anyway** to proceed.
> **macOS Gatekeeper:** right-click the .dmg and choose **Open**, or allow it in **System Settings -> Privacy & Security -> Open Anyway**.

### Windows
| | |
|---|---|
| MSI installer | [aiSLAP_0.2.11_x64_en-US.msi](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_x64_en-US.msi) |
| EXE installer | [aiSLAP_0.2.11_x64-setup.exe](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_x64-setup.exe) |

### macOS
| | |
|---|---|
| Apple Silicon (M-series) | [aiSLAP_0.2.11_aarch64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_aarch64.dmg) |
| Intel | [aiSLAP_0.2.11_x64.dmg](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_x64.dmg) |

### Linux
| | |
|---|---|
| AppImage | [aiSLAP_0.2.11_amd64.AppImage](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_amd64.AppImage) |
| .deb | [aiSLAP_0.2.11_amd64.deb](https://github.com/vsps/aiSLAP/releases/download/aiSLAP-v0.2.11/aiSLAP_0.2.11_amd64.deb) |
<!-- release-links:end -->

---

## Key Features:

- choice of API providers
- maany models to choose from, new ones can be added via JSON
- chain multiple prompts into a sequenced workflow
- parse a srcipt file to automatically create sequence and shot folders
- split prompts into multiple sub-prompts for generating variantions
- a simple NLE to edit bash sequences together
- image annotation / cropping
- LLM prompt enhancement
- prompt history
- full metadata sidecar saved with media.
 
![aiSLAP](https://github.com/user-attachments/assets/dd66d818-f5a0-4ad3-b5e3-4c6ad7b881c9)

---
## CURRENTLY AVAILABLE MODELS

**Image**

- Nano Banana 2
- Nano Banana Pro
- Flux
- GPT Image 2.0
- Seedream 4.5 and 5.0

**Video**

- Veo 3.1
- Seedance 2.0
- Kling 3
- Happy Horse
- Topaz

---

## Installation

**Prerequisites**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- Windows: Microsoft C++ Build Tools + WebView2 (bundled with Windows 11)
- A [fal.ai API key](https://fal.ai/dashboard/keys)

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

- `.env` — holds `FAL_KEY=...` and `REPLICATE_API_TOKEN=...`. Set them via the **Settings** dialog (gear icon, top-right) or drop them in manually.
- `config.json` — project path, last-used sequence/shot/model, ffmpeg path.
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

All text inputs can now be enhanced through an LLM of your choice. Click the sparkles to see the enhancement options.

---

## Architecture (for contributors)

```
src/                      React + Tailwind frontend
  components/             UI (Gallery, PromptColumn, Timeline, modals, …)
  stores/                 zustand stores (session, generation, timeline, script, …)
  lib/                    non-UI logic
    generation/           job pipeline: prompts → enqueue → runner → output
    tauri.ts              typed IPC wrappers for every Rust command
src-tauri/src/            Rust host (Tauri v2)
  fsjson.rs               lenient JSON read / atomic write helpers
  commands/
    session.rs            project/sequence/shot CRUD, rename cascade, prompt history
    gallery.rs            column / stacked / starred scanning
    image.rs              media triple copy/move/rename, version stack moves
    timeline.rs           latest-media scan + timeline sidecar
    visible.rs            starred ("visible") set persistence
    fsutil.rs             shared path/naming helpers (+ unit tests)
    config.rs / models.rs / metadata.rs / download.rs / media.rs / pending.rs
models/                   model definitions (JSON) — add new models here
```

Checks: `npm run build` (tsc + vite), `cargo check` / `cargo test` in `src-tauri/`.

API keys live in `%APPDATA%\aiSLAP\.env` (not the repo root) — see `.env.example`.

---

## License

AGPL v3.0
I
