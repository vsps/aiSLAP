// Download provider outputs to disk, write metadata sidecars, and resolve
// output filenames from the configured template. No store imports — also
// used by the orphan-recovery driver.

import { cmd } from "../tauri";
import { joinPath, relativeTo } from "../paths";
import { seqShotNames } from "../prism";
import { estimateGenerationCost, perItemPrice, parseDurationSeconds } from "../falPrices";
import { classifyMedia, THUMB_SUFFIXES } from "../media";
import { negativePromptParam, splitNegativePrompt } from "../args";
import { pushLog } from "../../stores/logStore";
import { currentUsername } from "../systemUser";
import { reportOutboxSync } from "../outboxSync";
import { randomWordPicker } from "./randomWord";
import type {
  AssetRecord,
  AssetRefRecord,
  ChainMetadataBlock,
  ImageMetadata,
  ModelNode,
  RefSnapshot,
  RoleAssignment,
  UploadedRef,
} from "../types";
import type { ProviderOutput } from "../providers";

export const DEFAULT_FILENAME_TEMPLATE =
  "<date>_<time>_<sequence>_<shot>_<rnd>_<rnd>_<version>_<minor>";

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
  /** User-entered per-endpoint price overrides (Settings -> Costs), any
   *  provider. Takes priority over `prices` — see perItemPrice(). */
  priceOverrides?: Record<string, number>;
  /** Uploaded refs (live path). Empty in recovery — see `refSnapshots`. */
  refs: UploadedRef[];
  /** Alternative source for sidecar refs when `refs` (uploaded) is empty.
   *  Used by the orphan-recovery driver, which doesn't have upload URLs. */
  refSnapshots?: RefSnapshot[];
  shotPath: string;
  /** Project root. Carried rather than derived: the shot sits at a fixed depth
   *  below it only in a native project (a PRISM shot's media root is two levels
   *  deeper), and the asset index's relPath depends on getting this right. */
  projectPath: string;
  versionDir: string;
  targetVersion: string;
  iterationBase: number;
  iterationTotal: number;
  expandToIterations: boolean;
  ffmpegPath: string;
  filenameTemplate: string;
  chain?: Omit<ChainMetadataBlock, "nextMediaPaths">;
  /** Stable id of the open project — stamped into every output's embedded
   *  media tag + sidecar. Empty string when the project hasn't been
   *  assigned one yet (degrades gracefully, never blocks a write). */
  projectId: string;
};

export async function downloadAndWrite(ctx: DownloadCtx): Promise<string[]> {
  const written: string[] = [];
  let files = ctx.out.files;
  if (files.length === 0) {
    // A provider call can return HTTP 200 with no recognized media field —
    // e.g. the model found nothing to segment, or its response shape didn't
    // match what unwrapFalOutput() expects. Fail loudly with the raw payload
    // instead of silently reporting success with 0 files written.
    throw new Error(
      `${ctx.node.name} returned no output file. Raw response: ${JSON.stringify(ctx.out.raw).slice(0, 1000)}`,
    );
  }

  // Some "thinking"/iterative image models (e.g. Nano Banana Pro) can return
  // an extra lower-res preview frame alongside the final image in the same
  // response, even when only one was requested — the response then has more
  // entries than num_images actually asked for. Only trim when the model
  // declares a batch_field (so multi-file outputs with no such concept, like
  // SAM3's masks, are never touched) and only when the provider handed back
  // MORE than requested. A well-behaved batch that returns exactly what was
  // requested is untouched either way.
  if (ctx.node.batch_field) {
    const raw = Number(ctx.settings[ctx.node.batch_field]);
    const requestedCount = Number.isFinite(raw) && raw > 0 ? raw : 1;
    if (files.length > requestedCount) {
      // Prefer actual resolution over array position — there's no documented
      // guarantee previews sort before the final image, only an observed one.
      // Falls back to keeping the LAST entries only when any file is missing
      // dimensions (e.g. video/3D providers, or a provider that omits them).
      const allSized = files.every(
        (f) => typeof f.width === "number" && typeof f.height === "number",
      );
      files = allSized
        ? [...files]
            .sort((a, b) => b.width! * b.height! - a.width! * a.height!)
            .slice(0, requestedCount)
        : files.slice(-requestedCount);
    }
  }

  const multipleFiles = files.length > 1;

  // Ask fal for the authoritative cost of this job (one call covers every
  // file this job produced — fal bills each item in a batch uniformly, so
  // dividing the total evenly is accurate and far cheaper than one call per
  // file). Never blocks or fails the write: any missing key, network error,
  // or non-fal provider just leaves this null, and buildMetadataRecord falls
  // back to the local perItemPrice() approximation.
  const costPerFile = await estimateCostPerFile(ctx, files.length);

  // The inline-text / 3D / video branches below each write exactly one file;
  // only the image loop writes one per entry. Resolved up front so the
  // <minor> ordinals can be reserved in a single call rather than one per file.
  const firstInline = files.find((f) => f.inlineText !== undefined);
  const firstModel3d = files.find((f) => f.isModel3d);
  const firstVideo = files.find((f) => f.isVideo);
  const writeCount =
    firstInline || firstModel3d || firstVideo ? 1 : files.length;
  const minors = await allocateMinors(ctx, writeCount);
  const rnd = await resolveRandomWords(ctx);
  const tokensFor = (i: number): NameTokens => ({ minor: minors[i], rnd });

  // Inline-text output (e.g. SAM3 image embedding) — no URL to download; write
  // the payload verbatim to a .txt sidecar. Not a viewable gallery tile.
  if (firstInline) {
    const filename = resolveFilename(ctx, 1, "txt", false, tokensFor(0));
    const target = joinPath(ctx.versionDir, filename);
    await cmd.write_text_file(target, firstInline.inlineText ?? "");
    const identity = await identifyMedia(target, ctx.projectId, ctx.ffmpegPath);
    const meta = buildMetadataRecord(ctx, ctx.iterationBase, identity, costPerFile, null);
    await cmd.image_metadata_write(target, meta);
    await recordAsset(ctx.projectPath, target, meta, identity);
    written.push(target);
    return written;
  }

  if (firstModel3d) {
    const ext = extFromUrl(firstModel3d.url) ?? "glb";
    const filename = resolveFilename(ctx, 1, ext, false, tokensFor(0));
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(firstModel3d.url, target);
    if (firstModel3d.thumbUrl) {
      // PNG, unlike the video posters below: the provider's preview render is
      // RGBA (Meshy ships a transparent background) and already ~130KB, so
      // there is nothing to gain by flattening it onto black. These bytes are
      // downloaded verbatim, never re-encoded.
      const thumbPath = target.replace(/\.[^.]+$/, ".thumb.png");
      await cmd.download_to_path(firstModel3d.thumbUrl, thumbPath).catch(() => {});
    }
    const identity = await identifyMedia(target, ctx.projectId, ctx.ffmpegPath);
    const meta = buildMetadataRecord(ctx, ctx.iterationBase, identity, costPerFile, null);
    await cmd.image_metadata_write(target, meta);
    await recordAsset(ctx.projectPath, target, meta, identity);
    written.push(target);
    return written;
  }

  if (firstVideo) {
    const ext = extFromUrl(firstVideo.url) ?? "mp4";
    const filename = resolveFilename(ctx, 1, ext, false, tokensFor(0));
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(firstVideo.url, target);
    const identity = await identifyMedia(target, ctx.projectId, ctx.ffmpegPath);
    const thumbPath = target.replace(/\.[^.]+$/, THUMB_SUFFIXES[0]);
    if (ctx.ffmpegPath) {
      await cmd
        .video_thumbnail_extract(target, thumbPath, ctx.ffmpegPath)
        .catch(() => false);
    }
    const meta = buildMetadataRecord(ctx, ctx.iterationBase, identity, costPerFile, null);
    await cmd.image_metadata_write(target, meta);
    await recordAsset(ctx.projectPath, target, meta, identity);
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
    const filename = resolveFilename(ctx, i + 1, ext, multipleFiles, tokensFor(i));
    const target = joinPath(ctx.versionDir, filename);
    await cmd.download_to_path(f.url, target);
    const megapixels = await readMegapixels(target);
    const identity = await identifyMedia(target, ctx.projectId, ctx.ffmpegPath);
    const iterIdx = ctx.expandToIterations
      ? Math.min(ctx.iterationBase + i, ctx.iterationTotal)
      : ctx.iterationBase;
    const meta = buildMetadataRecord(ctx, iterIdx, identity, costPerFile, megapixels);
    await cmd.image_metadata_write(target, meta);
    await recordAsset(ctx.projectPath, target, meta, identity);
    written.push(target);
  }
  return written;
}

/** Real output pixel count / 1,000,000, read from the downloaded file's own
 *  header — used to price per-megapixel-billed models (e.g. FLUX, Topaz
 *  upscale) exactly, per isPerAreaUnit in falPrices.ts. Never guessed from a
 *  named size preset or an upscale model's input-dependent output size.
 *  Null for anything imagesize doesn't recognize (non-image outputs) —
 *  best-effort, never blocks the write. */
async function readMegapixels(target: string): Promise<number | null> {
  const dims = await cmd.image_dimensions_read(target).catch(() => null);
  return dims ? (dims.width * dims.height) / 1_000_000 : null;
}

/** fal's own authoritative per-output cost for this job (see
 *  estimateGenerationCost), divided evenly across every file the job
 *  produced. Returns null for non-fal providers, a missing fal key, or any
 *  failed/unavailable estimate — callers fall back to the local
 *  perItemPrice() computation in that case. */
async function estimateCostPerFile(ctx: DownloadCtx, fileCount: number): Promise<number | null> {
  if ((ctx.node.provider ?? "fal") !== "fal") return null;
  const apiKey = await cmd.provider_key_get("fal").catch(() => "");
  if (!apiKey) return null;
  const total = await estimateGenerationCost(apiKey, ctx.node.endpoint, fileCount);
  if (total == null) {
    pushLog("INFO", `fal cost estimate unavailable for ${ctx.node.name} — using local price estimate.`);
    return null;
  }
  return total / fileCount;
}

export type OutputIdentity = { assetId: string; contentHash?: string };

/** Mint an asset id, best-effort embed it (+ the project id) into the media
 *  file, and hash the final bytes. Embedding is enhancement, not a
 *  requirement — a format we don't embed into (3D/text) or a failed remux
 *  still gets an id + hash, just not a recoverable in-file tag. Runs after
 *  the file is fully on disk so the hash matches what's embedded.
 *
 *  Takes the two primitives it needs rather than a DownloadCtx, so media that
 *  enters the project without a generation behind it (the video trim) mints
 *  its identity through this same path — two files must never share an
 *  assetId, and that rule wants one implementation. */
export async function identifyMedia(
  target: string,
  projectId: string,
  ffmpegPath: string,
): Promise<OutputIdentity> {
  const assetId = crypto.randomUUID();
  await cmd
    .media_id_embed(target, assetId, projectId, ffmpegPath)
    .catch(() => false);
  const contentHash = await cmd.file_hash(target).catch(() => undefined);
  return { assetId, contentHash };
}

function assetKind(path: string): AssetRecord["kind"] {
  const kind = classifyMedia(path);
  return kind === "image" || kind === "video" || kind === "model3d" ? kind : "other";
}

/** Enrich the local asset index (best-effort — sidecar write above is
 *  already the durable commit for this output) and opportunistically flush
 *  the outbox to Turso. The local upsert is awaited (fast, no network); the
 *  remote push is fire-and-forget so a slow/offline Turso never delays a
 *  generation. Takes `projectPath` rather than a DownloadCtx so the video
 *  trim can index its output through the same path. */
export async function recordAsset(
  projectPath: string,
  target: string,
  meta: ImageMetadata,
  identity: OutputIdentity,
): Promise<void> {
  const record: AssetRecord = {
    id: identity.assetId,
    relPath: relativeTo(projectPath, target),
    contentHash: identity.contentHash,
    kind: assetKind(target),
    provider: meta.provider,
    modelId: meta.modelId,
    endpoint: meta.endpoint,
    combinedPrompt: meta.combinedPrompt,
    settingsJson: JSON.stringify(meta.settings ?? {}),
    costUsd: meta.costUsd,
    createdAt: meta.timestamp,
    generatedBy: meta.generatedBy,
  };
  await cmd.asset_upsert(projectPath, record).catch(() => {});

  const refs: AssetRefRecord[] = meta.refs.map((r, i) => {
    const snap: RefSnapshot = typeof r === "string" ? { path: r, roleAssignment: null } : r;
    return {
      ordinal: i,
      refAssetId: snap.assetId,
      refRelPath: relativeTo(projectPath, snap.path),
      refHash: snap.hash,
      roleJson: JSON.stringify(snap.roleAssignment ?? null),
    };
  });
  if (refs.length > 0) {
    await cmd.asset_refs_set(projectPath, identity.assetId, refs).catch(() => {});
  }

  void cmd.db_sync_outbox(projectPath).then(reportOutboxSync).catch(() => {});
}

/** Some providers echo the actual seed used even when the request left it to
 *  auto-randomize — e.g. fal's FLUX and Seedance-2.0 both return a top-level
 *  `seed` in their response. Best-effort only: returns null (never guesses)
 *  when the raw response has no such field, which is most models. */
function extractResolvedSeed(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const seed = (raw as Record<string, unknown>).seed;
  return typeof seed === "number" && Number.isFinite(seed) ? seed : null;
}

function buildMetadataRecord(
  ctx: DownloadCtx,
  iterationIndex: number,
  identity: OutputIdentity,
  estimatedCostPerFile: number | null,
  megapixels: number | null,
): ImageMetadata {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.settings)) {
    if (k === "seed" && v === -1) continue;
    if (ctx.node.batch_field && k === ctx.node.batch_field) continue;
    cleaned[k] = v;
  }
  // Prefer the provider-reported resolved seed over the requested value —
  // it reflects what was actually used, whether the request was random
  // (-1, otherwise omitted above) or an explicit value the provider may not
  // have honored exactly.
  const resolvedSeed = extractResolvedSeed(ctx.out.raw);
  if (resolvedSeed != null) cleaned.seed = resolvedSeed;

  // Models with a negative_prompt field have no dedicated settings control
  // for it — it's carved out of the combined prompt at submit time (see
  // splitNegativePrompt/buildArgs). Persist the actual value used here too,
  // rather than only ever showing the empty-string stub from settings.
  const negParam = negativePromptParam(ctx.node);
  if (negParam) {
    const { negativePrompt } = splitNegativePrompt(ctx.combinedPrompt);
    if (negativePrompt) cleaned[negParam.api_field] = negativePrompt;
  }
  // Prefer fal's own live estimate for this job (see estimateCostPerFile);
  // fall back to the local per-item computation when it wasn't available —
  // missing key, network error, non-fal provider, and an endpoint fal's
  // pricing API doesn't know about all collapse to the same fallback.
  const costUsd =
    estimatedCostPerFile ??
    perItemPrice(ctx.node.provider, ctx.node.endpoint, ctx.prices, ctx.priceOverrides, {
      isVideo: ctx.node.kind === "video",
      durationSec: parseDurationSeconds(ctx.settings.duration),
      resolution:
        typeof ctx.settings.resolution === "string" ? ctx.settings.resolution : null,
      megapixels,
    }) ??
    undefined;
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
    falRequestId: ctx.out.requestId,
    assetId: identity.assetId,
    contentHash: identity.contentHash,
    generatedBy: currentUsername(),
  };
}

// Sanitize a string for use in a filename: collapse unsafe chars to underscore.
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\s]+/g, "_").replace(/^_+|_+$/g, "") || "_";
}

function templateOf(ctx: DownloadCtx): string {
  return ctx.filenameTemplate || DEFAULT_FILENAME_TEMPLATE;
}

/** The per-file inputs that can't be derived from `ctx` alone, because they're
 *  resolved asynchronously once per batch rather than per name. */
type NameTokens = {
  /** Column-scoped ordinal for `<minor>`, or null when unavailable. */
  minor: number | null;
  /** Fresh word per call for `<rnd>`, or null when the list didn't load. */
  rnd: (() => string) | null;
};

/** Reserve `count` `<minor>` ordinals for this generation's target column.
 *
 *  Skipped entirely — no IPC, no `shot.json` write — when the template has no
 *  `<minor>` in it, so removing the token costs nothing. A failed allocation is
 *  not fatal either: `resolveFilename` falls back to the file index rather than
 *  losing the output. */
async function allocateMinors(
  ctx: DownloadCtx,
  count: number,
): Promise<(number | null)[]> {
  if (!templateOf(ctx).includes("<minor>")) return Array<null>(count).fill(null);
  const issued = await cmd
    .shot_version_minor_next(ctx.shotPath, ctx.targetVersion, count)
    .catch((e) => {
      pushLog("ERROR", `minor-version allocation failed: ${String(e)}`);
      return [] as number[];
    });
  return Array.from({ length: count }, (_, i) => issued[i] ?? null);
}

/** Word picker for `<rnd>`, or null when the template doesn't use it — which
 *  also means the 97KB wordlist chunk is never fetched. */
async function resolveRandomWords(
  ctx: DownloadCtx,
): Promise<(() => string) | null> {
  if (!templateOf(ctx).includes("<rnd>")) return null;
  const pick = await randomWordPicker();
  if (!pick) pushLog("ERROR", "wordlist unavailable — <rnd> fell back to a placeholder.");
  return pick;
}

function resolveFilename(
  ctx: DownloadCtx,
  idx: number,
  ext: string,
  appendIter: boolean,
  tokens: NameTokens,
): string {
  const tpl = templateOf(ctx);
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  // Entity names, so a PRISM shot reads "MOD"/"s0010" rather than the last two
  // segments of its media root ("Renders"/"AI").
  const { seq: seqName, shot: shotName } = seqShotNames(ctx.shotPath);
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

  // Both of these are always substituted — a literal "<minor>"/"<rnd>" reaching
  // the filesystem would be an invalid path on Windows, so the fallbacks are
  // not optional.

  // Fallback is the file index, leaving uniqueness resting on <time>'s
  // millisecond field: no worse than before the token existed.
  base = base.replace(/<minor>/g, String(tokens.minor ?? idx).padStart(3, "0"));

  // A *function* replacer, so every occurrence rolls on its own — `<rnd>_<rnd>`
  // yields two different words, and each file in a batch gets a fresh pair.
  base = base.replace(/<rnd>/g, () =>
    tokens.rnd ? safeName(tokens.rnd()) : "noword",
  );

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
