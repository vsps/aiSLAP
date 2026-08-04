import { useMemo } from "react";
import {
  selectCurrentModel,
  selectSequencePrompt,
  selectShotPrompts,
  useGenerationStore,
} from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  cancelAllGenerations,
  enqueueChain,
  enqueueGeneration,
} from "../lib/generation/enqueue";
import { preflightChain } from "../lib/chainValidation";
import { isJobTerminal } from "../lib/jobs";
import { playSound } from "../lib/audio";
import { showMessage } from "../lib/dialog";
import { seqShotNames } from "../lib/prism";
import { formatCost, perItemPrice, parseDurationSeconds } from "../lib/falPrices";
import { usePricesStore } from "../stores/pricesStore";
import type { ChainLink } from "../lib/types";

// Cost of one run of a link, when its model is fal-priced per output item
// (request/image/video) or has a user-entered override. Otherwise (time/
// size-billed, unpriced) returns null — no fake totals.
function perRunCost(
  link: ChainLink | undefined,
  prices: Record<string, string>,
  overrides: Record<string, number>,
): number | null {
  const model = link?.model;
  if (!model) return null;
  const amount = perItemPrice(model.provider, model.endpoint, prices, overrides, {
    isVideo: model.kind === "video",
    durationSec: parseDurationSeconds(link.settings.duration),
    resolution:
      typeof link.settings.resolution === "string"
        ? link.settings.resolution
        : null,
  });
  if (amount == null) return null;
  // Batch models produce N outputs per request but fal bills per output.
  const batch = model.batch_field ? Number(link.settings[model.batch_field]) : 1;
  return amount * (Number.isFinite(batch) && batch > 1 ? batch : 1);
}

export function RunColumn() {
  const iterations = useGenerationStore((s) => s.iterations);
  const setIterations = useGenerationStore((s) => s.setIterations);
  const currentModel = useGenerationStore(selectCurrentModel);
  const sequencePrompt = useGenerationStore(selectSequencePrompt);
  const shotPrompts = useGenerationStore(selectShotPrompts);
  const jobs = useGenerationStore((s) => s.jobs);
  const resetGenerationForm = useGenerationStore((s) => s.resetGenerationForm);
  const shotPath = useSessionStore((s) => s.shotPath);
  const targetVersion = useSessionStore((s) => s.targetVersion);
  const createNextVersion = useSessionStore((s) => s.createNextVersion);

  const activeJobs = jobs.filter((j) => !isJobTerminal(j.status));

  const queueCount = activeJobs.length;
  const columns = useSessionStore((s) => s.columns);
  const srcVersions = useMemo(() => columns.filter(c => c.isSrc).map(c => c.version), [columns]);
  const hasPrompt = (sequencePrompt + shotPrompts.join("")).trim().length > 0;

  const links = useGenerationStore((s) => s.links);
  const expandedIdx = useGenerationStore((s) => s.expandedIdx);
  const isMultiLink = links.length > 1;

  // Each included, non-empty shot prompt fans out into its own parallel run.
  const activeLink = expandedIdx != null ? links[expandedIdx] : links[0];
  const shotIncludes = activeLink?.shotPromptsIncluded ?? shotPrompts.map(() => true);
  const runCount =
    shotPrompts.filter((p, i) => shotIncludes[i] !== false && p.trim().length > 0).length || 1;
  const showCount = !isMultiLink && runCount > 1;
  const chainProblems = useMemo(
    () => (isMultiLink ? preflightChain(links) : []),
    [links, isMultiLink],
  );
  const chainHasErrors = chainProblems.some((p) => p.severity === "error");

  // Multi-link chains require collapse-to-submit and a clean preflight.
  // Single-link mode behaves exactly like the pre-chain workbench.
  const chainGateOk = !isMultiLink || (expandedIdx == null && !chainHasErrors);

  // Estimated submit cost from cached fal prices (Settings → fetch prices).
  // Only shown when every billed run is per-item priced; time/size-billed
  // models fall back to the raw unit-price text (single-link only).
  const prices = usePricesStore((s) => s.prices);
  const priceOverrides = usePricesStore((s) => s.overrides);
  const { costEstimate, costLabel } = useMemo(() => {
    if (isMultiLink) {
      const active = links.filter((l) => l.active);
      let sum = 0;
      for (let i = 0; i < active.length; i++) {
        const c = perRunCost(active[i], prices, priceOverrides);
        if (c == null) return { costEstimate: null, costLabel: null };
        // Intermediate links run once; the final link honors iterations.
        sum += i === active.length - 1 ? c * Math.max(1, iterations) : c;
      }
      return active.length > 0
        ? { costEstimate: sum, costLabel: null }
        : { costEstimate: null, costLabel: null };
    }
    const per = perRunCost(activeLink, prices, priceOverrides);
    if (per != null) {
      return {
        costEstimate: per * Math.max(1, iterations) * runCount,
        costLabel: null,
      };
    }
    const text = currentModel && (currentModel.provider ?? "fal") === "fal"
      ? prices[currentModel.endpoint] ?? null
      : null;
    return { costEstimate: null, costLabel: text };
  }, [
    isMultiLink,
    links,
    activeLink,
    prices,
    priceOverrides,
    iterations,
    runCount,
    currentModel,
  ]);

  const canRun =
    !!currentModel &&
    !!shotPath &&
    targetVersion !== null &&
    !srcVersions.includes(targetVersion ?? "") &&
    hasPrompt &&
    chainGateOk;

  const canRunPlus =
    !!currentModel &&
    !!shotPath &&
    hasPrompt &&
    !srcVersions.includes(targetVersion ?? "") &&
    chainGateOk;

  const disabledReason = !currentModel
    ? "Pick a model"
    : !shotPath
      ? "Open a shot"
      : !hasPrompt
        ? "Enter a prompt"
        : targetVersion && srcVersions.includes(targetVersion)
          ? "SRC is not a valid target"
          : isMultiLink && expandedIdx != null
            ? "Collapse the chain (▶) before submitting"
            : isMultiLink && chainHasErrors
              ? "Chain has errors — fix red links before submitting"
              : "";

  async function runIntoNewVersion() {
    try {
      await createNextVersion();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
      return;
    }
    await enqueueGeneration();
  }

  async function onSubmit() {
    playSound("swoosh");
    if (isMultiLink) {
      void enqueueChain();
      return;
    }
    void enqueueGeneration();
  }

  async function onSubmitPlus() {
    playSound("swoosh");
    if (isMultiLink) {
      try {
        await createNextVersion();
      } catch (e) {
        await showMessage(String(e), { kind: "error" });
        return;
      }
      void enqueueChain();
      return;
    }
    void runIntoNewVersion();
  }

  const queueTitle =
    queueCount === 0
      ? "No active jobs"
      : activeJobs
          .map(
            (j) =>
              `${j.modelName} · ${seqShotNames(j.shotPath).shot}/${j.targetVersion} · ${j.progressMessage}`,
          )
          .join("\n");

  const btn =
    "bg-src-bg text-accent font-mono text-xs px-3 py-2 hover:opacity-80 w-full text-center";
  const btnDisabled =
    "bg-src-bg text-accent font-mono text-xs px-3 py-2 opacity-40 cursor-not-allowed w-full text-center";

  return (
    <div className="bg-surface border border-border p-prompt-column text-text flex flex-col items-center gap-prompt-column-gap shrink-0 w-[110px]">
      <button
        onClick={resetGenerationForm}
        className={`${btn} mb-1`}
        title="Reset prompts, settings, refs, iterations"
      >
        [RESET]
      </button>

      <span className="text-xs font-semibold mt-2">ITERATIONS</span>
      <input
        type="number"
        min={1}
        value={iterations}
        onChange={(e) => setIterations(parseInt(e.currentTarget.value, 10))}
        className="w-full text-center bg-src-bg text-text py-[2px]"
      />

      <button
        title={disabledReason || "Submit"}
        disabled={!canRun}
        onClick={() => void onSubmit()}
        className={canRun ? btn : btnDisabled}
      >
        {showCount ? `[SUBMIT ${runCount}]` : "[SUBMIT]"}
      </button>
      <button
        title={disabledReason || "Submit + new version"}
        disabled={!canRunPlus}
        onClick={() => void onSubmitPlus()}
        className={canRunPlus ? btn : btnDisabled}
      >
        {showCount ? `[SUBMIT+ ${runCount}]` : "[SUBMIT+]"}
      </button>

      {costEstimate != null && (
        <span
          className="text-xs font-mono text-dim cursor-help"
          title="Estimated cost from fal.ai's published prices (fetched in Settings). Actual billing may differ."
        >
          ≈ ${formatCost(costEstimate)}
        </span>
      )}
      {costEstimate == null && costLabel && (
        <span
          className="text-[11px] font-mono text-dim text-center cursor-help"
          title={`${costLabel} — output-dependent, no fixed total. Fetched from fal.ai.`}
        >
          {costLabel.length > 40 ? "priced by output ⓘ" : costLabel}
        </span>
      )}

      {queueCount > 0 && (
        <span
          className="text-xs font-mono bg-bg text-text px-1 py-[1px] cursor-help"
          title={queueTitle}
        >
          Q: {queueCount}
        </span>
      )}

      <button
        title={
          queueCount > 0 ? `Cancel all (${queueCount})` : "Nothing to cancel"
        }
        disabled={queueCount === 0}
        onClick={cancelAllGenerations}
        className={queueCount > 0 ? btn : btnDisabled}
      >
        [CANCEL]
      </button>
    </div>
  );
}
