// High-level action helpers that span stores + Tauri commands.

import { cmd } from "./tauri";
import { basename } from "./paths";
import { confirmAction, showMessage } from "./dialog";
import { makeChainLink, useGenerationStore } from "../stores/generationStore";
import { useModelsStore } from "../stores/modelsStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import type {
  ChainLink,
  ImageMetadata,
  RefImage,
  RefSnapshot,
  RoleAssignment,
} from "./types";

type FsExistsLike = (path: string) => Promise<boolean>;

async function pathExists(path: string): Promise<boolean> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch {
    return true;
  }
}

function normalizeRefs(raw: (RefSnapshot | string)[] | undefined): RefImage[] {
  if (!raw) return [];
  return raw.map((r) =>
    typeof r === "string"
      ? { path: r, roleAssignment: null }
      : { path: r.path, roleAssignment: r.roleAssignment ?? null },
  );
}

/** Apply a sidecar metadata record to the current editor state. */
export async function copySettingsFromMetadata(meta: ImageMetadata): Promise<{
  restoredRefs: number;
  skippedRefs: number;
}> {
  const models = useModelsStore.getState();
  const gen = useGenerationStore.getState();

  const node = models.findById(meta.modelId);
  if (node) gen.selectModel(node);

  // Restore prompts (back-compat: old sidecars only had `prompt`).
  // Metadata stores the combined shot prompt as one string; recall lands it
  // in a single box (the multi-box split is not preserved in metadata).
  gen.setSequencePrompt(meta.sequencePrompt ?? "");
  if (meta.shotPrompts && meta.shotPrompts.length > 0) {
    gen.setShotPrompts(meta.shotPrompts);
  } else {
    gen.setShotPrompts([meta.shotPrompt ?? meta.prompt ?? ""]);
  }

  // Settings
  const settings = meta.settings || {};
  for (const [k, v] of Object.entries(settings)) gen.setSetting(k, v);

  // Refs — drop any that no longer exist on disk.
  const refs = normalizeRefs(meta.refs);
  const valid: RefImage[] = [];
  let skipped = 0;
  for (const r of refs) {
    if (await pathExists(r.path)) valid.push(r);
    else skipped++;
  }
  gen.setRefImages(valid);
  console.debug("[reuse] refs", {
    total: refs.length,
    restored: valid.length,
    skipped,
  });

  if (typeof meta.iterationTotal === "number" && meta.iterationTotal > 0) {
    gen.setIterations(meta.iterationTotal);
  }

  return { restoredRefs: valid.length, skippedRefs: skipped };
}

/** Restore a full prompt chain into the work surface from a sidecar's
 *  chain block. Missing models in the registry are kept as null on the link
 *  (the preflight will flag them; the user can pick a replacement). */
export async function restoreChainFromMetadata(
  meta: ImageMetadata,
): Promise<{ missingModels: number; skippedRefs: number }> {
  if (!meta.chain) return { missingModels: 0, skippedRefs: 0 };
  const models = useModelsStore.getState();
  let missingModels = 0;
  let skippedRefs = 0;
  const restored: ChainLink[] = [];
  for (const p of meta.chain.links) {
    const model = p.modelId ? (models.findById(p.modelId) ?? null) : null;
    if (p.modelId && !model) missingModels++;
    const refs: RefImage[] = [];
    for (const r of p.refImages ?? []) {
      if (await pathExists(r.path)) refs.push(r);
      else skippedRefs++;
    }
    restored.push(
      makeChainLink({
        id: p.id,
        active: !!p.active,
        model,
        settings: p.settings ?? {},
        sequencePrompt: p.sequencePrompt ?? "",
        shotPrompts:
          Array.isArray(p.shotPrompts) && p.shotPrompts.length > 0
            ? p.shotPrompts
            : [""],
        refImages: refs,
        consumesPrev: !!p.consumesPrev,
      }),
    );
  }
  useGenerationStore.getState().setChain(restored, null);
  return { missingModels, skippedRefs };
}

/** Apply only the prompt fields from a sidecar (shot prompt gets the value). */
export function copyPromptFromMetadata(meta: ImageMetadata): void {
  const gen = useGenerationStore.getState();
  if (meta.shotPrompts && meta.shotPrompts.length > 0) {
    gen.setShotPrompts(meta.shotPrompts);
  } else {
    gen.setShotPrompts([meta.shotPrompt ?? meta.prompt ?? ""]);
  }
}

/** Compute ancestor set for a trace: {image} ∪ {all ancestors via sidecar.refs}. */
export async function computeTraceSet(imagePath: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue: string[] = [imagePath];
  while (queue.length) {
    const p = queue.shift()!;
    if (visited.has(p)) continue;
    visited.add(p);
    const meta = (await cmd
      .image_metadata_read(p)
      .catch(() => null)) as ImageMetadata | null;
    if (!meta) continue;
    for (const r of normalizeRefs(meta.refs)) {
      if (!visited.has(r.path)) queue.push(r.path);
    }
  }
  return visited;
}

/** Add a gallery image to the current refs. Images already inside the current
 *  project tree are referenced by path. External imports are copied into
 *  GLOBAL SRC at the project root. */
export async function replaceImageRef(imagePath: string): Promise<void> {
  const gen = useGenerationStore.getState();
  gen.removeAllRefs();
  gen.setShotPrompts([""]);
  await addImageToRefs(imagePath);
}

export async function addImageToRefs(imagePath: string): Promise<string> {
  const { shotPath, projectPath } = useSessionStore.getState();
  if (!shotPath) throw new Error("no shot open");
  const normalizedImg = imagePath.replaceAll("\\", "/");
  const normalizedProject = (projectPath ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const insideProject = normalizedProject && normalizedImg.startsWith(normalizedProject + "/");
  let finalPath = imagePath;
  if (!insideProject) {
    finalPath = await cmd.ref_copy_to_global_src(shotPath, imagePath);
  }
  useGenerationStore.getState().addRefs([finalPath]);
  return finalPath;
}

export function roleAssignmentLabel(a: RoleAssignment | null): string {
  if (!a) return "";
  if (a.kind === "element") return `@${a.groupName}${a.frontal ? " ★" : ""}`;
  return a.kind;
}

// ---------- Unified image action dispatcher ----------

export type ImageAction =
  | "zoom"
  | "select"
  | "add_to_refs"
  | "replace_ref"
  | "copy_path"
  | "copy_image"
  | "copy_settings"
  | "copy_prompt"
  | "copy_to_global_src"
  | "set_clip_media"
  | "trace"
  | "refresh"
  | "open_location"
  | "delete"
  | "rename"
  | "edit"
  | "crop"
  | "toggle_star"
  | "restore_chain";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "avi"]);

// Transcode an on-disk image to PNG bytes and push to the system clipboard.
// Canvas handles jpeg/webp/etc. so the clipboard receives something every OS
// paste target can accept. Videos aren't supported (no "image" to copy).
async function copyImageToClipboard(path: string): Promise<void> {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (VIDEO_EXTS.has(ext)) {
    await showMessage("Copy image not supported for video files", {
      kind: "warning",
    });
    return;
  }
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
    const bytes = await readFile(path);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.src = blobUrl;
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("image load failed"));
    });
    URL.revokeObjectURL(blobUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(img, 0, 0);
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
        "image/png",
      ),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch (e) {
    await showMessage(`Copy image failed: ${e}`, { kind: "error" });
  }
}

/** Single entry point for any image op invoked from thumbs, preview, or zoom. */
export async function performImageAction(
  action: ImageAction,
  path: string,
): Promise<void> {
  const session = useSessionStore.getState();
  switch (action) {
    case "select":
      session.setSelectedImage(path);
      return;
    case "zoom":
      session.setSelectedImage(path);
      session.setZoomImage(path);
      return;
    case "copy_path":
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        /* ignore */
      }
      return;
    case "copy_image":
      await copyImageToClipboard(path);
      return;
    case "add_to_refs":
      try {
        await addImageToRefs(path);
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    case "replace_ref":
      try {
        await replaceImageRef(path);
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    case "copy_to_global_src": {
      const { shotPath } = session;
      if (!shotPath) {
        await showMessage("No shot open", { kind: "warning" });
        return;
      }
      try {
        await cmd.ref_copy_to_global_src(shotPath, path);
        await session.rescanShot();
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
    case "set_clip_media": {
      const { shotPath } = session;
      if (!shotPath) {
        await showMessage("No shot open", { kind: "warning" });
        return;
      }
      try {
        const tl = useTimelineStore.getState();
        const current = tl.shotsLatestMedia.get(shotPath)?.clipMediaPath ?? null;
        await tl.setShotClipMedia(shotPath, current === path ? null : path);
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
    case "copy_settings": {
      const meta = (await cmd
        .image_metadata_read(path)
        .catch(() => null)) as ImageMetadata | null;
      if (!meta) {
        await showMessage("No metadata for this image", { kind: "warning" });
        return;
      }
      const ok = await confirmAction(
        `Reuse prompt and settings from ${basename(path)}? This overwrites the current model, prompts, settings, and refs.`,
        { title: "Reuse prompt", kind: "warning" },
      );
      if (!ok) return;
      const { restoredRefs, skippedRefs } = await copySettingsFromMetadata(meta);
      if (restoredRefs > 0 || skippedRefs > 0) {
        const skip = skippedRefs ? `, ${skippedRefs} skipped (files missing)` : "";
        await showMessage(`Reused. Restored ${restoredRefs} ref(s)${skip}.`, {
          kind: "info",
        });
      }
      return;
    }
    case "restore_chain": {
      const meta = (await cmd
        .image_metadata_read(path)
        .catch(() => null)) as ImageMetadata | null;
      if (!meta?.chain) {
        await showMessage("No chain metadata for this image", { kind: "warning" });
        return;
      }
      const ok = await confirmAction(
        `Restore the ${meta.chain.linkCount}-link chain that produced ${basename(path)}? This overwrites the current chain.`,
        { title: "Restore chain", kind: "warning" },
      );
      if (!ok) return;
      const { missingModels, skippedRefs } =
        await restoreChainFromMetadata(meta);
      const parts: string[] = [];
      if (missingModels)
        parts.push(`${missingModels} model(s) no longer in registry`);
      if (skippedRefs) parts.push(`${skippedRefs} ref(s) skipped (missing files)`);
      if (parts.length > 0) {
        await showMessage(`Chain restored. ${parts.join(" · ")}.`, {
          kind: "info",
        });
      }
      return;
    }
    case "copy_prompt": {
      const meta = (await cmd
        .image_metadata_read(path)
        .catch(() => null)) as ImageMetadata | null;
      if (!meta) {
        await showMessage("No metadata for this image", { kind: "warning" });
        return;
      }
      const prompt =
        meta.shotPrompt ?? meta.prompt ?? meta.combinedPrompt ?? "";
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        /* silent fallback */
      }
      return;
    }
    case "rename":
      session.setRenameImage(path);
      return;
    case "edit":
      session.setSelectedImage(path);
      session.setZoomInitialMode("draw");
      session.setZoomImage(path);
      return;
    case "crop":
      session.setSelectedImage(path);
      session.setZoomInitialMode("crop");
      session.setZoomImage(path);
      return;
    case "refresh":
      try {
        await session.rescanShot();
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    case "open_location":
      try {
        await cmd.reveal_in_explorer(path);
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    case "trace": {
      const t = session.traceActive;
      if (t?.imagePath === path) {
        session.setTrace(null);
        return;
      }
      const set = await computeTraceSet(path);
      session.setTrace({ imagePath: path, traceSet: set });
      return;
    }
    case "toggle_star": {
      try {
        const img = session.columns
          .flatMap((c) => c.images)
          .find((i) => i.path === path);
        const currentlyVisible = img?.starred ?? false;
        await cmd.image_set_visible(path, !currentlyVisible);
        await session.rescanShot();
        if (
          session.viewMode === "starred" &&
          useSessionStore.getState().projectPath
        ) {
          await useSessionStore.getState().rescanStarred();
        }
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
    case "delete": {
      const img = session.columns
        .flatMap((c) => c.images)
        .find((i) => i.path === path);
      const ok = await confirmAction(
        `Delete ${img?.filename ?? basename(path)}?`,
        {
          title: "Delete image",
          kind: "warning",
        },
      );
      if (!ok) return;
      try {
        await cmd.image_delete(path);
        await session.rescanShot();
        if (useSessionStore.getState().zoomImagePath === path) {
          useSessionStore.getState().setZoomImage(null);
        }
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
  }
}

export { basename, type FsExistsLike };
