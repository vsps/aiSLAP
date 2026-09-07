import { useEffect, useMemo, useState } from "react";
import { cmd } from "../../lib/tauri";
import { pickSaveFile, showMessage } from "../../lib/dialog";
import { formatCost } from "../../lib/falPrices";
import {
  applyFilter,
  costByModel,
  costByUser,
  discoverModels,
  discoverUsers,
  buildSankeyData,
  linesToCsv,
  summarize,
} from "../../lib/costReport";
import { AssetTraceLookup } from "../AssetTraceLookup";
import { CollapsibleSection } from "../CollapsibleSection";
import { CostSettings } from "../CostSettings";
import { SankeyChart } from "../SankeyChart";
import { useCostReportStore } from "../../stores/costReportStore";
import { useModelsStore } from "../../stores/modelsStore";
import { useSessionStore } from "../../stores/sessionStore";
import { pushLog } from "../../stores/logStore";
import type { ProjectCostScan } from "../../lib/types";
import { Btn } from "../Btn";
import { Chip } from "../Chip";

/**
 * Costs, usage and reports.
 *
 * Gathers what used to be split across two modals: the project cost tree and
 * the per-image report from Project settings, and the model price table from
 * Settings. They were always one subject read in two places — a price override
 * set in one dialog only showed up in the other's totals.
 */
export function AuditMode() {
  const projectPath = useSessionStore((s) => s.projectPath);
  const [costScan, setCostScan] = useState<ProjectCostScan | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [costReconcileBusy, setCostReconcileBusy] = useState(false);
  const [costReconcileStatus, setCostReconcileStatus] = useState<string | null>(null);

  // Filterable per-image report + Sankey breakdown. Lives in a store (not
  // local state) so it survives leaving and returning to AUDIT — see
  // costReportStore.ts. It is loaded once per project by the effect below;
  // the store is what stops a mode switch from paying for that twice.
  const reportData = useCostReportStore((s) => s.reportData);
  const reportProject = useCostReportStore((s) => s.reportProject);
  const setReportData = useCostReportStore((s) => s.setReportData);
  const reportFilter = useCostReportStore((s) => s.reportFilter);
  const setReportFilter = useCostReportStore((s) => s.setReportFilter);
  const [reportBusy, setReportBusy] = useState(false);
  const modelEntries = useModelsStore((s) => s.entries);

  // The cost tree, unlike the per-image report, IS cheaply disk-cached
  // (project_cost_scan already persists shot/sequence totals into their
  // sidecars) — load the last computed numbers as soon as the project is
  // known, so the page shows real data immediately instead of an empty
  // state until BACKFILL PRICES is clicked again every session.
  useEffect(() => {
    if (!projectPath) return;
    void cmd
      .project_cost_scan_cached(projectPath)
      .then(setCostScan)
      .catch(() => {});
  }, [projectPath]);

  // The per-image report loads itself too. It is not sidecar-cached the way
  // the tree above is, but project_cost_lines now reads the local asset
  // index and only falls back to a sidecar read for files the index has no
  // row for — so on a reconciled project this is one SQL query plus a
  // directory walk, cheap enough to just do. A failure is logged rather than
  // popped: nothing asked for this, and Refresh is still there.
  useEffect(() => {
    if (!projectPath || reportProject === projectPath) return;
    let cancelled = false;
    setReportBusy(true);
    void cmd
      .project_cost_lines(projectPath)
      .then((data) => {
        if (!cancelled) setReportData(data, projectPath);
      })
      .catch((e) => pushLog("ERROR", `Cost report failed to load: ${String(e)}`))
      .finally(() => {
        if (!cancelled) setReportBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, reportProject, setReportData]);

  // Not a read — this is the write path. It walks the project, prices every
  // image that has no costUsd yet (from the cached fal price table plus any
  // overrides, probing video durations where it must), writes that back into
  // the image sidecars, rolls the totals up into the shot/sequence sidecars
  // and pushes the new figures into the asset index. Everything else on this
  // page only ever reads what this produced.
  async function backfillPrices() {
    if (!projectPath) return;
    setBackfillBusy(true);
    try {
      setCostScan(await cmd.project_cost_scan(projectPath));
      // The scan just backfilled costUsd on disk and in the index — refresh
      // the report so it never silently disagrees with the tree.
      setReportData(await cmd.project_cost_lines(projectPath), projectPath);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBackfillBusy(false);
    }
  }

  async function reconcileCosts() {
    if (!projectPath) return;
    setCostReconcileBusy(true);
    setCostReconcileStatus(null);
    try {
      const result = await cmd.reconcile_actual_costs(projectPath);
      setCostReconcileStatus(
        result.checked === 0
          ? "No fal generations awaiting reconciliation."
          : `Reconciled ${result.reconciled} of ${result.checked} requests` +
              (result.unavailable > 0
                ? ` (${result.unavailable} not yet in fal's billing ledger — try again later).`
                : "."),
      );
      if (result.reconciled > 0) setCostScan(await cmd.project_cost_scan(projectPath));
    } catch (e) {
      setCostReconcileStatus(`Error: ${String(e)}`);
    } finally {
      setCostReconcileBusy(false);
    }
  }

  // Manual refresh — the report loads itself on entering AUDIT, so this is
  // for picking up generations made since, and the recovery path if that
  // load failed.
  async function refreshReport() {
    if (!projectPath) return;
    setReportBusy(true);
    try {
      setReportData(await cmd.project_cost_lines(projectPath), projectPath);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setReportBusy(false);
    }
  }

  const modelLabels = useMemo(
    () => new Map(modelEntries.map((e) => [e.node.id, e.node.name])),
    [modelEntries],
  );

  // Lines only count as this project's once the store says so — the report
  // for the previous project stays in memory while the new one loads.
  //
  // The label pass matters because index-sourced lines carry no `model`: the
  // assets table stores modelId only. Resolving from the registry first (not
  // just as a fallback) also keeps one label per modelId regardless of which
  // source a line came from, and follows a model that has since been renamed.
  const reportLines = useMemo(() => {
    if (!reportData || reportProject !== projectPath) return null;
    return reportData.lines.map((l) =>
      l.modelId ? { ...l, model: modelLabels.get(l.modelId) ?? l.model } : l,
    );
  }, [reportData, reportProject, projectPath, modelLabels]);

  const filteredLines = useMemo(
    () => (reportLines ? applyFilter(reportLines, reportFilter) : []),
    [reportLines, reportFilter],
  );

  // Exports exactly what's currently on screen (the active user/model
  // filter already narrowed filteredLines) rather than the full unfiltered
  // report, so the CSV always matches the Sankey/tables the user is looking
  // at when they click it.
  async function exportReportCsv() {
    const target = await pickSaveFile("Export cost report", {
      extensions: ["csv"],
      defaultPath: "cost-report.csv",
    });
    if (!target) return;
    try {
      await cmd.write_text_file(target, linesToCsv(filteredLines));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }
  const reportUsers = useMemo(
    () => (reportLines ? discoverUsers(reportLines) : []),
    [reportLines],
  );
  const reportModels = useMemo(
    () => (reportLines ? discoverModels(reportLines) : []),
    [reportLines],
  );
  const reportSummary = useMemo(() => summarize(filteredLines), [filteredLines]);
  const reportByModel = useMemo(() => costByModel(filteredLines), [filteredLines]);
  const reportByUser = useMemo(() => costByUser(filteredLines), [filteredLines]);
  const sankeyData = useMemo(() => buildSankeyData(filteredLines), [filteredLines]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll p-4 flex flex-col gap-4 bg-panel border border-border">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="text-xs font-bold text-white uppercase tracking-wide">
            Project costs
          </div>
          <div className="flex items-center gap-1">
            <Btn
              disabled={costReconcileBusy || !projectPath}
              title="Look up fal's billing-events API for the real amount charged for each generation, replacing the estimate below. Needs a fal key with billing-events access."
              onClick={reconcileCosts}
            >
              {costReconcileBusy ? "Reconciling…" : "Reconcile actual"}
            </Btn>
            <Btn
              disabled={backfillBusy || !projectPath}
              title="Price every image that has no cost yet, from the cached fal prices and overrides in Cost settings, and write it into the sidecars. The totals on this page are read back from what this writes."
              onClick={backfillPrices}
            >
              {backfillBusy ? "BACKFILLING…" : "BACKFILL PRICES"}
            </Btn>
          </div>
        </div>
        {costReconcileStatus && (
          <div className="text-xs text-dim">{costReconcileStatus}</div>
        )}

        {!projectPath ? (
          <div className="text-xs text-dim">
            Open a project to see its cost breakdown.
          </div>
        ) : costScan === null ? (
          <div className="text-xs text-dim">
            Nothing priced yet. Run BACKFILL PRICES to compute costs from the
            cached fal prices (Cost settings, below) for every image that has
            none stored.
          </div>
        ) : (
          <>
            <div className="text-xs font-mono text-text flex items-center gap-2">
              <span className="font-semibold">Project total:</span>
              <span>≈ ${formatCost(costScan.totalCostUsd)}</span>
              {costScan.unknownImageCount > 0 && (
                <span className="text-dim">
                  ({costScan.unknownImageCount} unpriced)
                </span>
              )}
              {costScan.backfilledCount > 0 && (
                <span className="text-dim">
                  (backfilled {costScan.backfilledCount})
                </span>
              )}
            </div>
            <ul className="font-mono text-xs overflow-y-auto thin-scroll max-h-64 flex flex-col gap-0.5 mt-1">
              {costScan.sequences.map((seq) => (
                <li key={seq.path}>
                  <div className="flex items-center gap-2">
                    <span className="text-text">{seq.name}/</span>
                    {seq.totalCostUsd > 0 && (
                      <span
                        className="text-[10px] font-mono text-dim shrink-0"
                        title={
                          seq.unknownImageCount > 0
                            ? `≈ $${formatCost(seq.totalCostUsd)} (${seq.unknownImageCount} unpriced)`
                            : `≈ $${formatCost(seq.totalCostUsd)}`
                        }
                      >
                        ≈ ${formatCost(seq.totalCostUsd)}
                      </span>
                    )}
                  </div>
                  {seq.shots.map((shot) => (
                    <div
                      key={shot.path}
                      className="pl-4 flex items-center gap-2 text-dim"
                    >
                      <span>{shot.name}/</span>
                      {shot.totalCostUsd > 0 && (
                        <span
                          className="text-[10px] font-mono shrink-0"
                          title={
                            shot.unknownImageCount > 0
                              ? `≈ $${formatCost(shot.totalCostUsd)} (${shot.unknownImageCount} unpriced)`
                              : `≈ $${formatCost(shot.totalCostUsd)}`
                          }
                        >
                          ≈ ${formatCost(shot.totalCostUsd)}
                        </span>
                      )}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-dim pt-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-bold text-white uppercase tracking-wide">
            Reports
          </div>
          <Btn disabled={reportBusy || !projectPath} onClick={refreshReport}>
            {reportBusy ? "Refreshing…" : "Refresh"}
          </Btn>
        </div>

        {reportLines === null ? (
          <div className="text-xs text-dim">
            {reportBusy
              ? "Loading…"
              : "Per-user / per-model breakdown and a Sankey cost flow (Total → Sequence → Shot → Version). Anything still unpriced needs BACKFILL PRICES above."}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <span className="text-xs text-dim">User:</span>
                <div className="flex flex-wrap gap-1">
                  {reportUsers.map((u) => (
                    <Chip
                      key={u}
                      active={reportFilter.user === u}
                      onClick={() =>
                        setReportFilter((f) => ({
                          ...f,
                          user: f.user === u ? null : u,
                        }))
                      }
                    >
                      {u}
                    </Chip>
                  ))}
                  {reportUsers.length === 0 && (
                    <span className="text-xs text-dim">none attributed</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-dim">Model:</span>
                <select
                  value={reportFilter.modelId ?? ""}
                  onChange={(e) => {
                    // Read the value synchronously — React nulls the
                    // synthetic event's fields after the handler returns,
                    // and referencing e.currentTarget inside the setState
                    // updater (invoked later, not during this handler)
                    // crashed with "Cannot read properties of null".
                    const modelId = e.currentTarget.value || null;
                    setReportFilter((f) => ({ ...f, modelId }));
                  }}
                  className="bg-inset text-xs px-1 py-0.5"
                >
                  <option value="">All models</option>
                  {reportModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="text-xs font-mono text-text flex items-center gap-2">
              <span className="font-semibold">Filtered total:</span>
              <span>≈ ${formatCost(reportSummary.totalCostUsd)}</span>
              {reportSummary.unknownCount > 0 && (
                <span className="text-dim">
                  ({reportSummary.unknownCount} unpriced)
                </span>
              )}
              <Btn
                className="ml-auto"
                disabled={filteredLines.length === 0}
                title="Export the rows currently shown (respects the user/model filter above) as CSV."
                onClick={exportReportCsv}
              >
                Export CSV
              </Btn>
            </div>

            <SankeyChart nodes={sankeyData.nodes} links={sankeyData.links} width={900} />

            <div className="flex gap-6 flex-wrap">
              <div className="flex flex-col gap-0.5">
                <div className="text-xs font-semibold text-dim uppercase tracking-wide">
                  By model
                </div>
                <ul className="font-mono text-xs flex flex-col gap-0.5 max-h-40 overflow-y-auto thin-scroll">
                  {reportByModel.map((b) => (
                    <li key={b.key} className="flex items-center gap-2">
                      <span className="text-text">{b.label}</span>
                      <span className="text-dim">≈ ${formatCost(b.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="text-xs font-semibold text-dim uppercase tracking-wide">
                  By user
                </div>
                <ul className="font-mono text-xs flex flex-col gap-0.5 max-h-40 overflow-y-auto thin-scroll">
                  {reportByUser.map((b) => (
                    <li key={b.key} className="flex items-center gap-2">
                      <span className="text-text">{b.label}</span>
                      <span className="text-dim">≈ ${formatCost(b.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="border-t border-dim pt-3">
        <AssetTraceLookup />
      </div>

      <CollapsibleSection label="Cost settings">
        <CostSettings />
      </CollapsibleSection>
    </div>
  );
}
