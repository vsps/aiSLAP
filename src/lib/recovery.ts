import { cmd } from "./tauri";
import { dirname, joinPath } from "./paths";
import { pushLog } from "../stores/logStore";
import { useModelsStore } from "../stores/modelsStore";
import { activeTabId, allTabs } from "../stores/tabsStore";
import { usePricesStore } from "../stores/pricesStore";
import {
  FalProvider,
  falQueueResult,
  falQueueStatus,
} from "./providers/fal";
import {
  downloadAndWrite,
  type DownloadCtx,
} from "./generation/output";
import type { ModelNode, PendingSubmission } from "./types";

export type RecoveryResult = {
  total: number;
  recovered: number;
  stillRunning: number;
  failed: number;
  /** One short line per record we touched, for the log surface. */
  notes: string[];
};

/** Walk `pending.json`, ask each provider what happened, pull down anything
 *  that finished, drop hopeless records, leave still-running ones alone.
 *  Only fal is wired today; replicate records are counted as still-running. */
export async function recoverOrphans(): Promise<RecoveryResult> {
  const records = (await cmd.pending_load().catch(() => [])) as PendingSubmission[];
  const result: RecoveryResult = {
    total: records.length,
    recovered: 0,
    stillRunning: 0,
    failed: 0,
    notes: [],
  };
  if (records.length === 0) return result;

  // Shot paths we actually pulled a file down into, one entry per recovered
  // iteration — so the tab strip can report how many results are waiting, not
  // just that some are.
  const recoveredShots: string[] = [];

  // Prepare fal client once if we have any fal records.
  const hasFal = records.some((r) => r.provider === "fal");
  if (hasFal) {
    try {
      await new FalProvider().prepare();
    } catch (e) {
      pushLog("ERROR", `Orphan recovery: fal not configured — ${String(e)}`);
      result.failed = records.filter((r) => r.provider === "fal").length;
      result.stillRunning = records.length - result.failed;
      return result;
    }
  }

  for (const rec of records) {
    if (rec.provider !== "fal") {
      result.stillRunning++;
      result.notes.push(`${rec.modelName}: replicate recovery not implemented yet`);
      continue;
    }
    try {
      const status = await falQueueStatus(rec.endpoint, rec.requestId);
      if (status === "COMPLETED") {
        const out = await falQueueResult(rec.endpoint, rec.requestId);
        await pullDown(rec, out);
        await cmd.pending_remove(rec.id).catch(() => {});
        recoveredShots.push(rec.shotPath);
        result.recovered++;
        result.notes.push(`Recovered ${rec.modelName} (${rec.iterationIndex}/${rec.iterations})`);
      } else if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
        result.stillRunning++;
        result.notes.push(`Still running: ${rec.modelName} (${rec.iterationIndex}/${rec.iterations})`);
      } else {
        result.stillRunning++;
        result.notes.push(`Status ${status}: ${rec.modelName}`);
      }
    } catch (e) {
      const msg = String(e);
      const notFound =
        /not.?found|404|expired|gone/i.test(msg) ||
        msg.includes("ApplicationException");
      if (notFound) {
        await cmd.pending_remove(rec.id).catch(() => {});
        result.failed++;
        result.notes.push(`Dropped ${rec.modelName}: ${msg.slice(0, 120)}`);
      } else {
        // Transient error — keep the record so the user can retry.
        result.stillRunning++;
        result.notes.push(`Error (kept): ${rec.modelName}: ${msg.slice(0, 120)}`);
      }
    }
  }

  // We wrote files into version dirs across (potentially) several shots.
  // Rescan every tab that has one of them open — recovery runs at boot, while
  // the tabs are still restoring, so "the open shot" is neither single nor
  // settled.
  if (recoveredShots.length > 0) {
    const countByShot = new Map<string, number>();
    for (const shotPath of recoveredShots) {
      countByShot.set(shotPath, (countByShot.get(shotPath) ?? 0) + 1);
    }
    const front = activeTabId();
    await Promise.all(
      allTabs().map(async (tab) => {
        const session = tab.stores.session.getState();
        const shotPath = session.shotPath;
        if (!shotPath) return;
        const recoveredHere = countByShot.get(shotPath);
        if (!recoveredHere) return;
        await session.rescanShot();
        // A file that arrived while the app wasn't even running is as unseen as
        // it gets — except in the tab the user is already looking at, where the
        // rescan above has just put it on screen.
        if (tab.id !== front) {
          tab.stores.generation.getState().noteUnseenOutputs(recoveredHere);
        }
      }),
    );
  }
  return result;
}

async function pullDown(
  rec: PendingSubmission,
  out: Awaited<ReturnType<typeof falQueueResult>>,
): Promise<void> {
  // Resolve the model node from the registry. If it's gone (e.g. removed
  // from disk), synthesise a minimal stand-in from the persisted info so
  // filename/metadata generation still works.
  const live = useModelsStore.getState().findById(rec.modelId);
  const node: ModelNode = live ?? {
    id: rec.modelId,
    name: rec.modelName,
    endpoint: rec.modelEndpoint,
    kind: "image",
    inputs: [],
    outputs: [],
    parameters: [],
    batch_field: rec.batchField,
    provider: rec.modelProvider,
  };

  // The record carries its project root; records written before PRISM support
  // don't, and for those the shot is always project/sequence/shot. Read (never
  // mint) the id here: recovery runs standalone and shouldn't race the normal
  // setProject mint path over the same file.
  const projectPath = rec.projectPath ?? dirname(dirname(rec.shotPath));
  const projectId = await cmd.project_id_get(projectPath).catch(() => null);

  const ctx: DownloadCtx = {
    out,
    node,
    projectId: projectId ?? "",
    sequencePrompt: rec.sequencePrompt,
    shotPrompt: rec.shotPrompt,
    shotPrompts: rec.shotPrompts,
    combinedPrompt: rec.combinedPrompt,
    settings: rec.settings,
    prices: usePricesStore.getState().prices,
    priceOverrides: usePricesStore.getState().overrides,
    refs: [], // no upload URLs on recovery
    refSnapshots: rec.refs,
    shotPath: rec.shotPath,
    projectPath,
    versionDir: joinPath(rec.shotPath, rec.targetVersion),
    targetVersion: rec.targetVersion,
    iterationBase: rec.iterationIndex,
    iterationTotal: rec.iterations,
    expandToIterations: false,
    ffmpegPath: rec.ffmpegPath,
    filenameTemplate: rec.filenameTemplate,
    chain: rec.chain ?? undefined,
  };
  await downloadAndWrite(ctx);
}
