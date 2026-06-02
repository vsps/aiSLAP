# Quickstart — txt2img

First generation with **Nano Banana Pro**.

## 1. Install

Prereqs: [Rust](https://rustup.rs/), [pnpm](https://pnpm.io/) 8+, Node 20+. Windows also needs MSVC Build Tools + WebView2.

```bash
git clone -b dev https://github.com/vsps/aiSLAP.git
cd aiSLAP
pnpm install
pnpm tauri dev
```

Or grab the Windows installer: https://github.com/vsps/aiSLAP/releases

## 2. Set your API key

- Get a key at https://fal.ai/dashboard/keys
- Launch the app → gear icon (top-right) → paste key → save.

Stored at `%APPDATA%\aiSLAP\.env` as `FAL_KEY=...`.

## 3. Pick a project

Top bar → choose a project directory. Any empty or existing folder works — aiSLAP writes `sequence/shot/...` underneath.

## 4. Sequence → shot

- Sequence column → **+** → name it (e.g. `intro`).
- Shot column → **+** → name it (e.g. `010`).

## 5. Choose model

Left column → **Nano Banana Pro** (txt2img). Parameters appear below.

## 6. Prompts

- **SEQUENCE prompt** — shared style/context prepended to every shot in this sequence. E.g. `moody neon-lit alleyway, 35mm film grain`.
- **SHOT prompt** — what this specific frame shows. E.g. `a wet payphone, close-up, rain streaks on glass`.

## 7. Submit

Hit **Generate**. Output lands in a new `v001/` column in the gallery with a sidecar holding prompt + settings.

---

Next:
- [img2img →](quickstart-img2img.md)
- [img2video →](quickstart-img2video.md)
