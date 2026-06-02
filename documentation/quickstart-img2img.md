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

## 3. Add a reference image from disk

Two ways:
- **Drag** a file from Explorer/Finder onto the **REF_IMAGES** panel.
- Or click the **+** on the panel and pick a file.

The image is copied into the project's `SRC` folder.

## 4. (Optional) Assign a role

Click the thumbnail's top bar to set a role. For plain img2img the default `source` role is fine.

## 5. Submit

**Generate**. Output → next `vNNN/` column.

---

Back to [quickstart →](quickstart.md) · Next: [img2video →](quickstart-img2video.md)
