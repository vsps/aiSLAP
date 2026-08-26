// Job lifecycle: queue dispatch, provider calls, ref upload, progress,
// cancellation. Owns the private jobSpecs/abortControllers maps; queueing
// code registers work via registerJob().
//
// The queue is app-wide, not per-tab: one concurrency cap and one provider
// budget, however many tabs are open. Each job is *attributed* to the tab that
// submitted it via `JobSpec.tabId`, and every store touch below goes through
// that id rather than through the `useGenerationStore` / `useSessionStore`
// proxies — a job routinely outlives the tab switch that follows submitting it,
// and the proxies always report whichever tab is in front.

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
import type { GenerationState } from "../../stores/generationStore";
import {
  activeStores,
  activeTabId,
  allTabs,
  storesFor,
} from "../../stores/tabsStore";
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
  /** The tab that submitted this job. Every progress/pending write is routed
   *  through it, so switching tabs mid-generation doesn't land this job's
   *  status in someone else's queue. */
  tabId: string;
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
  /** Project root, captured at enqueue. Carried rather than derived from
   *  `shotPath` because the shot isn't a fixed depth below it (a PRISM shot's
   *  media root is `<entity>/Renders/AI`), and because the user may navigate
   *  elsewhere while the job runs. */
  projectPath: string;
  /** Project identity uuid, captured at enqueue for the same reason. */
  projectId: string;
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

/**
 * The generation store of the tab that owns `tabId`, or null when that tab has
 * since been closed.
 *
 * A closed tab does not cancel its jobs: the media file and its sidecar are the
 * durable commit, so the work runs to completion and lands on disk. What is
 * gone is the UI that was tracking it, hence the null — every caller below uses
 * `?.` and simply skips the status update.
 */
function genFor(tabId: string): GenerationState | null {
  return storesFor(tabId)?.generation.getState() ?? null;
}

/** Register a snapshotted spec + its UI job and kick the dispatcher. */
export function registerJob(spec: JobSpec, job: Job): void {
  jobSpecs.set(spec.id, spec);
  genFor(spec.tabId)?.addJob(job);
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
  const provider: "fal" | "replicate" | "bytedance" | "beeble" =
    spec.node.provider === "replicate"
      ? "replicate"
      : spec.node.provider === "bytedance"
        ? "bytedance"
        : spec.node.provider === "beeble"
          ? "beeble"
          : "fal";
  return {
    id: pendingId,
    provider,
    endpoint: spec.node.endpoint,
    requestId,
    shotPath: spec.shotPath,
    projectPath: spec.projectPath,
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

/** Every open tab's jobs, paired with the store that owns each one. The queue
 *  spans tabs, so the dispatcher has to look at all of them. */
function allJobs(): { job: Job; gen: GenerationState }[] {
  const out: { job: Job; gen: GenerationState }[] = [];
  for (const tab of allTabs()) {
    const gen = tab.stores.generation.getState();
    for (const job of gen.jobs) out.push({ job, gen });
  }
  return out;
}

function activeJobCount(): number {
  return allJobs().filter(
    ({ job }) => job.status !== "queued" && !isJobTerminal(job.status),
  ).length;
}

/**
 * Dispatcher. Picks the next queued job whenever an in-flight slot is free.
 * Reentrancy-guarded: a single loop drains the queue up to the cap, then
 * exits. Called from the enqueue paths and from each job's finally.
 *
 * FIFO across every tab, ordered by `startedAt` (a `performance.now()` reading,
 * so it is monotonic and comparable between tabs). Two tabs submitting does not
 * double the number of jobs in flight — that is the point of one shared cap.
 */
export async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const queued = allJobs()
        .filter(({ job }) => job.status === "queued")
        .sort((a, b) => a.job.startedAt - b.job.startedAt);
      const next = queued[0];
      if (!next) break;
      if (activeJobCount() >= cachedMaxConcurrent) break;

      const spec = jobSpecs.get(next.job.id);
      if (!spec) {
        // Defensive: drop a queued job with no spec rather than spinning.
        next.gen.removeJob(next.job.id);
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

/**
 * Cancel every queued and running job in the active tab, plus best-effort
 * server-side cancel.
 *
 * Scoped to the front tab on purpose: this is the RunColumn's "cancel all"
 * button, and the user means the work they are looking at — a background tab's
 * generation is not theirs to bin from here.
 */
export function cancelAllGenerations(): void {
  const gen = activeStores().generation.getState();
  for (const j of gen.jobs) {
    if (isJobTerminal(j.status)) continue;
    if (j.status === "queued") {
      const spec = jobSpecs.get(j.id);
      jobSpecs.delete(j.id);
      gen.updateJob(j.id, {
        status: "cancelled",
        progressMessage: "Cancelled",
      });
      pushLog("INFO", "Cancelled (was queued)", shortId(j.id));
      spec?.onCancelled?.();
      continue;
    }
    gen.updateJob(j.id, {
      status: "cancelling",
      progressMessage: "Cancelling…",
    });
    abortControllers.get(j.id)?.abort();
  }
}

/** Rescan every tab currently looking at `shotPath`.
 *
 *  Replaces a single "is this the open shot?" check. With tabs there can be
 *  more than one answer — the same shot open in two tabs, or none, if the user
 *  has navigated away from the job's shot entirely. */
async function rescanViewersOf(shotPath: string): Promise<void> {
  await Promise.all(
    allTabs()
      .filter((t) => t.stores.session.getState().shotPath === shotPath)
      .map((t) => t.stores.session.getState().rescanShot()),
  );
}

/** Runs one job to completion / cancellation / failure. */
async function runJob(spec: JobSpec): Promise<void> {
  const tag = spec.tag;
  // Re-resolved on each use rather than captured: the owning tab can be closed
  // while this runs, and `genFor` then reports that by returning null.
  const gen = () => genFor(spec.tabId);

  const controller = new AbortController();
  abortControllers.set(spec.id, controller);

  gen()?.updateJob(spec.id, {
    status: "uploading",
    progressMessage: "Uploading references…",
  });
  pushLog("INFO", `Generating with ${spec.node.name}`, tag, spec.tabId);

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

    gen()?.updateJob(spec.id, { status: "running" });

    // Always loop over iterations. The model's batch_field (if any) flows
    // through baseArgs from buildArgs() — honoring whatever value the user
    // set, rather than overriding it to the iteration count.
    for (let k = 1; k <= spec.iterations; k++) {
      if (controller.signal.aborted) break;
      gen()?.updateJob(spec.id, {
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
          (e) => reportProgress(spec, k, spec.iterations, e),
          {
            onSubmitted: async (requestId) => {
              await cmd
                .pending_add(buildPendingRecord(pendingId, spec, k, requestId))
                .catch(swallow("pending-record persistence"));
            },
          },
        );
        gen()?.updateJob(spec.id, {
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
          priceOverrides: usePricesStore.getState().overrides,
          refs: uploaded,
          refSnapshots: undefined,
          shotPath: spec.shotPath,
          projectPath: spec.projectPath,
          versionDir,
          targetVersion: spec.targetVersion,
          iterationBase: k,
          iterationTotal: spec.iterations,
          expandToIterations: false,
          ffmpegPath: spec.ffmpegPath,
          filenameTemplate: spec.filenameTemplate,
          chain: spec.chain,
          projectId: spec.projectId,
        });
        totalOutputs.push(...outs);
        gen()?.updateJob(spec.id, { completedIterations: k });
        // Each completed iteration replaces one placeholder tile.
        gen()?.decrementPendingOutputs(spec.shotPath, spec.targetVersion);
        // Flag results the user cannot currently see, so the tab strip can say
        // so. Checked per iteration rather than once at the end: a long
        // multi-iteration run should light the tab up as soon as the first
        // file lands, not only when the whole job is done.
        if (activeTabId() !== spec.tabId) {
          gen()?.noteUnseenOutputs(outs.length);
        }
        // Rescan wherever the freshly-written shot is on screen; a tab looking
        // at a different shot is left alone rather than flickering to this one.
        await rescanViewersOf(spec.shotPath);
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
      gen()?.updateJob(spec.id, {
        status: "done",
        progressMessage: `Generated ${totalOutputs.length} file(s)`,
      });
      pushLog("SUCCESS", `Generated ${totalOutputs.length} file(s)`, tag, spec.tabId);
      await rescanViewersOf(spec.shotPath);
      spec.onComplete?.(totalOutputs);
    } else {
      // Loop exited via abort partway through — surface as cancellation.
      spec.onCancelled?.();
    }
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err.name === "AbortError" || controller.signal.aborted) {
      gen()?.updateJob(spec.id, {
        status: "cancelled",
        progressMessage: "Cancelled",
      });
      gen()?.clearPendingOutputs(spec.shotPath, spec.targetVersion);
      pushLog("INFO", "Cancelled by user", tag, spec.tabId);
      spec.onCancelled?.();
    } else {
      // Always dump the raw error so dev tools shows every field — wrappers
      // around fetch/SDK errors otherwise lose status/body when stringified.
      console.error(`[job ${tag}] failed:`, e);
      playSound("buzz");
      const msg = extractErrorMessage(e);
      gen()?.updateJob(spec.id, {
        status: "failed",
        progressMessage: "Failed",
        error: msg,
      });
      gen()?.clearPendingOutputs(spec.shotPath, spec.targetVersion);
      gen()?.setError(msg);
      pushLog("ERROR", msg, tag, spec.tabId);
      spec.onFailed?.(e);
    }
  } finally {
    abortControllers.delete(spec.id);
    jobSpecs.delete(spec.id);
    void pumpQueue();
  }
}

function reportProgress(
  spec: JobSpec,
  k: number,
  total: number,
  e: ProviderProgress,
) {
  const gen = genFor(spec.tabId);
  if (!gen) return;
  const prefix = total > 1 ? `(${k}/${total}) ` : "";
  if (e.kind === "queued") {
    const pos = e.position !== undefined ? ` (pos ${e.position})` : "";
    gen.updateJob(spec.id, {
      currentIteration: k,
      progressMessage: `${prefix}Queued at provider${pos}`,
    });
  } else if (e.kind === "running") {
    gen.updateJob(spec.id, {
      currentIteration: k,
      progressMessage: `${prefix}Generating…`,
    });
  } else if (e.kind === "completed") {
    gen.updateJob(spec.id, {
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
