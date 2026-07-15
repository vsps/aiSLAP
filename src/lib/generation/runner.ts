// Job lifecycle: queue dispatch, provider calls, ref upload, progress,
// cancellation. Owns the private jobSpecs/abortControllers maps; queueing
// code registers work via registerJob().

import { cmd } from "../tauri";
import { basename, joinPath } from "../paths";
import { fileSrc } from "../assets";
import { pushLog } from "../../stores/logStore";
import type {
  ChainMetadataBlock,
  Job,
  ModelNode,
  PendingSubmission,
  RefImage,
  UploadedRef,
} from "../types";
import { useGenerationStore } from "../../stores/generationStore";
import { useSessionStore } from "../../stores/sessionStore";
import { usePricesStore } from "../../stores/pricesStore";
import { getProvider } from "../providers";
import type { ProviderProgress } from "../providers";
import { extractErrorMessage, swallow } from "../errors";
import { isJobTerminal } from "../jobs";
import { buildArgs } from "../args";
import { guessContentType } from "../media";
import { playSound } from "../audio";
import { downloadAndWrite } from "./output";

export type JobSpec = {
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

// Per-job AbortController. Keyed by job id so cancellation can target one or all.
const abortControllers = new Map<string, AbortController>();

// Snapshotted spec per queued job. Held outside the store because the runtime
// payload (model node, ref roles, ffmpeg path, …) is heavier than what the UI
// needs to render and would bloat the persisted store shape.
const jobSpecs = new Map<string, JobSpec>();

// Cached at enqueue time (Config loads asynchronously; the pump loop needs a
// synchronous value). Default 3 matches the schema.
let cachedMaxConcurrent = 3;

// Reentrancy guard for pumpQueue. The pump itself is async because it calls
// runJob; without this flag, two concurrent enqueues could both enter the
// dispatch loop and run more than `cachedMaxConcurrent` jobs at once.
let pumping = false;

// Length of the short id prefix shown in log lines (e.g. "a1b2c3").
const SHORT_ID_LEN = 6;
export const shortId = (id: string) => id.slice(0, SHORT_ID_LEN);

export function setMaxConcurrentJobs(n: number): void {
  cachedMaxConcurrent = Math.max(1, n);
}

/** Register a snapshotted spec + its UI job and kick the dispatcher. */
export function registerJob(spec: JobSpec, job: Job): void {
  jobSpecs.set(spec.id, spec);
  useGenerationStore.getState().addJob(job);
}

/** Build a PendingSubmission record from the JobSpec for the iteration that
 *  just got a requestId back from the provider. Used by the orphan-recovery
 *  layer; written before we wait for the result and removed once the file
 *  is on disk (or the iteration aborts non-resumably). */
function buildPendingRecord(
  pendingId: string,
  spec: JobSpec,
  iterationIndex: number,
  requestId: string,
): PendingSubmission {
  const provider: "fal" | "replicate" | "bytedance" =
    spec.node.provider === "replicate"
      ? "replicate"
      : spec.node.provider === "bytedance"
        ? "bytedance"
        : "fal";
  return {
    id: pendingId,
    provider,
    endpoint: spec.node.endpoint,
    requestId,
    shotPath: spec.shotPath,
    targetVersion: spec.targetVersion,
    ffmpegPath: spec.ffmpegPath,
    filenameTemplate: spec.filenameTemplate,
    modelId: spec.node.id,
    modelName: spec.node.name,
    modelEndpoint: spec.node.endpoint,
    modelProvider: provider,
    batchField: spec.node.batch_field,
    sequencePrompt: spec.sequencePrompt,
    shotPrompt: spec.shotPrompt,
    shotPrompts: spec.shotPrompts,
    combinedPrompt: spec.combinedPrompt,
    settings: { ...spec.settings },
    refs: spec.refs.map((r) => ({
      path: r.path,
      roleAssignment: r.roleAssignment ?? null,
    })),
    iterations: spec.iterations,
    iterationIndex,
    chain: spec.chain ?? null,
    enqueuedAt: new Date().toISOString(),
  };
}

function activeJobCount(): number {
  return useGenerationStore
    .getState()
    .jobs.filter((j) => j.status !== "queued" && !isJobTerminal(j.status))
    .length;
}

/**
 * Dispatcher. Picks the next queued job whenever an in-flight slot is free.
 * Reentrancy-guarded: a single loop drains the queue up to the cap, then
 * exits. Called from the enqueue paths and from each job's finally.
 */
export async function pumpQueue(): Promise<void> {
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
    if (isJobTerminal(j.status)) continue;
    if (j.status === "queued") {
      const spec = jobSpecs.get(j.id);
      jobSpecs.delete(j.id);
      state.updateJob(j.id, {
        status: "cancelled",
        progressMessage: "Cancelled",
      });
      pushLog("INFO", "Cancelled (was queued)", shortId(j.id));
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
      const pendingId = crypto.randomUUID();
      try {
        const out = await provider.run(
          spec.node.endpoint,
          baseArgs,
          controller.signal,
          (e) => reportProgress(spec.id, k, spec.iterations, e),
          {
            onSubmitted: async (requestId) => {
              await cmd
                .pending_add(buildPendingRecord(pendingId, spec, k, requestId))
                .catch(swallow("pending-record persistence"));
            },
          },
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
          combinedPrompt: spec.combinedPrompt,
          settings: spec.settings,
          prices: usePricesStore.getState().prices,
          refs: uploaded,
          refSnapshots: undefined,
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
        // Each completed iteration replaces one placeholder tile.
        gen.decrementPendingOutputs(spec.shotPath, spec.targetVersion);
        // Rescan only when the freshly-written shot is what the user is viewing;
        // otherwise the gallery would briefly flicker to the job's shot.
        if (useSessionStore.getState().shotPath === spec.shotPath) {
          await useSessionStore.getState().rescanShot();
        }
      } finally {
        // Whether the iter succeeded, failed, or was aborted, the pending
        // record's job is done. Crash-path is the one case `finally` doesn't
        // fire — that's exactly when the recovery flow picks it up later.
        await cmd
          .pending_remove(pendingId)
          .catch(swallow("pending-record removal"));
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
      gen.clearPendingOutputs(spec.shotPath, spec.targetVersion);
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
      gen.clearPendingOutputs(spec.shotPath, spec.targetVersion);
      gen.setError(msg);
      pushLog("ERROR", msg, tag);
      spec.onFailed?.(e);
    }
  } finally {
    abortControllers.delete(spec.id);
    jobSpecs.delete(spec.id);
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
    // fetch() against the asset:// protocol doesn't throw on a missing file —
    // it resolves with a 404 response — so an unchecked .blob() would upload
    // garbage/empty content and fail late with a confusing remote 500. Fail
    // fast locally instead, naming the actual missing path (refs can outlive
    // the shot they were added from, e.g. after a rename/move/delete).
    const res = await fetch(fileSrc(r.path));
    if (!res.ok) {
      throw new Error(
        `Reference file not found or unreadable: ${r.path} (HTTP ${res.status})`,
      );
    }
    const blob = await res.blob();
    if (blob.size === 0) {
      throw new Error(`Reference file is empty: ${r.path}`);
    }
    const name = basename(r.path);
    const type = blob.type || guessContentType(name);
    const file = new File([blob], name, { type });
    const url = await provider.uploadFile(file, signal);
    out.push({ ref: r, url });
  }
  return out;
}
