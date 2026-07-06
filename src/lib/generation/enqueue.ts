// Queueing entry points: snapshot the generation form (single link or whole
// chain) into JobSpecs, register them with the runner, and kick the pump.

import { cmd } from "../tauri";
import { confirmAction } from "../dialog";
import { pushLog } from "../../stores/logStore";
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  type ChainLink,
  type ChainLinkPersisted,
  type Config,
  type ImageMetadata,
  type Job,
  type ModelNode,
  type RefImage,
  type RoleAssignment,
} from "../types";
import {
  selectActiveLink,
  useGenerationStore,
} from "../../stores/generationStore";
import { useSessionStore } from "../../stores/sessionStore";
import { getProvider } from "../providers";
import { swallow } from "../errors";
import { preflightChain } from "../chainValidation";
import { isVideoPath } from "../media";
import {
  buildCombinedForLink,
  buildPromptsForLink,
  nonEmptyTrimmed,
  previewShotPrompt,
} from "./prompts";
import {
  type JobSpec,
  pumpQueue,
  registerJob,
  setMaxConcurrentJobs,
  shortId,
} from "./runner";

export { cancelAllGenerations } from "./runner";

/** Load Config over IPC, swallowing errors (returns null if unavailable). */
async function loadConfigSafely(): Promise<Config | null> {
  return await cmd.config_load().catch(() => null);
}

/** Append sequence + shot prompt history to their sidecars and hydrate the
 *  session store so the navigation UI reflects them immediately. Best-effort:
 *  failures are non-fatal and swallowed so a history hiccup never blocks a
 *  generation. */
async function appendPromptHistories(
  sequencePath: string | null | undefined,
  sequenceText: string,
  shotPath: string,
  shotPrompts: string[],
): Promise<void> {
  if (sequencePath && sequenceText.length > 0) {
    try {
      const sidecar = await cmd.sequence_prompt_append(sequencePath, sequenceText);
      useSessionStore.getState().hydrateSequenceSidecar(sidecar);
    } catch (e) {
      swallow("sequence prompt history append")(e);
    }
  }
  const panels = nonEmptyTrimmed(shotPrompts);
  if (panels.length > 0) {
    try {
      const sidecar = await cmd.shot_prompts_append(shotPath, panels);
      useSessionStore.getState().hydrateShotSidecar(sidecar);
    } catch (e) {
      swallow("shot prompt history append")(e);
    }
  }
}

/** Preflight ref-role check. Returns false when the user cancels. */
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

/** Load config-derived job options and remember the concurrency cap. */
async function loadJobConfig(): Promise<{
  ffmpegPath: string;
  filenameTemplate: string;
}> {
  const config = await loadConfigSafely();
  setMaxConcurrentJobs(config?.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS);
  return {
    ffmpegPath: config?.ffmpegPath ?? "",
    filenameTemplate: config?.filenameTemplate ?? "",
  };
}

/** Resolve target version up front so the job is bound to a concrete (shot,
 *  version) at submit time even if the user navigates away mid-flight. */
async function resolveTargetVersion(shotPath: string): Promise<string> {
  let targetVersion = useSessionStore.getState().targetVersion;
  if (!targetVersion || targetVersion === "SRC") {
    targetVersion = await cmd.version_create_next(shotPath);
    useSessionStore.setState({ targetVersion });
  }
  return targetVersion;
}

function makeJob(spec: JobSpec): Job {
  return {
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
    enqueuedAt: new Date().toISOString(),
    shotPromptPreview: previewShotPrompt(spec.shotPrompt),
  };
}

/**
 * Snapshot the current generation form into a Job + JobSpec, push the job onto
 * the queue, and kick the dispatcher. Multiple calls accumulate; the pump
 * respects `Config.maxConcurrentJobs` and the rest sit at status:queued.
 */
export async function enqueueGeneration(): Promise<void> {
  const gen = useGenerationStore.getState();
  const session = useSessionStore.getState();
  const activeLink = selectActiveLink(gen);

  const node = activeLink.model;
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

  const runs = buildPromptsForLink(activeLink, session.sequencePath, session.shotPath);
  if (runs.length === 0) {
    gen.setError("Both prompts are empty.");
    return;
  }

  if (!(await preflightRefs(node, activeLink.refImages))) return;

  const { ffmpegPath, filenameTemplate } = await loadJobConfig();

  try {
    await getProvider(node.provider).prepare();
  } catch (e) {
    gen.setError(e instanceof Error ? e.message : String(e));
    return;
  }

  const targetVersion = await resolveTargetVersion(session.shotPath);

  const iterations = Math.max(1, gen.iterations | 0);
  const sequencePromptText = activeLink.sequencePrompt;
  const allShotPrompts = activeLink.shotPrompts.slice();
  const baseSettings = { ...activeLink.settings };
  const baseRefs = activeLink.refImages.slice();

  // Fan out: one queued job per shot prompt. They run in parallel up to the
  // concurrency cap once pumpQueue dispatches below.
  for (const run of runs) {
    const id = crypto.randomUUID();

    const spec: JobSpec = {
      id,
      tag: shortId(id),
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
    registerJob(spec, makeJob(spec));
    pushLog("INFO", `Queued: ${node.name}`, spec.tag);
  }
  gen.setError(null);

  // Append prompt histories synchronously at submit time so the navigation UI
  // reflects the latest prompts even before the jobs are dispatched.
  await appendPromptHistories(
    session.sequencePath,
    sequencePromptText,
    session.shotPath,
    allShotPrompts,
  );

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
  const isVideo = isVideoPath(prevPath);
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

  const { ffmpegPath, filenameTemplate } = await loadJobConfig();

  try {
    await getProvider(headLink.model.provider).prepare();
  } catch (e) {
    gen.setError(e instanceof Error ? e.message : String(e));
    return;
  }

  const targetVersion = await resolveTargetVersion(session.shotPath);

  // Append history once from the head link (per design decision: chain
  // submissions log only the entrance into the chain).
  await appendPromptHistories(
    session.sequencePath,
    headLink.sequencePrompt,
    session.shotPath,
    headLink.shotPrompts,
  );

  const chainId = crypto.randomUUID();
  const linksSnapshot = links.map(persistLink);
  const iterations = Math.max(1, gen.iterations | 0);
  const shotPath = session.shotPath;

  pushLog("INFO", `Chain started · ${activeLinks.length} links`, shortId(chainId));

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
      const combinedShot = nonEmptyTrimmed(link.shotPrompts).join("\n\n");

      const linkCombined = buildCombinedForLink(link, session.sequencePath, shotPath);
      const spec: JobSpec = {
        id,
        tag: shortId(id),
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
        targetVersion,
        ffmpegPath,
        filenameTemplate,
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
        pushLog("INFO", `Chain aborted at link ${i + 1}`, shortId(chainId));
        return;
      }

      // Backfill predecessor sidecar with downstream paths so a future
      // restore-chain knows the full graph.
      if (prevMediaPath) {
        await appendChainNextMediaPaths(prevMediaPath, outputs).catch(
          swallow("chain nextMediaPaths backfill"),
        );
      }

      prevMediaPath = outputs[0];
    }
    pushLog("SUCCESS", "Chain finished", shortId(chainId));
  })();
}

function queueAndAwait(spec: JobSpec): Promise<string[] | null> {
  return new Promise((resolve) => {
    spec.onComplete = (outs) => resolve(outs);
    spec.onFailed = () => resolve(null);
    spec.onCancelled = () => resolve(null);
    registerJob(spec, makeJob(spec));
    void pumpQueue();
  });
}

/** Backfill the chain.nextMediaPaths array on a predecessor's sidecar. */
async function appendChainNextMediaPaths(
  prevMediaPath: string,
  newOutputs: string[],
): Promise<void> {
  const meta = await cmd.image_metadata_read(prevMediaPath).catch(() => null);
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
