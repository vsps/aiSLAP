# Quickstart — img2video

Animate a previous generation with **Veo 3.1**.

Assumes you've done [quickstart.md](quickstart.md) and have at least one generated image in the gallery.

## 1. Choose model

Left column → the **Veo3** family → the **Veo3.1 (img2vid)** node.

The family ships several nodes — Veo3 txt2vid, Veo3 img2vid, Veo3.1 img2vid, and a
Veo3.1 first + last frame mode. Pick the one matching the refs you intend to give it.

## 2. Pull a ref image from the gallery

- Find the previously generated image in its `vNNN/` column.
- **Drag** the thumbnail onto the **REF_IMAGES** panel (or use the gallery's "send to ref" action).

No need to re-import from disk — it's already in the project.

## 3. Set the role

Click the thumbnail's top bar → choose **start** (first frame of the video).

For first-last-frame workflows, drag a second image and set it to **end**, and switch
to the first + last frame node.

`start` and `end` are *exclusive* roles — only one ref can hold each, so assigning a
new one takes the role off whichever ref had it.

## 4. SHOT prompt

Describe the motion, not the scene — the ref image already provides the look.

E.g. `slow dolly-in, rain intensifies, neon sign flickers`.

## 5. Submit

**Generate**. Veo runs server-side; the result lands in the next version column as an
mp4 with a sidecar.

ffmpeg must be reachable (on PATH, or set in Settings) for thumbnail extraction — the
`.thumb.jpg` beside the video is what the gallery and the timeline display. (Clips
generated before the JPEG switch have a `.thumb.png` instead; both still show.)

---

Back to [quickstart →](quickstart.md) · [img2img →](quickstart-img2img.md)

*Last reviewed against v0.3.9.*
