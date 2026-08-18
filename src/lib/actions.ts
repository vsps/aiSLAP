// High-level action helpers that span stores + Tauri commands.

import { cmd } from "./tauri";
import { basename, isChildOf, joinPath } from "./paths";
import { confirmAction, showMessage } from "./dialog";
import { classifyMedia, guessContentType } from "./media";
import { swallow } from "./errors";
import { inFlightJobs } from "./jobs";
import { rewriteScriptHeading } from "./script";
import { linkFromPersisted } from "./bootstrap";
import { inferIncludes, scriptSegmentsFor } from "./generation/prompts";
import { invalidateImageMetadata } from "./metadataCache";
import { useGenerationStore } from "../stores/generationStore";
import { useModelsStore } from "../stores/modelsStore";
import { findLoadedImage, useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { useScriptStore } from "../stores/scriptStore";
import type { ChainLink, ImageMetadata, RefImage, RefSnapshot } from "./types";

async function pathExists(path: string): Promise<boolean> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch {
    return true;
  }
}

/** A sidecar can exist without describing a generation: tagging a file that
 *  never had one (an OS-dragged reference image) writes a sidecar holding
 *  only its identity and tags. Restoring "settings" from that would wipe the
 *  current prompt for nothing, so treat it as no metadata. */
function hasGenerationMetadata(
  meta: ImageMetadata | null,
): meta is ImageMetadata {
  return (
    !!meta &&
    !!(meta.modelId || meta.prompt || meta.shotPrompt || meta.combinedPrompt)
  );
}

function normalizeRefs(raw: (RefSnapshot | string)[] | undefined): RefImage[] {
  if (!raw) return [];
  return raw.map((r) =>
    typeof r === "string"
      ? { path: r, roleAssignment: null }
      : {
          path: r.path,
          roleAssignment: r.roleAssignment ?? null,
          assetId: r.assetId,
          hash: r.hash,
        },
  );
}

/** Resolve a ref back to a live path: the recorded path first (fast, the
 *  common case), then the local asset index by id, then by content hash —
 *  catches a ref whose source moved (or was restored on a different
 *  machine, once Turso sync is configured) since this sidecar was written.
 *  Returns null when none of the tiers find a file that actually exists. */
async function resolveRefPath(
  projectPath: string | null,
  ref: RefImage,
): Promise<string | null> {
  if (await pathExists(ref.path)) return ref.path;
  if (!projectPath) return null;
  for (const [id, hash] of [
    [ref.assetId, null],
    [null, ref.hash],
  ] as const) {
    if (!id && !hash) continue;
    const row = await cmd
      .asset_lookup(projectPath, id ?? null, hash ?? null)
      .catch(() => null);
    if (!row) continue;
    const abs = joinPath(projectPath, row.relPath);
    if (await pathExists(abs)) return abs;
  }
  return null;
}

/** Apply a sidecar metadata record to the current editor state. */
export async function copySettingsFromMetadata(meta: ImageMetadata): Promise<{
  restoredRefs: number;
  skippedRefs: number;
  missingModel: string | null;
}> {
  const models = useModelsStore.getState();
  const gen = useGenerationStore.getState();
  const session = useSessionStore.getState();

  // A sidecar whose modelId is no longer in the registry leaves the current
  // model in place — report it rather than silently restoring prompts and
  // settings onto whatever model happened to be selected.
  const node = meta.modelId ? models.findById(meta.modelId) : null;
  if (node) gen.selectModel(node);
  const missingModel =
    meta.modelId && !node ? (meta.model ?? meta.modelId) : null;

  // Restore prompts (back-compat: old sidecars only had `prompt`).
  // Metadata stores the combined shot prompt as one string; recall lands it
  // in a single box (the multi-box split is not preserved in metadata).
  const sequencePrompt = meta.sequencePrompt ?? "";
  const shotPrompts =
    meta.shotPrompts && meta.shotPrompts.length > 0
      ? meta.shotPrompts
      : [meta.shotPrompt ?? meta.prompt ?? ""];
  gen.setSequencePrompt(sequencePrompt);
  gen.setShotPrompts(shotPrompts);

  // Inclusion ticks aren't recorded in the flat sidecar — recover them from
  // the combined prompt that was actually submitted, so a section the user had
  // unticked doesn't come back on and silently re-enter the next generation.
  // Script bodies come from the loaded script (same source the generation path
  // reads), since they aren't in the sidecar either.
  const { sequenceScript, shotScript } = scriptSegmentsFor(
    session.sequencePath,
    session.shotPath,
  );
  const includes = inferIncludes(meta.combinedPrompt ?? "", {
    sequenceScript,
    sequencePrompt,
    shotScript,
    shotPrompts,
  });
  gen.setSequenceScriptIncluded(includes.sequenceScript);
  gen.setSequencePromptIncluded(includes.sequencePrompt);
  gen.setShotScriptIncluded(includes.shotScript);
  // setShotPrompts reset every box to included, so only the excluded ones need
  // an explicit write.
  includes.shotPrompts.forEach((inc, i) => {
    if (!inc) gen.setShotPromptIncludedAt(i, false);
  });

  // Settings
  const settings = meta.settings || {};
  for (const [k, v] of Object.entries(settings)) gen.setSetting(k, v);

  // Refs — resolve each (path hint -> assetId -> hash); drop any that
  // still can't be found.
  const refs = normalizeRefs(meta.refs);
  const projectPath = session.projectPath;
  const valid: RefImage[] = [];
  let skipped = 0;
  for (const r of refs) {
    const resolved = await resolveRefPath(projectPath, r);
    if (resolved)
      valid.push(resolved === r.path ? r : { ...r, path: resolved });
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

  return { restoredRefs: valid.length, skippedRefs: skipped, missingModel };
}

/** Restore a full prompt chain into the work surface from a sidecar's
 *  chain block. Missing models in the registry are kept as null on the link
 *  (the preflight will flag them; the user can pick a replacement). */
export async function restoreChainFromMetadata(
  meta: ImageMetadata,
): Promise<{ missingModels: number; skippedRefs: number }> {
  if (!meta.chain) return { missingModels: 0, skippedRefs: 0 };
  const models = useModelsStore.getState();
  const projectPath = useSessionStore.getState().projectPath;
  let missingModels = 0;
  let skippedRefs = 0;
  const restored: ChainLink[] = [];
  for (const p of meta.chain.links) {
    const refs: RefImage[] = [];
    for (const r of p.refImages ?? []) {
      const resolved = await resolveRefPath(projectPath, r);
      if (resolved)
        refs.push(resolved === r.path ? r : { ...r, path: resolved });
      else skippedRefs++;
    }
    // Same hydrator the app-restart path uses (so the prompt-section
    // inclusion flags come across), with our resolved refs overlaid.
    const link = linkFromPersisted(p, models.entries);
    if (p.modelId && !link.model) missingModels++;
    restored.push({ ...link, refImages: refs });
  }
  useGenerationStore.getState().setChain(restored, null);
  return { missingModels, skippedRefs };
}

/** Combined display prompt for a sidecar, preferring the stored combined string
 *  and falling back through seq+shot prompts to the legacy single `prompt` field. */
export function assemblePromptFromMetadata(meta: ImageMetadata): string {
  return (
    meta.combinedPrompt ||
    [
      meta.sequencePrompt,
      ...(meta.shotPrompts ??
        (meta.shotPrompt ? [meta.shotPrompt] : [meta.prompt ?? ""])),
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/** Result of a trace traversal: the set of visited paths plus the parent
 *  refs for each node, captured during the same BFS so the consumer can draw
 *  the dependency graph without re-reading metadata. */
export type TraceResult = {
  nodes: Set<string>;
  /** child path → ordered list of refs that produced it (parent path + role). */
  parents: Map<string, RefImage[]>;
};

/** Compute ancestor set for a trace: {image} ∪ {all ancestors via sidecar.refs},
 *  retaining the parent→child edges discovered along the way. */
export async function computeTraceSet(imagePath: string): Promise<TraceResult> {
  const projectPath = useSessionStore.getState().projectPath;
  const nodes = new Set<string>();
  const parents = new Map<string, RefImage[]>();
  const queue: string[] = [imagePath];
  while (queue.length) {
    const p = queue.shift()!;
    if (nodes.has(p)) continue;
    nodes.add(p);
    const meta = await cmd.image_metadata_read(p).catch(() => null);
    if (!meta) continue;
    const refs = normalizeRefs(meta.refs);
    const resolved: RefImage[] = [];
    for (const r of refs) {
      const path = await resolveRefPath(projectPath, r);
      if (!path) continue; // unresolved — no edge to draw
      resolved.push(path === r.path ? r : { ...r, path });
      if (!nodes.has(path)) queue.push(path);
    }
    if (resolved.length > 0) parents.set(p, resolved);
  }
  return { nodes, parents };
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
  const insideProject = !!projectPath && isChildOf(projectPath, imagePath);
  let finalPath = imagePath;
  if (!insideProject) {
    const destDir = `${shotPath}/SRC`;
    await cmd.dir_ensure(destDir);
    finalPath = await cmd.image_copy_to_dir(imagePath, destDir);
  }
  useGenerationStore.getState().addRefs([finalPath]);
  void enrichRefIdentity([finalPath]);
  return finalPath;
}

/** Backfill assetId/contentHash onto already-added refs by reading each
 *  source's own sidecar — best-effort, fire-and-forget (the ref is already
 *  visible in the UI with just its path; this only matters later, if the
 *  resolver needs to find the file again after it's moved). No-op for refs
 *  whose source has no sidecar (external, unmigrated, or already gone). */
async function enrichRefIdentity(paths: string[]): Promise<void> {
  const gen = useGenerationStore.getState();
  await Promise.all(
    paths.map(async (path) => {
      const meta = await cmd.image_metadata_read(path).catch(() => null);
      if (meta?.assetId || meta?.contentHash) {
        gen.patchRefIdentity(path, meta.assetId, meta.contentHash);
      }
    }),
  );
}

/** Rename the current sequence: renames on disk, keeps the timeline/refs/
 *  script mirrors coherent, and re-navigates to the renamed sequence (and
 *  the shot the user was on, if it survived). */
export async function renameSequence(newName: string): Promise<void> {
  const session = useSessionStore.getState();
  const { projectPath, sequencePath, shotPath } = session;
  if (!projectPath) throw new Error("no project");
  if (!sequencePath) throw new Error("no sequence to rename");
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("name cannot be empty");

  const oldSeqPath = sequencePath;
  const oldShotPath = shotPath;
  const oldSeqBase = basename(oldSeqPath);

  // Job-safety guard. Refuse if any non-terminal job targets this sequence.
  const inFlight = inFlightJobs(useGenerationStore.getState().jobs, oldSeqPath);
  if (inFlight.length > 0) {
    throw new Error(
      `Cannot rename — ${inFlight.length} job${
        inFlight.length > 1 ? "s are" : " is"
      } running in this sequence.`,
    );
  }

  const newSeqPath = await cmd.sequence_rename(oldSeqPath, trimmed);
  if (newSeqPath === oldSeqPath) return;

  // Keep in-memory mirrors coherent before re-rendering.
  useTimelineStore.getState().renameShotPathPrefix(oldSeqPath, newSeqPath);
  useGenerationStore.getState().rewriteRefImagePaths(oldSeqPath, newSeqPath);

  const sequences = await cmd.project_open(projectPath);
  useSessionStore.getState().setSequencesInProject(sequences);
  await useSessionStore.getState().setSequence(newSeqPath);

  // setSequence auto-opens the last shot. Navigate back to the user's shot
  // if it survived the rename (same basename, new parent).
  if (oldShotPath) {
    const targetShotPath = `${newSeqPath}/${basename(oldShotPath)}`;
    const after = useSessionStore.getState();
    if (
      after.shotsInSequence.includes(targetShotPath) &&
      after.shotPath !== targetShotPath
    ) {
      await after.setShot(targetShotPath);
    }
  }

  // script.md heading rewrite (silent no-op when no matching # heading).
  const scriptState = useScriptStore.getState();
  const nextRaw = rewriteScriptHeading(scriptState.raw, 1, oldSeqBase, trimmed);
  if (nextRaw !== scriptState.raw) {
    await scriptState
      .save(projectPath, nextRaw)
      .catch(swallow("script heading rewrite"));
  }
}

/** Rename the current shot: renames on disk, keeps the timeline/refs/script
 *  mirrors coherent, and re-navigates to the renamed shot. */
export async function renameShot(newName: string): Promise<void> {
  const session = useSessionStore.getState();
  const { projectPath, sequencePath, shotPath } = session;
  if (!projectPath) throw new Error("no project");
  if (!sequencePath) throw new Error("no sequence");
  if (!shotPath) throw new Error("no shot to rename");
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("name cannot be empty");

  const oldShotPath = shotPath;
  const oldShotBase = basename(oldShotPath);

  const inFlight = inFlightJobs(
    useGenerationStore.getState().jobs,
    oldShotPath,
  );
  if (inFlight.length > 0) {
    throw new Error(
      `Cannot rename — ${inFlight.length} job${
        inFlight.length > 1 ? "s are" : " is"
      } running in this shot.`,
    );
  }

  const newShotPath = await cmd.shot_rename(oldShotPath, trimmed);
  if (newShotPath === oldShotPath) return;

  useTimelineStore.getState().renameShotPathPrefix(oldShotPath, newShotPath);
  useGenerationStore.getState().rewriteRefImagePaths(oldShotPath, newShotPath);

  const { shots } = await cmd.sequence_open(sequencePath);
  useSessionStore.getState().setShotsInSequence(shots);
  await useSessionStore.getState().setShot(newShotPath);

  const scriptState = useScriptStore.getState();
  const nextRaw = rewriteScriptHeading(
    scriptState.raw,
    2,
    oldShotBase,
    trimmed,
  );
  if (nextRaw !== scriptState.raw) {
    await scriptState
      .save(projectPath, nextRaw)
      .catch(swallow("script heading rewrite"));
  }
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
  | "set_clip_media"
  | "trace"
  | "refresh"
  | "open_location"
  | "delete"
  | "rename"
  | "edit"
  | "crop"
  | "trim_video"
  | "edit_tags"
  | "restore_chain"
  | "show_info";

// Transcode an on-disk image to PNG bytes and push to the system clipboard.
// Canvas handles jpeg/webp/etc. so the clipboard receives something every OS
// paste target can accept. Videos aren't supported (no "image" to copy).
async function copyImageToClipboard(path: string): Promise<void> {
  if (classifyMedia(path) === "video") {
    await showMessage("Copy image not supported for video files", {
      kind: "warning",
    });
    return;
  }
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const mime = guessContentType(path);
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
// Module-level per-path handlers — stable references for memo'd Thumbnails.
export const selectImagePath = (path: string) =>
  void performImageAction("select", path);

/** Open the tag editor for a thumbnail, anchored to the element that asked
 *  (falls back to a centered popover when there's no on-screen origin). */
export const editTagsAt = (path: string, anchor?: DOMRect) =>
  useSessionStore
    .getState()
    .setTagEditor(
      path,
      anchor ? { x: anchor.left, y: anchor.bottom + 4 } : null,
    );

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
    case "edit_tags":
      session.setTagEditor(path);
      return;
    case "set_clip_media": {
      const { shotPath } = session;
      if (!shotPath) {
        await showMessage("No shot open", { kind: "warning" });
        return;
      }
      try {
        const tl = useTimelineStore.getState();
        const current =
          tl.shotsLatestMedia.get(shotPath)?.clipMediaPath ?? null;
        await tl.setShotClipMedia(shotPath, current === path ? null : path);
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
    case "copy_settings": {
      const meta = await cmd.image_metadata_read(path).catch(() => null);
      if (!hasGenerationMetadata(meta)) {
        await showMessage("No metadata for this image", { kind: "warning" });
        return;
      }
      const ok = await confirmAction(
        `Reuse prompt and settings from ${basename(path)}? This overwrites the current model, prompts, settings, and refs.`,
        { title: "Reuse prompt", kind: "warning" },
      );
      if (!ok) return;
      const { restoredRefs, skippedRefs, missingModel } =
        await copySettingsFromMetadata(meta);
      if (missingModel) {
        await showMessage(
          `Prompt and settings reused, but "${missingModel}" is no longer in the model registry — pick a model before generating.`,
          { kind: "warning" },
        );
      } else if (restoredRefs > 0 || skippedRefs > 0) {
        const skip = skippedRefs
          ? `, ${skippedRefs} skipped (files missing)`
          : "";
        await showMessage(`Reused. Restored ${restoredRefs} ref(s)${skip}.`, {
          kind: "info",
        });
      }
      return;
    }
    case "restore_chain": {
      const meta = await cmd.image_metadata_read(path).catch(() => null);
      if (!meta?.chain) {
        await showMessage("No chain metadata for this image", {
          kind: "warning",
        });
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
      if (skippedRefs)
        parts.push(`${skippedRefs} ref(s) skipped (missing files)`);
      if (parts.length > 0) {
        await showMessage(`Chain restored. ${parts.join(" · ")}.`, {
          kind: "info",
        });
      }
      return;
    }
    case "copy_prompt": {
      const meta = await cmd.image_metadata_read(path).catch(() => null);
      if (!hasGenerationMetadata(meta)) {
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
    case "trim_video":
      // The menu entry and the preview button are both kind-gated already;
      // this catches a stale surface rather than handing ffmpeg a still.
      if (classifyMedia(path) !== "video") {
        await showMessage("Trim is only available for video files", {
          kind: "warning",
        });
        return;
      }
      session.setSelectedImage(path);
      session.setZoomInitialMode("trim");
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
      const { nodes, parents } = await computeTraceSet(path);
      session.setTrace({ imagePath: path, traceSet: nodes, parents });
      return;
    }
    case "delete": {
      // Nothing is ever removed: the file, its sidecar and its thumbnail move
      // to <project>/TRASH/ under a mirror of their relative path. In a PRISM
      // project even that is refused — the pipeline owns those files. Every
      // affordance is hidden there, so reaching this is a stale-UI case.
      if (session.prism) {
        await showMessage(
          "aiSLAP does not remove files in a PRISM project.",
          { kind: "warning" },
        );
        return;
      }
      const img = findLoadedImage(path);
      const ok = await confirmAction(
        `Move ${img?.filename ?? basename(path)} to TRASH?`,
        {
          title: "Move to TRASH",
          kind: "warning",
        },
      );
      if (!ok) return;
      try {
        await cmd.image_trash(path);
        // The sidecar left this path — a cached read would outlive the file.
        invalidateImageMetadata(path);
        await session.rescanShot();
        if (useSessionStore.getState().zoomImagePath === path) {
          useSessionStore.getState().setZoomImage(null);
        }
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
      }
      return;
    }
    case "show_info":
      useSessionStore.getState().setInfoImage(path);
      return;
  }
}

export { enrichRefIdentity };
