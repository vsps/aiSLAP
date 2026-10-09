# ByteDance asset library: a consistent character in Seedance

Seedance 2.0 and 2.5 accept characters registered in your BytePlus account's private
asset library. A registered image is sent as a library id rather than as a plain
reference, which keeps a virtual character consistent across shots.

## Before you start

- Your BytePlus account has **Advanced Creation Rights** (asset library access).
- Settings → APIs has the **TOS Access Key ID / Secret Access Key** filled in. The
  library uses the same IAM keys, so that IAM user needs Ark asset permissions as well
  as TOS.
## 1. Register a character

Library slots are limited, so registering is a deliberate step. Nothing is uploaded to
the library automatically.

1. Pick **ByteDance › Utility › Asset Library → Upload Character Ref** in the model
   picker.
2. Add the character's images as refs, up to 30. Leave them untagged; they all count
   as sources. Check each one first:
   - each side 300–6000 px
   - aspect ratio between 0.4 and 2.5
   - under 30 MB
3. Type the character's name in the prompt box, e.g. `eva_digital_character`. That
   becomes the **group** in the BytePlus console, and it's created if it doesn't exist.
   The images become `eva_digital_character_01`, `_02`, and so on. Running it again
   with the same name adds more images to the same group.
4. Generate. The job registers every image and waits until BytePlus marks them Active.
   That usually takes seconds, but on the Entry tier only 3 uploads per minute are
   allowed, so a big batch takes a few minutes. The log shows when it's waiting on the
   rate limit.

You get one copy of each image in the version folder, each with a **badge icon in its
top-right corner**. Hover a tile to see its library id (`asset-…`). If BytePlus rejects
an image, the log says why and the rest still go through.

## 2. Use it in Seedance

1. Switch to a Seedance **ref2vid** (or img2vid) model.
2. Add the badged image as a reference, the same way as any other ref. Dragging it
   into SRC keeps the badge.
3. Refer to it by position in the prompt (`@Image1`), never by id.
4. Generate. The log shows `Using library asset asset-… for <file>`. That ref is sent
   as `asset://<id>` and the file is not uploaded.

Seedream ignores the badge: it doesn't accept library ids, so the image is uploaded
normally.

## Good to know

- **Cancelling doesn't un-register.** Once the upload has started, the asset exists.
  Delete unwanted assets in the BytePlus console.
- Only images, and only virtual (AIGC) characters. Real-person portraits need
  BytePlus's own liveness verification, which aiSLAP doesn't do.
