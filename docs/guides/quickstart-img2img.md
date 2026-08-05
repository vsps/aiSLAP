# Quickstart — img2img

Reference image from disk + multi-block shot prompt.

Assumes you've done [quickstart.md](quickstart.md) (key set, project/sequence/shot picked).

## 1. Choose model

Left column → an img2img-capable model (e.g. **Nano Banana Pro** img2img mode, or **Flux** with a ref image).

## 2. Split the SHOT prompt into blocks

The shot prompt supports multiple blocks — easier to edit and reorder than one long string.

- Click **+** on the SHOT prompt to add a block.
- Each block becomes one part of the final concatenated prompt.

Example split:
- Block 1 — `same alleyway as ref, dawn light`
- Block 2 — `figure in yellow raincoat walking away`
- Block 3 — `shallow depth of field, 50mm`

## 3. Add a reference image

Three ways:
- **Drag** a file from Explorer/Finder onto the **REF_IMAGES** panel.
- **Drag a thumbnail straight from the gallery** — the usual way to iterate on your
  own output.
- Or click the **+** on the panel and pick a file.

A file from outside is copied into the project's `SRC` folder.

## 4. (Optional) Assign a role

Click the thumbnail's top bar to set a role. For plain img2img the default `source`
role is fine.

The full set is `source`, `start`, `end`, `mesh`, `element`, `image` and `chain_prev`,
though which ones a model accepts depends on the model. Refs are also **numbered by
position**, which is what lets you pin one from the prompt — `@Image2` for the second
image, or `@ElementN` for a named element group. A model doesn't have to name all of
its inputs; anything unclaimed is placed by media type.

## 5. Negative prompts

Models that accept a negative prompt have no separate box for one. Instead, put `---`
in the prompt: everything before it is the prompt, everything after is the negative.

```
a wet payphone, close-up, rain streaks on glass
---
blurry, text, watermark
```

If the model doesn't declare a negative prompt, the whole thing stays the prompt.

## 6. Submit

**Generate**. Output goes to the next version column.

---

Back to [quickstart →](quickstart.md) · Next: [img2video →](quickstart-img2video.md)

*Last reviewed against v0.3.9.*
