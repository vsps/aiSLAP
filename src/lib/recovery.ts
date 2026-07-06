import { cmd } from "./tauri";
import { joinPath } from "./paths";
import { pushLog } from "../stores/logStore";
import { useModelsStore } from "../stores/modelsStore";
import { useSessionStore } from "../stores/sessionStore";
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

  // After we wrote files into a version dir for the currently-open shot,
  // rescan so the gallery picks them up.
  const sess = useSessionStore.getState();
  if (sess.shotPath && result.recovered > 0) {
    await sess.rescanShot();
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

  const ctx: DownloadCtx = {
    out,
    node,
    sequencePrompt: rec.sequencePrompt,
    shotPrompt: rec.shotPrompt,
    shotPrompts: rec.shotPrompts,
    combinedPrompt: rec.combinedPrompt,
    settings: rec.settings,
    refs: [], // no upload URLs on recovery
    refSnapshots: rec.refs,
    shotPath: rec.shotPath,
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
