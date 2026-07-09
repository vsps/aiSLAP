// Download provider outputs to disk, write metadata sidecars, and resolve
// output filenames from the configured template. No store imports — also
// used by the orphan-recovery driver.

import { cmd } from "../tauri";
import { basename, dirname, joinPath } from "../paths";
import { perItemPrice } from "../falPrices";
import type {
  ChainMetadataBlock,
  ImageMetadata,
  ModelNode,
  RefSnapshot,
  RoleAssignment,
  UploadedRef,
} from "../types";
import type { ProviderOutput } from "../providers";

export const DEFAULT_FILENAME_TEMPLATE =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

export type DownloadCtx = {
  out: ProviderOutput;
  node: ModelNode;
  sequencePrompt: string;
  shotPrompt: string;
  shotPrompts: string[];
  /** The exact prompt string submitted to the provider — script segments and
   *  inclusion flags already applied. Written verbatim to the sidecar so it
   *  can't drift from what was actually sent. */
  combinedPrompt: string;
  settings: Record<string, unknown>;
  /** Cached fal per-endpoint prices (Settings -> fetch prices), used to
   *  compute costUsd at write time. A plain snapshot, not a store import —
   *  keeps this module usable by the orphan-recovery driver. */
  prices: Record<string, string>;
  /** Uploaded refs (live path). Empty in recovery — see `refSnapshots`. */
  refs: UploadedRef[];
  /** Alternative source for sidecar refs when `refs` (uploaded) is empty.
   *  Used by the orphan-recovery driver, which doesn't have upload URLs. */
  refSnapshots?: RefSnapshot[];
  shotPath: string;
  versionDir: string;
  targetVersion: string;
  iterationBase: number;
  iterationTotal: number;
  expandToIterations: boolean;
  ffmpegPath: string;
  filenameTemplate: string;
  chain?: Omit<ChainMetadataBlock, "nextMediaPaths">;
};

export async function downloadAndWrite(ctx: DownloadCtx): Promise<string[]> {
  const written: string[] = [];
  const files = ctx.out.files;
  if (files.length === 0) {
    // A provider call can return HTTP 200 with no recognized media field —
    // e.g. the model found nothing to segment, or its response shape didn't
    // match what unwrapFalOutput() expects. Fail loudly with the raw payload
    // instead of silently reporting success with 0 files written.
    throw new Error(
      `${ctx.node.name} returned no output file. Raw response: ${JSON.stringify(ctx.out.raw).slice(0, 1000)}`,
    );
  }
  const multipleFiles = files.length > 1;

  // Inline-text output (e.g. SAM3 image embedding) — no URL to download; write
  // the payload verbatim to a .txt sidecar. Not a viewable gallery tile.
  const firstInline = files.find((f) => f.inlineText !== undefined);
  if (firstInline) {
    const filename = resolveFilename(ctx, 1, "txt", false);
    const target = joinPath(ctx.versionDir, filename);
    await cmd.write_text_file(target, firstInline.inlineText ?? "");
    const meta = buildMetadataRecord(ctx, ctx.iterationBase);
    await cmd.image_metadata_write(target, meta);
    written.push(target);
    return written;
  }

  const firstModel3d = files.find((f) => f.isModel3d);
  if (firstModel3d) {
    const ext = extFromUrl(firstModel3d.url) ?? "glb";
    const filename = resolveFilename(ctx, 1, ext, false);
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(firstModel3d.url, target);
    if (firstModel3d.thumbUrl) {
      const thumbPath = target.replace(/\.[^.]+$/, ".thumb.png");
      await cmd.download_to_path(firstModel3d.thumbUrl, thumbPath).catch(() => {});
    }
    const meta = buildMetadataRecord(ctx, ctx.iterationBase);
    await cmd.image_metadata_write(target, meta);
    written.push(target);
    return written;
  }

  const firstVideo = files.find((f) => f.isVideo);
  if (firstVideo) {
    const ext = extFromUrl(firstVideo.url) ?? "mp4";
    const filename = resolveFilename(ctx, 1, ext, false);
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(firstVideo.url, target);
    const thumbPath = target.replace(/\.[^.]+$/, ".thumb.png");
    if (ctx.ffmpegPath) {
      await cmd
        .video_thumbnail_extract(target, thumbPath, ctx.ffmpegPath)
        .catch(() => false);
    }
    const meta = buildMetadataRecord(ctx, ctx.iterationBase);
    await cmd.image_metadata_write(target, meta);
    written.push(target);
    return written;
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.url) continue;
    const declaredExt = String(
      ctx.settings["output_format"] ?? "",
    ).toLowerCase();
    const ext = declaredExt || extFromUrl(f.url) || "png";
    const filename = resolveFilename(ctx, i + 1, ext, multipleFiles);
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(f.url, target);
    const iterIdx = ctx.expandToIterations
      ? Math.min(ctx.iterationBase + i, ctx.iterationTotal)
      : ctx.iterationBase;
    const meta = buildMetadataRecord(ctx, iterIdx);
    await cmd.image_metadata_write(target, meta);
    written.push(target);
  }
  return written;
}

function buildMetadataRecord(ctx: DownloadCtx, iterationIndex: number): ImageMetadata {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.settings)) {
    if (k === "seed" && v === -1) continue;
    if (ctx.node.batch_field && k === ctx.node.batch_field) continue;
    cleaned[k] = v;
  }
  const costUsd = perItemPrice(ctx.node.provider, ctx.node.endpoint, ctx.prices) ?? undefined;
  return {
    provider: ctx.node.provider ?? "fal",
    model: ctx.node.name,
    modelId: ctx.node.id,
    endpoint: ctx.node.endpoint,
    sequencePrompt: ctx.sequencePrompt,
    shotPrompt: ctx.shotPrompt,
    shotPrompts: ctx.shotPrompts,
    combinedPrompt: ctx.combinedPrompt,
    settings: cleaned,
    refs:
      ctx.refSnapshots ??
      ctx.refs.map((r) => ({
        path: r.ref.path,
        roleAssignment: r.ref.roleAssignment as RoleAssignment | null,
      })),
    iterationIndex,
    iterationTotal: ctx.iterationTotal > 1 ? ctx.iterationTotal : undefined,
    timestamp: new Date().toISOString(),
    providerResponse: ctx.out.raw,
    chain: ctx.chain,
    costUsd,
  };
}

// Sanitize a string for use in a filename: collapse unsafe chars to underscore.
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\s]+/g, "_").replace(/^_+|_+$/g, "") || "_";
}

function resolveFilename(
  ctx: DownloadCtx,
  idx: number,
  ext: string,
  appendIter: boolean,
): string {
  const tpl = ctx.filenameTemplate || DEFAULT_FILENAME_TEMPLATE;
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  const shotName = basename(ctx.shotPath);
  const seqName = basename(dirname(ctx.shotPath));
  const seed = ctx.settings["seed"];
  const seedToken = seed !== undefined && seed !== -1 ? String(seed) : "rnd";

  const promptToken =
    [ctx.sequencePrompt, ctx.shotPrompt]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "noprompt";

  const hasIter = tpl.includes("<iter>");
  let base = tpl
    .replace(
      /<date>/g,
      `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`,
    )
    .replace(
      /<time>/g,
      `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}_${ms}`,
    )
    .replace(/<sequence>/g, safeName(seqName))
    .replace(/<shot>/g, safeName(shotName))
    .replace(/<model>/g, safeName(ctx.node.name))
    .replace(/<version>/g, safeName(ctx.targetVersion))
    .replace(/<prompt>/g, promptToken)
    .replace(/<iter>/g, String(idx).padStart(3, "0"))
    .replace(/<seed>/g, seedToken)
    .replace(/<provider>/g, ctx.node.provider ?? "fal");

  // When template has no <iter> but we have multiple outputs, append index to avoid collisions.
  if (!hasIter && appendIter) {
    base = `${base}_${String(idx).padStart(3, "0")}`;
  }

  return `${base}.${ext}`;
}

function extFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
