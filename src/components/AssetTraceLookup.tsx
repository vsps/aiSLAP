import { useSyncExternalStore } from "react";
import { pickFile, showMessage } from "../lib/dialog";
import { formatBytes } from "../lib/format";
import { formatCost } from "../lib/falPrices";
import { getOsDragTarget, subscribeOsDragTarget } from "../lib/osDragDrop";
import { cmd } from "../lib/tauri";
import { useAssetTraceStore } from "../stores/assetTraceStore";
import type { AssetTrace, TraceMatch } from "../lib/types";
import { Btn } from "./Btn";

/**
 * "Where did this file come from?"
 *
 * The audit counterpart to the cost tree above it: a file turns up somewhere —
 * a client's download folder, a share, an editor's timeline — with no sidecar
 * beside it, and the question is which project, which generation, and whose.
 *
 * The answer comes from `asset_trace`, which searches *every* index on this
 * machine plus the shared Turso db, not the project currently open. Nothing
 * here writes: the file is read, hashed and reported on, never moved.
 */
export function AssetTraceLookup() {
  const trace = useAssetTraceStore((s) => s.trace);
  const busy = useAssetTraceStore((s) => s.busy);
  const error = useAssetTraceStore((s) => s.error);
  const run = useAssetTraceStore((s) => s.run);
  const clear = useAssetTraceStore((s) => s.clear);

  // Same app-level OS drag listener the gallery columns use; `data-trace-drop`
  // below is the marker it hit-tests against.
  const osDragHit = useSyncExternalStore(subscribeOsDragTarget, getOsDragTarget);
  const dragOver = osDragHit?.kind === "trace";

  async function choose() {
    const picked = await pickFile("Look up a file");
    if (picked?.[0]) await run(picked[0]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-white uppercase tracking-wide">
          File lookup
        </div>
        <div className="flex items-center gap-1">
          {trace && (
            <Btn onClick={clear}>
              Clear
            </Btn>
          )}
          <Btn disabled={busy} onClick={choose}>
            {busy ? "Looking up…" : "Choose file…"}
          </Btn>
        </div>
      </div>

      <div
        data-trace-drop
        className={`border border-dashed px-3 py-4 text-xs text-center ${
          dragOver ? "border-accent text-accent" : "border-dim text-dim"
        }`}
      >
        Drop a file here to trace it back to the project, generation and user
        that made it. Works without its sidecar, and across every project this
        machine has opened.
      </div>

      {error && <div className="text-xs text-red-500 font-mono">{error}</div>}
      {trace && <TraceResult trace={trace} />}
    </div>
  );
}

function TraceResult({ trace }: { trace: AssetTrace }) {
  const hashMismatch =
    trace.sidecarContentHash !== undefined &&
    trace.contentHash !== undefined &&
    trace.sidecarContentHash !== trace.contentHash;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="text-text font-semibold">{trace.fileName}</span>
        <span className="text-dim">{formatBytes(trace.sizeBytes)}</span>
        <Btn title={trace.path} onClick={() => void cmd.reveal_in_explorer(trace.path)}>
          Reveal
        </Btn>
      </div>

      <ul className="font-mono text-[11px] text-dim flex flex-col gap-0.5">
        <li>
          embedded id:{" "}
          <span className="text-text">{trace.embeddedAssetId ?? "none"}</span>
          {trace.embeddedProjectId && (
            <> · project {trace.embeddedProjectId}</>
          )}
        </li>
        <li>
          sidecar:{" "}
          <span className="text-text">
            {trace.sidecarFound
              ? (trace.sidecarAssetId ?? "found, no assetId")
              : "none"}
          </span>
        </li>
        <li>
          sha256: <span className="text-text">{trace.contentHash ?? "—"}</span>
        </li>
        {hashMismatch && (
          // The bytes were edited after the sidecar was written — worth
          // saying out loud, since every hash match below is then against
          // the *old* content.
          <li className="text-red-500">
            bytes differ from the hash its sidecar records ({trace.sidecarContentHash})
          </li>
        )}
      </ul>

      {trace.matches.length === 0 ? (
        <div className="text-xs text-dim">
          No match. Nothing in {trace.indexesSearched} local{" "}
          {trace.indexesSearched === 1 ? "index" : "indexes"}
          {trace.remoteSearched ? " or the shared database" : ""} knows this
          file — by id, by content, or by name.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {trace.matches.map((m) => (
            <MatchCard key={`${m.source}-${m.asset.id}`} match={m} />
          ))}
        </div>
      )}

      <div className="text-[11px] text-dim">
        Searched {trace.indexesSearched} local{" "}
        {trace.indexesSearched === 1 ? "index" : "indexes"}
        {trace.remoteSearched
          ? " + the shared database"
          : trace.remoteError
            ? ` · shared database unreachable: ${trace.remoteError}`
            : " · no shared database configured"}
        .
      </div>
    </div>
  );
}

const MATCH_LABEL: Record<TraceMatch["matchedBy"], string> = {
  assetId: "embedded id",
  contentHash: "content hash",
  fileName: "file name only",
};

function MatchCard({ match }: { match: TraceMatch }) {
  const { asset } = match;
  // Bound once so the reveal handler closes over a definite string rather
  // than re-narrowing an optional inside a callback.
  const originalPath = match.originalPath;
  // A name match is a guess — same name, possibly nothing else in common —
  // so it must not look like the other two, which are proof.
  const weak = match.matchedBy === "fileName";

  return (
    <div className="border border-dim bg-bg px-2 py-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={`rounded-full px-1.5 py-[1px] ${weak ? "bg-panel text-dim border border-dim" : "bg-accent text-on-accent"}`}
        >
          {MATCH_LABEL[match.matchedBy]}
        </span>
        <span className="rounded-full px-1.5 py-[1px] bg-panel text-dim border border-dim">
          {match.source === "remote" ? "shared db" : "this machine"}
        </span>
        {match.tags.map((t) => (
          <span
            key={t}
            className="rounded-full px-1.5 py-[1px] bg-inset text-dim"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="font-mono text-xs text-text">
        {match.projectTitle ?? asset.projectId ?? "unknown project"}
        <span className="text-dim"> / {asset.relPath}</span>
      </div>

      <ul className="font-mono text-[11px] text-dim flex flex-col gap-0.5">
        <li>
          user: <span className="text-text">{asset.generatedBy ?? "—"}</span>
          {" · "}
          {new Date(asset.createdAt).toLocaleString()}
          {asset.costUsd !== undefined && ` · ≈ $${formatCost(asset.costUsd)}`}
        </li>
        <li>
          model:{" "}
          <span className="text-text">{asset.modelId ?? asset.endpoint ?? "—"}</span>
          {asset.provider && <> · {asset.provider}</>}
          {match.refs.length > 0 && (
            <>
              {" · "}
              {match.refs.length} ref{match.refs.length === 1 ? "" : "s"}
            </>
          )}
        </li>
        {asset.combinedPrompt && (
          <li className="text-text whitespace-pre-wrap break-words max-h-24 overflow-y-auto thin-scroll">
            {asset.combinedPrompt}
          </li>
        )}
        {originalPath && (
          <li className="flex items-center gap-2">
            <span className="truncate" title={originalPath}>
              {match.originalExists
                ? "original in place"
                : "not at its indexed path any more"}
            </span>
            {match.originalExists && (
              <Btn
                className="shrink-0"
                onClick={() =>
                  void cmd
                    .reveal_in_explorer(originalPath)
                    .catch((e) => showMessage(String(e), { kind: "error" }))
                }
              >
                Reveal original
              </Btn>
            )}
          </li>
        )}
        {!match.projectRoot && (
          // Every asset row carries a project id; only a project this machine
          // has opened has a folder to point at.
          <li>project id {asset.projectId ?? "—"} — not on this machine</li>
        )}
      </ul>
    </div>
  );
}
