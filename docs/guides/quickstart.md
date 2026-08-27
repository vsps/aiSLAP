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

You need a key for at least one provider. This walkthrough uses fal.ai:

- Get a key at https://fal.ai/dashboard/keys
- Launch the app → gear icon (top-right) → paste key → save.

Stored at `%APPDATA%\aiSLAP\.env` as `FAL_KEY=...`.

> The same walkthrough works on **replicate** or **ByteDance** — many of the same
> models are served by more than one provider, and the tabs at the top of the model
> picker are where you choose. See
> [providers.md](../providers.md) for which key unlocks what.
>
> One thing worth knowing: `FAL_KEY` also powers **LLM prompt enhancement**, so it's
> useful even if fal isn't your generation provider.

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

Hit **Generate**. Output lands in a new version column in the gallery, with a sidecar
beside it holding the prompt and settings.

The version folder is `v001/` in a normal project. In a **PRISM** project it's
`<shot>/Renders/2dRender/AI/v0001/` instead — PRISM's own version padding, under
`AI` as a render product in the entity's 2D render tree. See
[prism.md](../prism.md).

## Troubleshooting

- **The model picker is empty, or the status bar says `models: 0`.** The model
  registry failed to load. A malformed model file is skipped silently — check the
  count in the status bar and see [model-registry.md](../model-registry.md) §10.
- **Videos generate but have no thumbnail.** ffmpeg isn't configured; set its path in
  Settings.

---

Next:
- [img2img →](quickstart-img2img.md)
- [img2video →](quickstart-img2video.md)

*Last reviewed against v0.3.9.*
