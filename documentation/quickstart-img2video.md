# Quickstart — img2video

Animate a previous generation with **Veo 3.1**.

Assumes you've done [quickstart.md](quickstart.md) and have at least one generated image in the gallery.

## 1. Choose model

Left column → **Veo 3.1**.

## 2. Pull a ref image from the gallery

- Find the previously generated image in its `vNNN/` column.
- **Drag** the thumbnail onto the **REF_IMAGES** panel (or use the gallery's "send to ref" action).

No need to re-import from disk — it's already in the project.

## 3. Set the role

Click the thumbnail's top bar → choose **start** (first-frame for the video).

For first-last-frame workflows, drag a second image and set it to **end**.

## 4. SHOT prompt

Describe the motion, not the scene — the ref image already provides the look.

E.g. `slow dolly-in, rain intensifies, neon sign flickers`.

## 5. Submit

**Generate**. Veo runs server-side; result lands in `vNNN/` as an mp4 with a sidecar.

ffmpeg must be reachable (PATH or set in Settings) for thumbnail extraction.

---

Back to [quickstart →](quickstart.md) · [img2img →](quickstart-img2img.md)
