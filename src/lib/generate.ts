import { cmd } from "./tauri";
import { basename, dirname, joinPath } from "./paths";
import { fileSrc } from "./assets";
import { confirmAction } from "./dialog";
import { pushLog } from "../stores/logStore";
import type {
  ChainLink,
  ChainLinkPersisted,
  ChainMetadataBlock,
  Config,
  ImageMetadata,
  Job,
  ModelNode,
  RefImage,
  RoleAssignment,
  UploadedRef,
} from "./types";
import { useGenerationStore } from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import { getProvider } from "./providers";
import type { ProviderOutput, ProviderProgress } from "./providers";
import { extractErrorMessage } from "./errors";
import { buildArgs, combinePromptParts, guessContentType } from "./args";
import { findSequenceBody, findShotBody } from "./script";
import { useScriptStore } from "../stores/scriptStore";
import { playSound } from "./audio";
import { preflightChain } from "./chainValidation";
// Per-job AbortController. Keyed by job id so cancellation can target one or all.
const abortControllers = new Map<string, AbortController>();

// Snapshotted spec per queued job. Held outside the store because the runtime
// payload (model node, ref roles, ffmpeg path, …) is heavier than what the UI
// needs to render and would bloat the persisted store shape.
const jobSpecs = new Map<string, JobSpec>();

// Cached at queue-pump time. Reads Config asynchronously, so we keep a value
// to use synchronously inside the pump loop. Default 3 matches the schema.
let cachedMaxConcurrent = 3;

// Reentrancy guard for pumpQueue. The pump itself is async because it calls
// runJob; without this flag, two enqueues could race and over-dispatch.
let pumping = false;


type JobSpec = {
  id: string;
  tag: string; // short id for log lines
  node: ModelNode;
  sequencePrompt: string;
  shotPrompts: string[];
  shotPrompt: string; // pre-join of shotPrompts; metadata only
  /** Final combined prompt actually sent to the API. Computed at enqueue time
   *  from script segments + sequence/shot prompts respecting inclusion flags. */
  combinedPrompt: string;
  settings: Record<string, unknown>;
  refs: RefImage[];
  iterations: number;
  shotPath: string;
  targetVersion: string;
  ffmpegPath: string;
  filenameTemplate: string;
  /** Chain provenance — set on every link of a multi-link chain submission.
   *  When present, every output's metadata sidecar inherits this block (the
   *  runner copies the value into `ChainMetadataBlock` in buildMetadataRecord). */
  chain?: Omit<ChainMetadataBlock, "nextMediaPaths">;
  /** Chain-runner hooks. Invoked once each at terminal job status.
   *  outputs[] is the absolute on-disk paths written by this job. */
  onComplete?: (outputs: string[]) => void;
  onFailed?: (err: unknown) => void;
  onCancelled?: () => void;
};

/** Build the final combined prompt for a link respecting inclusion flags and
 *  the loaded script segments matched against current sequence/shot folders. */
function buildCombinedForLink(
  link: ChainLink,
  sequencePath: string | null,
  shotPath: string | null,
): string {
  const parsed = useScriptStore.getState().parsed;
  const seqName = sequencePath ? basename(sequencePath) : "";
  const shotName = shotPath ? basename(shotPath) : "";
  const sequenceScript = seqName ? findSequenceBody(parsed, seqName) : "";
  const shotScript = seqName && shotName ? findShotBody(parsed, seqName, shotName) : "";
  const shotIncludes = link.shotPromptsIncluded ?? link.shotPrompts.map(() => true);
  return combinePromptParts({
    sequenceScript,
    sequencePrompt: link.sequencePrompt,
    shotScript,
    shotPrompts: link.shotPrompts,
    includes: {
      sequenceScript: link.sequenceScriptIncluded !== false,
      sequencePrompt: link.sequencePromptIncluded !== false,
      shotScript: link.shotScriptIncluded !== false,
      shotPrompts: link.shotPrompts.map((_, i) => shotIncludes[i] !== false),
    },
  });
}

/** Fan a link's shot prompts out into one combined prompt per included,
 *  non-empty shot prompt. Shared parts (sequence script + sequence prompt +
 *  shot script) are prepended to each — respecting their inclusion flags —
 *  exactly like buildCombinedForLink, but only one shot prompt per entry.
 *  When no shot prompt qualifies but a shared header exists, returns a single
 *  header-only entry. Returns [] only when everything is empty. */
function buildPromptsForLink(
  link: ChainLink,
  sequencePath: string | null,
  shotPath: string | null,
): { combined: string; shotPrompt: string }[] {
  const parsed = useScriptStore.getState().parsed;
  const seqName = sequencePath ? basename(sequencePath) : "";
  const shotName = shotPath ? basename(shotPath) : "";
  const sequenceScript = seqName ? findSequenceBody(parsed, seqName) : "";
  const shotScript = seqName && shotName ? findShotBody(parsed, seqName, shotName) : "";
  const shotIncludes = link.shotPromptsIncluded ?? link.shotPrompts.map(() => true);
  const headerIncludes = {
    sequenceScript: link.sequenceScriptIncluded !== false,
    sequencePrompt: link.sequencePromptIncluded !== false,
    shotScript: link.shotScriptIncluded !== false,
  };

  const runs: { combined: string; shotPrompt: string }[] = [];
  link.shotPrompts.forEach((sp, i) => {
    if (shotIncludes[i] === false) return;
    if (sp.trim().length === 0) return;
    const combined = combinePromptParts({
      sequenceScript,
      sequencePrompt: link.sequencePrompt,
      shotScript,
      shotPrompts: [sp],
      includes: { ...headerIncludes, shotPrompts: [true] },
    });
    if (combined.length > 0) runs.push({ combined, shotPrompt: sp.trim() });
  });

  if (runs.length === 0) {
    const headerOnly = combinePromptParts({
      sequenceScript,
      sequencePrompt: link.sequencePrompt,
      shotScript,
      shotPrompts: [],
      includes: { ...headerIncludes, shotPrompts: [] },
    });
    if (headerOnly.length > 0) runs.push({ combined: headerOnly, shotPrompt: "" });
  }
  return runs;
}

/** Preflight ref-role check. Returns false when the user cancels. */
/** Single-line, 120-char-max snapshot of a shot prompt for the queue checklist. */
function previewShotPrompt(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

async function preflightRefs(
  node: ModelNode,
  refs: RefImage[],
): Promise<boolean> {
  const roles = node.ref_roles ?? [];
  const wantsStart = roles.some((r) => r.role === "start");
  const wantsElement = roles.some((r) => r.role === "element");
  if (!wantsStart && !wantsElement) return true;
  const hasStart = refs.some((r) => r.roleAssignment?.kind === "start");
  const hasElement = refs.some((r) => r.roleAssignment?.kind === "element");
  if (hasStart || hasElement) return true;
  // Auto-element fallback in buildArgs covers this case — unassigned refs
  // on an element-supporting model are promoted to @Element groups at submit.
  if (wantsElement && refs.length > 0) return true;
  const parts: string[] = [];
  if (wantsStart) parts.push("a start frame");
  if (wantsElement) parts.push("element references");
  const needs = parts.join(" and/or ");
  return await confirmAction(
    `No ${needs} assigned. The request will likely fail.\n\nProceed anyway?`,
    { title: "Missing reference role", kind: "warning" },
  );
}

/**
 * Snapshot the current generation form into a Job + JobSpec, push the job onto
 * the queue, and kick the dispatcher. Multiple calls accumulate; the pump
 * respects `Config.maxConcurrentJobs` and the rest sit at status:queued.
 */
export async function enqueueGeneration(): Promise<void> {
  const gen = useGenerationStore.getState();
  const session = useSessionStore.getState();

  const node = gen.currentModel;
  if (!node) {
    gen.setError("Select a model first.");
    return;
  }
  if (!session.shotPath) {
    gen.setError("Open a shot first.");
    return;
  }
  if (session.targetVersion === "SRC") {
    gen.setError("Target version is SRC — pick an actual version.");
    return;
  }

  const activeLink = gen.expandedIdx != null ? gen.links[gen.expandedIdx] : gen.links[0];
  const runs = buildPromptsForLink(activeLink, session.sequencePath, session.shotPath);
  if (runs.length === 0) {
    gen.setError("Both prompts are empty.");
    return;
  }

  if (!(await preflightRefs(node, gen.refImages))) return;

  const config = (await cmd.config_load().catch(() => null)) as Config | null;
  const ffmpegPath = config?.ffmpegPath ?? "";
  const filenameTemplate = config?.filenameTemplate ?? "";
  cachedMaxConcurrent = Math.max(1, config?.maxConcurrentJobs ?? 3);

  try {
    await getProvider(node.provider).prepare();
  } catch (e) {
    gen.setError(e instanceof Error ? e.message : String(e));
    return;
  }

  // Resolve target version up front so the job is bound to a concrete (shot,
  // version) at submit time even if the user navigates away mid-flight.
  let targetVersion = session.targetVersion;
  if (!targetVersion || targetVersion === "SRC") {
    targetVersion = await cmd.version_create_next(session.shotPath);
    useSessionStore.setState({ targetVersion });
  }

  const iterations = Math.max(1, gen.iterations | 0);
  const sequencePromptText = gen.sequencePrompt;
  const allShotPrompts = gen.shotPrompts.slice();
  const baseSettings = { ...gen.settings };
  const baseRefs = gen.refImages.slice();

  // Fan out: one queued job per shot prompt. They run in parallel up to the
  // concurrency cap once pumpQueue dispatches below.
  for (const run of runs) {
    const id = crypto.randomUUID();
    const tag = id.slice(0, 6);

    const spec: JobSpec = {
      id,
      tag,
      node,
      sequencePrompt: sequencePromptText,
      shotPrompts: run.shotPrompt ? [run.shotPrompt] : [],
      shotPrompt: run.shotPrompt,
      combinedPrompt: run.combined,
      settings: { ...baseSettings },
      refs: baseRefs.slice(),
      iterations,
      shotPath: session.shotPath,
      targetVersion,
      ffmpegPath,
      filenameTemplate,
    };
    jobSpecs.set(id, spec);

    const job: Job = {
      id,
      status: "queued",
      progressMessage: "Queued",
      currentIteration: 0,
      iterations,
      completedIterations: 0,
      modelName: node.name,
      shotPath: session.shotPath,
      targetVersion,
      startedAt: performance.now(),
      shotPromptPreview: previewShotPrompt(spec.shotPrompt),
    };
    gen.addJob(job);
    pushLog("INFO", `Queued: ${node.name}`, tag);
  }
  gen.setError(null);

  // Append prompt histories synchronously at submit time so the navigation UI
  // reflects the latest prompts even before the jobs are dispatched.
  if (session.sequencePath && sequencePromptText.length > 0) {
    try {
      const sidecar = await cmd.sequence_prompt_append(
        session.sequencePath,
        sequencePromptText,
      );
      useSessionStore.getState().hydrateSequenceSidecar(sidecar);
    } catch {
      /* swallow — history append failures are non-fatal */
    }
  }
  const nonEmptyPanels = allShotPrompts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (nonEmptyPanels.length > 0) {
    try {
      const sidecar = await cmd.shot_prompts_append(session.shotPath, nonEmptyPanels);
      useSessionStore.getState().hydrateShotSidecar(sidecar);
    } catch {
      /* swallow */
    }
  }

  void pumpQueue();
}

// ---------- Chain submission ----------

function persistLink(l: ChainLink): ChainLinkPersisted {
  return {
    id: l.id,
    active: l.active,
    modelId: l.model?.id ?? null,
    settings: l.settings,
    sequencePrompt: l.sequencePrompt,
    shotPrompts: l.shotPrompts,
    refImages: l.refImages,
    consumesPrev: l.consumesPrev,
    sequencePromptIncluded: l.sequencePromptIncluded,
    sequenceScriptIncluded: l.sequenceScriptIncluded,
    shotScriptIncluded: l.shotScriptIncluded,
    shotPromptsIncluded: l.shotPromptsIncluded,
  };
}

/** Pick a role for the synthetic chain_prev ref so it lands in the right
 *  API slot. Defaults to null when the model has neither a "start" nor a
 *  "source" role (args.ts's fallback then routes it as an element/source). */
function chainPrevRole(model: ModelNode, prevPath: string): RoleAssignment | null {
  const roles = model.ref_roles ?? [];
  const isVideo = /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(prevPath);
  // Video → prefer source (img2img / vid2vid).
  // Image → prefer start (img → video), else source.
  if (isVideo && roles.some((r) => r.role === "source")) return { kind: "source" };
  if (!isVideo && roles.some((r) => r.role === "start")) return { kind: "start" };
  if (roles.some((r) => r.role === "source")) return { kind: "source" };
  return null;
}

/** Enqueue a multi-link chain. Each active link runs sequentially; the
 *  previous link's first output is fed as a synthetic ref to the next.
 *  The final link runs `iterations` times. Cancellation of any step
 *  aborts the rest of the chain. */
export async function enqueueChain(): Promise<void> {
  const gen = useGenerationStore.getState();
  const session = useSessionStore.getState();

  const links = gen.links;
  const activeLinks = links.filter((l) => l.active);
  if (activeLinks.length === 0) {
    gen.setError("Chain has no active links.");
    return;
  }
  // When the whole chain reduces to one link and that link is the lone
  // member, use the existing single-shot path so today's metadata stays
  // identical. With multiple defined-but-skipped links present, fall
  // through to the chain runner so its sole active link is still selected
  // correctly (mirrors may not point at it).
  if (activeLinks.length === 1 && links.length === 1) {
    return enqueueGeneration();
  }
  const errors = preflightChain(links).filter((p) => p.severity === "error");
  if (errors.length > 0) {
    gen.setError(`Chain preflight failed: ${errors[0].message}`);
    return;
  }
  if (!session.shotPath) {
    gen.setError("Open a shot first.");
    return;
  }
  const headLink = activeLinks[0];
  if (!headLink.model) {
    gen.setError("Head link has no model.");
    return;
  }

  // Use today's preflight on the head link only — downstream links receive
  // a synthetic prev-ref so their role expectations are met automatically.
  if (!(await preflightRefs(headLink.model, headLink.refImages))) return;

  const config = (await cmd.config_load().catch(() => null)) as Config | null;
  const ffmpegPath = config?.ffmpegPath ?? "";
  const filenameTemplate = config?.filenameTemplate ?? "";
  cachedMaxConcurrent = Math.max(1, config?.maxConcurrentJobs ?? 3);

  try {
    await getProvider(headLink.model.provider).prepare();
  } catch (e) {
    gen.setError(e instanceof Error ? e.message : String(e));
    return;
  }

  let targetVersion = session.targetVersion;
  if (!targetVersion || targetVersion === "SRC") {
    targetVersion = await cmd.version_create_next(session.shotPath);
    useSessionStore.setState({ targetVersion });
  }

  // Append history once from the head link (per design decision: chain
  // submissions log only the entrance into the chain).
  if (session.sequencePath && headLink.sequencePrompt.length > 0) {
    try {
      const sidecar = await cmd.sequence_prompt_append(
        session.sequencePath,
        headLink.sequencePrompt,
      );
      useSessionStore.getState().hydrateSequenceSidecar(sidecar);
    } catch {
      /* swallow */
    }
  }
  const headPanels = headLink.shotPrompts
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (headPanels.length > 0) {
    try {
      const sidecar = await cmd.shot_prompts_append(
        session.shotPath,
        headPanels,
      );
      useSessionStore.getState().hydrateShotSidecar(sidecar);
    } catch {
      /* swallow */
    }
  }

  const chainId = crypto.randomUUID();
  const linksSnapshot = links.map(persistLink);
  const iterations = Math.max(1, gen.iterations | 0);
  const shotPath = session.shotPath;
  const tFfmpeg = ffmpegPath;
  const tTemplate = filenameTemplate;

  pushLog("INFO", `Chain started · ${activeLinks.length} links`, chainId.slice(0, 6));

  // Fire-and-forget driver — runs each link, awaits, feeds the next.
  void (async () => {
    let prevMediaPath: string | null = null;
    for (let i = 0; i < activeLinks.length; i++) {
      const link = activeLinks[i];
      if (!link.model) break;
      const isLast = i === activeLinks.length - 1;

      const linkRefs: RefImage[] = link.refImages.filter(
        (r) => r.roleAssignment?.kind !== "chain_prev",
      );
      if (link.consumesPrev && prevMediaPath) {
        linkRefs.unshift({
          path: prevMediaPath,
          roleAssignment: chainPrevRole(link.model, prevMediaPath),
        });
      }

      const id = crypto.randomUUID();
      const tag = id.slice(0, 6);
      const combinedShot = link.shotPrompts
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join("\n\n");

      const linkCombined = buildCombinedForLink(link, session.sequencePath, shotPath);
      const spec: JobSpec = {
        id,
        tag,
        node: link.model,
        sequencePrompt: link.sequencePrompt,
        shotPrompts: link.shotPrompts.slice(),
        shotPrompt: combinedShot,
        combinedPrompt: linkCombined,
        settings: { ...link.settings },
        refs: linkRefs,
        // Only the final link honors the iterations field; intermediates run once.
        iterations: isLast ? iterations : 1,
        shotPath,
        targetVersion: targetVersion!,
        ffmpegPath: tFfmpeg,
        filenameTemplate: tTemplate,
        chain: {
          chainId,
          linkIndex: i,
          linkCount: activeLinks.length,
          prevMediaPath: prevMediaPath ?? undefined,
          links: linksSnapshot,
        },
      };

      const outputs = await queueAndAwait(spec);
      if (outputs == null || outputs.length === 0) {
        pushLog("INFO", `Chain aborted at link ${i + 1}`, chainId.slice(0, 6));
        return;
      }

      // Backfill predecessor sidecar with downstream paths so a future
      // restore-chain knows the full graph.
      if (prevMediaPath) {
        await appendChainNextMediaPaths(prevMediaPath, outputs).catch(() => {
          /* swallow — backfill is best-effort */
        });
      }

      prevMediaPath = outputs[0];
    }
    pushLog("SUCCESS", "Chain finished", chainId.slice(0, 6));
  })();
}

function queueAndAwait(spec: JobSpec): Promise<string[] | null> {
  return new Promise((resolve) => {
    spec.onComplete = (outs) => resolve(outs);
    spec.onFailed = () => resolve(null);
    spec.onCancelled = () => resolve(null);

    const job: Job = {
      id: spec.id,
      status: "queued",
      progressMessage: spec.chain
        ? `Queued (link ${spec.chain.linkIndex + 1}/${spec.chain.linkCount})`
        : "Queued",
      currentIteration: 0,
      iterations: spec.iterations,
      completedIterations: 0,
      modelName: spec.node.name,
      shotPath: spec.shotPath,
      targetVersion: spec.targetVersion,
      startedAt: performance.now(),
      shotPromptPreview: previewShotPrompt(spec.shotPrompt),
    };
    jobSpecs.set(spec.id, spec);
    useGenerationStore.getState().addJob(job);
    void pumpQueue();
  });
}

/** Backfill the chain.nextMediaPaths array on a predecessor's sidecar. */
async function appendChainNextMediaPaths(
  prevMediaPath: string,
  newOutputs: string[],
): Promise<void> {
  const meta = (await cmd
    .image_metadata_read(prevMediaPath)
    .catch(() => null)) as ImageMetadata | null;
  if (!meta || !meta.chain) return;
  const existing = meta.chain.nextMediaPaths ?? [];
  const merged = [...existing];
  for (const o of newOutputs) {
    if (!merged.includes(o)) merged.push(o);
  }
  const next: ImageMetadata = {
    ...meta,
    chain: { ...meta.chain, nextMediaPaths: merged },
  };
  await cmd.image_metadata_write(prevMediaPath, next);
}

function activeJobCount(): number {
  return useGenerationStore.getState().jobs.filter((j) => {
    return (
      j.status !== "queued" &&
      j.status !== "done" &&
      j.status !== "failed" &&
      j.status !== "cancelled"
    );
  }).length;
}

/**
 * Dispatcher. Picks the next queued job whenever an in-flight slot is free.
 * Reentrancy-guarded: a single loop drains the queue up to the cap, then
 * exits. Called from enqueueGeneration and from each job's finally.
 */
async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const state = useGenerationStore.getState();
      const queued = state.jobs.find((j) => j.status === "queued");
      if (!queued) break;
      if (activeJobCount() >= cachedMaxConcurrent) break;

      const spec = jobSpecs.get(queued.id);
      if (!spec) {
        // Defensive: drop a queued job with no spec rather than spinning.
        state.removeJob(queued.id);
        continue;
      }
      // Fire-and-forget. runJob calls pumpQueue itself in finally, which is a
      // no-op while we're still inside this loop (pumping=true).
      void runJob(spec);
    }
  } finally {
    pumping = false;
  }
}

/** Cancel every queued and running job, plus best-effort server-side cancel. */
export function cancelAllGenerations(): void {
  const state = useGenerationStore.getState();
  for (const j of state.jobs) {
    if (
      j.status === "done" ||
      j.status === "failed" ||
      j.status === "cancelled"
    )
      continue;
    if (j.status === "queued") {
      const spec = jobSpecs.get(j.id);
      jobSpecs.delete(j.id);
      state.updateJob(j.id, {
        status: "cancelled",
        progressMessage: "Cancelled",
      });
      schedulePrune(j.id);
      pushLog("INFO", "Cancelled (was queued)", j.id.slice(0, 6));
      spec?.onCancelled?.();
      continue;
    }
    state.updateJob(j.id, {
      status: "cancelling",
      progressMessage: "Cancelling…",
    });
    abortControllers.get(j.id)?.abort();
  }
}

function schedulePrune(jobId: string, delayMs = 5000): void {
  setTimeout(() => {
    useGenerationStore.getState().removeJob(jobId);
    jobSpecs.delete(jobId);
  }, delayMs);
}

/** Runs one job to completion / cancellation / failure. */
async function runJob(spec: JobSpec): Promise<void> {
  const gen = useGenerationStore.getState();
  const tag = spec.tag;

  const controller = new AbortController();
  abortControllers.set(spec.id, controller);

  gen.updateJob(spec.id, {
    status: "uploading",
    progressMessage: "Uploading references…",
  });
  pushLog("INFO", `Generating with ${spec.node.name}`, tag);

  try {
    const provider = getProvider(spec.node.provider);
    await provider.prepare();

    const uploaded = await uploadRefs(provider, spec.refs, controller.signal);
    if (controller.signal.aborted)
      throw new DOMException("aborted", "AbortError");

    const baseArgs = buildArgs(
      spec.node,
      spec.combinedPrompt,
      spec.settings,
      uploaded,
    );
    const versionDir = joinPath(spec.shotPath, spec.targetVersion);

    const totalOutputs: string[] = [];

    gen.updateJob(spec.id, { status: "running" });

    // Always loop over iterations. The model's batch_field (if any) flows
    // through baseArgs from buildArgs() — honoring whatever value the user
    // set, rather than overriding it to the iteration count.
    for (let k = 1; k <= spec.iterations; k++) {
      if (controller.signal.aborted) break;
      gen.updateJob(spec.id, {
        status: "running",
        currentIteration: k,
        progressMessage: `Generating (${k}/${spec.iterations})…`,
      });
      const out = await provider.run(
        spec.node.endpoint,
        baseArgs,
        controller.signal,
        (e) => reportProgress(spec.id, k, spec.iterations, e),
      );
      gen.updateJob(spec.id, {
        status: "downloading",
        progressMessage: `Downloading (${k}/${spec.iterations})…`,
      });
      const outs = await downloadAndWrite({
        out,
        node: spec.node,
        sequencePrompt: spec.sequencePrompt,
        shotPrompt: spec.shotPrompt,
        shotPrompts: spec.shotPrompts,
        settings: spec.settings,
        refs: uploaded,
        shotPath: spec.shotPath,
        versionDir,
        targetVersion: spec.targetVersion,
        iterationBase: k,
        iterationTotal: spec.iterations,
        expandToIterations: false,
        ffmpegPath: spec.ffmpegPath,
        filenameTemplate: spec.filenameTemplate,
        chain: spec.chain,
      });
      totalOutputs.push(...outs);
      gen.updateJob(spec.id, { completedIterations: k });
      // Rescan only when the freshly-written shot is what the user is viewing;
      // otherwise the gallery would briefly flicker to the job's shot.
      if (useSessionStore.getState().shotPath === spec.shotPath) {
        await useSessionStore.getState().rescanShot();
      }
    }

    if (!controller.signal.aborted) {
      playSound("bell");
      gen.updateJob(spec.id, {
        status: "done",
        progressMessage: `Generated ${totalOutputs.length} file(s)`,
      });
      pushLog("SUCCESS", `Generated ${totalOutputs.length} file(s)`, tag);
      if (useSessionStore.getState().shotPath === spec.shotPath) {
        await useSessionStore.getState().rescanShot();
      }
      spec.onComplete?.(totalOutputs);
    } else {
      // Loop exited via abort partway through — surface as cancellation.
      spec.onCancelled?.();
    }
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err.name === "AbortError" || controller.signal.aborted) {
      gen.updateJob(spec.id, {
        status: "cancelled",
        progressMessage: "Cancelled",
      });
      pushLog("INFO", "Cancelled by user", tag);
      spec.onCancelled?.();
    } else {
      // Always dump the raw error so dev tools shows every field — wrappers
      // around fetch/SDK errors otherwise lose status/body when stringified.
      console.error(`[job ${tag}] failed:`, e);
      playSound("buzz");
      const msg = extractErrorMessage(e);
      gen.updateJob(spec.id, {
        status: "failed",
        progressMessage: "Failed",
        error: msg,
      });
      gen.setError(msg);
      pushLog("ERROR", msg, tag);
      spec.onFailed?.(e);
    }
  } finally {
    abortControllers.delete(spec.id);
    jobSpecs.delete(spec.id);
    schedulePrune(spec.id);
    void pumpQueue();
  }
}

function reportProgress(
  jobId: string,
  k: number,
  total: number,
  e: ProviderProgress,
) {
  const gen = useGenerationStore.getState();
  const prefix = total > 1 ? `(${k}/${total}) ` : "";
  if (e.kind === "queued") {
    const pos = e.position !== undefined ? ` (pos ${e.position})` : "";
    gen.updateJob(jobId, {
      currentIteration: k,
      progressMessage: `${prefix}Queued at provider${pos}`,
    });
  } else if (e.kind === "running") {
    gen.updateJob(jobId, {
      currentIteration: k,
      progressMessage: `${prefix}Generating…`,
    });
  } else if (e.kind === "completed") {
    gen.updateJob(jobId, {
      currentIteration: k,
      progressMessage: `${prefix}Downloading…`,
    });
  }
}

async function uploadRefs(
  provider: {
    uploadFile: (file: File, signal: AbortSignal) => Promise<string>;
  },
  refs: RefImage[],
  signal: AbortSignal,
): Promise<UploadedRef[]> {
  const out: UploadedRef[] = [];
  for (const r of refs) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const blob = await fetch(fileSrc(r.path)).then((x) => x.blob());
    const name = basename(r.path);
    const type = blob.type || guessContentType(name);
    const file = new File([blob], name, { type });
    const url = await provider.uploadFile(file, signal);
    out.push({ ref: r, url });
  }
  return out;
}

// ---------- Download + sidecar ----------

const DEFAULT_FILENAME_TEMPLATE =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

type DownloadCtx = {
  out: ProviderOutput;
  node: ModelNode;
  sequencePrompt: string;
  shotPrompt: string;
  shotPrompts: string[];
  settings: Record<string, unknown>;
  refs: UploadedRef[];
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

async function downloadAndWrite(ctx: DownloadCtx): Promise<string[]> {
  const written: string[] = [];
  const files = ctx.out.files;
  const multipleFiles = files.length > 1;

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
    await cmd.image_metadata_write(target, meta as unknown as ImageMetadata);
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
    await cmd.image_metadata_write(target, meta as unknown as ImageMetadata);
    written.push(target);
  }
  return written;
}

function buildMetadataRecord(ctx: DownloadCtx, iterationIndex: number) {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.settings)) {
    if (k === "seed" && v === -1) continue;
    if (ctx.node.batch_field && k === ctx.node.batch_field) continue;
    cleaned[k] = v;
  }
  const combined = [ctx.sequencePrompt, ctx.shotPrompt]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  return {
    model: ctx.node.name,
    modelId: ctx.node.id,
    endpoint: ctx.node.endpoint,
    sequencePrompt: ctx.sequencePrompt,
    shotPrompt: ctx.shotPrompt,
    shotPrompts: ctx.shotPrompts,
    combinedPrompt: combined,
    settings: cleaned,
    refs: ctx.refs.map((r) => ({
      path: r.ref.path,
      roleAssignment: r.ref.roleAssignment as RoleAssignment | null,
    })),
    iterationIndex,
    iterationTotal: ctx.iterationTotal > 1 ? ctx.iterationTotal : undefined,
    timestamp: new Date().toISOString(),
    providerResponse: ctx.out.raw,
    chain: ctx.chain,
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
