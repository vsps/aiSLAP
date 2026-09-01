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
import { CollapsibleSection } from "../CollapsibleSection";
import { CostSettings } from "../CostSettings";
import { SankeyChart } from "../SankeyChart";
import { useCostReportStore } from "../../stores/costReportStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { ProjectCostScan } from "../../lib/types";

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
  const [costBusy, setCostBusy] = useState(false);
  const [costReconcileBusy, setCostReconcileBusy] = useState(false);
  const [costReconcileStatus, setCostReconcileStatus] = useState<string | null>(null);

  // Filterable per-image report + Sankey breakdown. Lives in a store (not
  // local state) so it survives leaving and returning to AUDIT — see
  // costReportStore.ts for why (it's a full walk, not disk-cached like the
  // totals below, so it can't just be reloaded cheaply on mount).
  const reportData = useCostReportStore((s) => s.reportData);
  const setReportData = useCostReportStore((s) => s.setReportData);
  const reportFilter = useCostReportStore((s) => s.reportFilter);
  const setReportFilter = useCostReportStore((s) => s.setReportFilter);
  const [reportBusy, setReportBusy] = useState(false);

  // The cost tree, unlike the per-image report, IS cheaply disk-cached
  // (project_cost_scan already persists shot/sequence totals into their
  // sidecars) — load the last computed numbers as soon as the project is
  // known, so the page shows real data immediately instead of "not yet
  // calculated" until Recalculate is clicked every session.
  useEffect(() => {
    if (!projectPath) return;
    void cmd
      .project_cost_scan_cached(projectPath)
      .then(setCostScan)
      .catch(() => {});
  }, [projectPath]);

  async function recalculateCosts() {
    if (!projectPath) return;
    setCostBusy(true);
    try {
      setCostScan(await cmd.project_cost_scan(projectPath));
      // The scan just walked the disk and may have backfilled costUsd —
      // refresh the report too so it never silently disagrees with the tree.
      if (reportData !== null) {
        setReportData(await cmd.project_cost_lines(projectPath));
      }
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setCostBusy(false);
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

  async function generateReport() {
    if (!projectPath) return;
    setReportBusy(true);
    try {
      setReportData(await cmd.project_cost_lines(projectPath));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setReportBusy(false);
    }
  }

  const filteredLines = useMemo(
    () => (reportData ? applyFilter(reportData.lines, reportFilter) : []),
    [reportData, reportFilter],
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
    () => (reportData ? discoverUsers(reportData.lines) : []),
    [reportData],
  );
  const reportModels = useMemo(
    () => (reportData ? discoverModels(reportData.lines) : []),
    [reportData],
  );
  const reportSummary = useMemo(() => summarize(filteredLines), [filteredLines]);
  const reportByModel = useMemo(() => costByModel(filteredLines), [filteredLines]);
  const reportByUser = useMemo(() => costByUser(filteredLines), [filteredLines]);
  const sankeyData = useMemo(() => buildSankeyData(filteredLines), [filteredLines]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll p-4 flex flex-col gap-4 bg-panel border border-border">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            Project costs
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
              disabled={costReconcileBusy || !projectPath}
              title="Look up fal's billing-events API for the real amount charged for each generation, replacing the estimate below. Needs a fal key with billing-events access."
              onClick={reconcileCosts}
            >
              {costReconcileBusy ? "Reconciling…" : "Reconcile actual"}
            </button>
            <button
              type="button"
              className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
              disabled={costBusy || !projectPath}
              onClick={recalculateCosts}
            >
              {costBusy ? "Calculating…" : "Recalculate"}
            </button>
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
            Not yet calculated. Computed from cached fal prices (Cost settings,
            below); older images without a stored cost are backfilled
            automatically when a price is available.
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
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            Reports
          </div>
          <button
            type="button"
            className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
            disabled={reportBusy || !projectPath}
            onClick={generateReport}
          >
            {reportBusy ? "Generating…" : "Generate report"}
          </button>
        </div>

        {reportData === null ? (
          <div className="text-xs text-dim">
            Per-user / per-model breakdown and a Sankey cost flow (Total →
            Sequence → Shot → Version). For the most complete numbers, run
            Recalculate above first.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <span className="text-xs text-dim">User:</span>
                <div className="flex flex-wrap gap-1">
                  {reportUsers.map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() =>
                        setReportFilter((f) => ({
                          ...f,
                          user: f.user === u ? null : u,
                        }))
                      }
                      className={`px-1.5 py-[1px] text-xs border ${
                        reportFilter.user === u
                          ? "bg-accent text-bg border-accent"
                          : "bg-bg border-dim hover:bg-panel"
                      }`}
                    >
                      {u}
                    </button>
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
              <button
                type="button"
                className="ml-auto px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
                disabled={filteredLines.length === 0}
                title="Export the rows currently shown (respects the user/model filter above) as CSV."
                onClick={exportReportCsv}
              >
                Export CSV
              </button>
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
      <CollapsibleSection label="Cost settings">
        <CostSettings />
      </CollapsibleSection>
    </div>
  );
}
