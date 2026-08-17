import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import {
  showMessage,
  confirmAction,
  pickDirectory,
  pickFile,
  pickSaveFile,
} from "../lib/dialog";
import { useScriptStore } from "../stores/scriptStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTagsStore } from "../stores/tagsStore";
import { useCostReportStore } from "../stores/costReportStore";
import { normalizeTitle, parseScript } from "../lib/script";
import { formatCost } from "../lib/falPrices";
import { DEFAULT_FILENAME_TEMPLATE } from "../lib/generation/output";
import {
  applyFilter,
  costByModel,
  costByUser,
  discoverModels,
  discoverUsers,
  buildSankeyData,
  linesToCsv,
  summarize,
} from "../lib/costReport";
import { SankeyChart } from "./SankeyChart";
import { ModalDialog } from "./ModalDialog";
import type { Config, ProjectCostScan, ReconcileReport } from "../lib/types";

type Props = {
  onClose: () => void;
};

const TABS = ["General", "Costs"] as const;
type Tab = (typeof TABS)[number];

const VERSION_PREFIX_DEFAULT = "gen";
const VERSION_PREFIX_RE = /^[A-Za-z][A-Za-z_-]*$/;

function withAssetsHeader(raw: string): string {
  const hasAssets = /^#\s+ASSETS\b/i.test(raw.trimStart());
  return hasAssets ? raw : "# ASSETS\n\n" + raw;
}

export function ProjectSettingsDialog({ onClose }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const [tab, setTab] = useState<Tab>("General");
  const scriptRaw = useScriptStore((s) => s.raw);
  const saveScript = useScriptStore((s) => s.save);
  const defs = useTagsStore((s) => s.defs);
  const [config, setConfig] = useState<Config | null>(null);
  const [script, setScript] = useState(scriptRaw);
  const [busy, setBusy] = useState(false);
  const [versionPrefix, setVersionPrefix] = useState<string>(
    VERSION_PREFIX_DEFAULT,
  );
  const [versionPrefixOriginal, setVersionPrefixOriginal] = useState<string>(
    VERSION_PREFIX_DEFAULT,
  );

  type PendingShot = { name: string; isNew: boolean };
  type PendingSeq = { seq: string; isNew: boolean; shots: PendingShot[] };
  const [pendingDirs, setPendingDirs] = useState<PendingSeq[] | null>(null);

  // Asset index reconcile
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileReport, setReconcileReport] =
    useState<ReconcileReport | null>(null);

  async function reconcileAssetIndex() {
    if (!projectPath) return;
    setReconcileBusy(true);
    try {
      setReconcileReport(
        await cmd.project_reconcile(projectPath, config?.ffmpegPath ?? ""),
      );
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setReconcileBusy(false);
    }
  }

  // Project costs (moved from SettingsDialog — this is project-scoped data,
  // not app-wide config; fal pricing config itself stays in Settings).
  const [costScan, setCostScan] = useState<ProjectCostScan | null>(null);
  const [costBusy, setCostBusy] = useState(false);
  const [costReconcileBusy, setCostReconcileBusy] = useState(false);
  const [costReconcileStatus, setCostReconcileStatus] = useState<string | null>(null);

  // Filterable per-image report + Sankey breakdown. Lives in a store (not
  // local state) so it survives closing/reopening this dialog — see
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
  // known, so the tab shows real data immediately instead of "not yet
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

  const scriptCounts = useMemo(() => {
    const p = parseScript(script);
    let shots = 0;
    for (const arr of p.shotsByParent.values()) shots += arr.length;
    return { sequences: p.sequences.length, shots };
  }, [script]);

  useEffect(() => {
    void (async () => {
      const c = await cmd.config_load().catch(() => null);
      setConfig(c);
    })();
  }, []);

  useEffect(() => {
    if (!projectPath) return;
    void (async () => {
      const p = await cmd
        .project_version_prefix_get(projectPath)
        .catch(() => VERSION_PREFIX_DEFAULT);
      const initial = p || VERSION_PREFIX_DEFAULT;
      setVersionPrefix(initial);
      setVersionPrefixOriginal(initial);
    })();
  }, [projectPath]);

  const versionPrefixValid = VERSION_PREFIX_RE.test(versionPrefix);
  const versionPrefixDirty = versionPrefix !== versionPrefixOriginal;

  // Export by tag
  const [exportModal, setExportModal] = useState<{
    destDir: string;
    layout: "preserve" | "dump";
    tags: string[];
  } | null>(null);

  async function startExport() {
    if (!projectPath) return;
    const dir = await pickDirectory("Select destination for tagged exports");
    if (!dir) return;
    setExportModal({
      destDir: dir,
      layout: "preserve",
      tags: defs.some((d) => d.name === "select") ? ["select"] : [],
    });
  }

  async function confirmExport() {
    if (!projectPath || !exportModal) return;
    setBusy(true);
    try {
      const count = await cmd.export_by_tag(
        projectPath,
        exportModal.tags,
        "any",
        exportModal.destDir,
        exportModal.layout,
      );
      setExportModal(null);
      await showMessage(`Exported ${count} file(s) to ${exportModal.destDir}`, {
        kind: "info",
      });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setScript(withAssetsHeader(scriptRaw));
  }, [scriptRaw]);

  async function reloadScript() {
    if (!projectPath) return;
    if (script !== scriptRaw) {
      const ok = await confirmAction(
        "Discard unsaved script changes and reload script.md from disk?",
        { title: "Reload script", kind: "warning" },
      );
      if (!ok) return;
    }
    await useScriptStore.getState().loadFor(projectPath);
  }

  async function importScript() {
    const picked = await pickFile("Import script", {
      extensions: ["md", "txt"],
    });
    if (!picked || picked.length === 0) return;
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      setScript(withAssetsHeader(await readTextFile(picked[0])));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  function sanitizeName(name: string): string {
    return [...name]
      .map((c) => ('/\\:*?"<>|'.includes(c) || c.charCodeAt(0) < 32 ? "_" : c))
      .join("");
  }

  async function promptCreateDirs() {
    if (!projectPath) return;
    setBusy(true);
    try {
      const parsed = parseScript(script);
      const seqNames = parsed.sequences.map((s) => s.title);
      const seqPaths = seqNames.map((n) => `${projectPath}/${sanitizeName(n)}`);

      const shotEntries: { seqIdx: number; name: string; path: string }[] = [];
      for (let i = 0; i < parsed.sequences.length; i++) {
        for (const s of parsed.shotsByParent.get(normalizeTitle(seqNames[i])) ??
          []) {
          shotEntries.push({
            seqIdx: i,
            name: s.title,
            path: `${seqPaths[i]}/${sanitizeName(s.title)}`,
          });
        }
      }

      const exists = await cmd.dirs_exist([
        ...seqPaths,
        ...shotEntries.map((e) => e.path),
      ]);
      const seqExists = exists.slice(0, seqPaths.length);
      const shotExists = exists.slice(seqPaths.length);

      const indexedShots = shotEntries.map((e, idx) => ({ ...e, idx }));
      const preview = parsed.sequences.map((seq, i) => ({
        seq: seq.title,
        isNew: !seqExists[i],
        shots: indexedShots
          .filter((e) => e.seqIdx === i)
          .map((e) => ({ name: e.name, isNew: !shotExists[e.idx] })),
      }));
      setPendingDirs(preview);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreateDirs() {
    if (!projectPath || !pendingDirs) return;
    setPendingDirs(null);
    setBusy(true);
    try {
      let newSeqs = 0;
      let newShots = 0;
      for (const { seq, isNew: seqIsNew, shots } of pendingDirs) {
        const seqPath = await cmd.sequence_create(projectPath, seq);
        if (seqIsNew) newSeqs++;
        for (const { name, isNew: shotIsNew } of shots) {
          await cmd.shot_create(seqPath, name);
          if (shotIsNew) newShots++;
        }
      }
      const sequences = await cmd.project_open(projectPath);
      useSessionStore.setState({ sequencesInProject: sequences });
      const { sequencePath } = useSessionStore.getState();
      if (sequencePath) {
        const { shots } = await cmd.sequence_open(sequencePath);
        useSessionStore.setState({ shotsInSequence: shots });
      }
      await showMessage(`Created ${newSeqs} sequence(s), ${newShots} shot(s)`, {
        kind: "info",
      });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    try {
      await cmd.config_save(config);
      if (projectPath && script !== scriptRaw) {
        await saveScript(projectPath, script);
      }
      if (projectPath && versionPrefixDirty && versionPrefixValid) {
        await cmd.project_version_prefix_set(projectPath, versionPrefix);
        setVersionPrefixOriginal(versionPrefix);
      }
      onClose();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      onClose={onClose}
      padded={false}
      panelClassName="relative w-[980px] h-[88vh] min-w-[560px] min-h-[400px] max-w-[95vw] max-h-[92vh] resize overflow-auto shadow-xl"
    >
      <div className="px-4 py-2 bg-surface text-text text-sm shrink-0">
        Project Settings
      </div>

      <div className="flex border-b border-dim px-4 shrink-0">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs ${
              tab === t
                ? "text-accent border-b-2 border-accent -mb-px"
                : "text-dim hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto thin-scroll">
        {tab === "General" && (
        <>
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            Filename template
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={config?.filenameTemplate ?? ""}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setConfig((c) =>
                  c ? { ...c, filenameTemplate: value || undefined } : c,
                );
              }}
              disabled={!config}
              className="flex-1 bg-inset px-2 py-1 text-xs font-mono"
              placeholder={DEFAULT_FILENAME_TEMPLATE}
            />
            <button
              type="button"
              className="px-2 bg-bg text-xs"
              onClick={() =>
                setConfig((c) =>
                  c ? { ...c, filenameTemplate: undefined } : c,
                )
              }
            >
              reset
            </button>
          </div>
          <div className="text-xs text-dim mt-1">
            Tokens: <code>&lt;date&gt;</code> <code>&lt;time&gt;</code>{" "}
            <code>&lt;sequence&gt;</code> <code>&lt;shot&gt;</code>{" "}
            <code>&lt;model&gt;</code> <code>&lt;version&gt;</code>{" "}
            <code>&lt;prompt&gt;</code> <code>&lt;iter&gt;</code>{" "}
            <code>&lt;seed&gt;</code> <code>&lt;provider&gt;</code>{" "}
            <code>&lt;minor&gt;</code> <code>&lt;rnd&gt;</code>
          </div>
          <div className="text-xs text-dim">
            <code>&lt;minor&gt;</code> counts up within one version column and
            never reuses a number, so it keeps running across generations.{" "}
            <code>&lt;rnd&gt;</code> is a random five-letter word, rerolled for
            every occurrence and every file.
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            Version folder prefix
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={versionPrefix}
              onChange={(e) => setVersionPrefix(e.currentTarget.value)}
              disabled={!projectPath}
              className="flex-1 bg-inset px-2 py-1 text-xs font-mono"
              placeholder={VERSION_PREFIX_DEFAULT}
              spellCheck={false}
            />
            <button
              type="button"
              className="px-2 bg-bg text-xs"
              onClick={() => setVersionPrefix(VERSION_PREFIX_DEFAULT)}
            >
              reset
            </button>
          </div>
          <div className="text-xs text-dim mt-1">
            {versionPrefixValid ? (
              <>
                Next folder:{" "}
                <code>
                  {versionPrefix}
                  001
                </code>
                . Letters only (<code>_</code> / <code>-</code> allowed); a
                3-digit number is appended automatically. Existing folders are
                not renamed.
              </>
            ) : (
              <span className="text-red-500">
                Prefix must start with a letter; allowed chars: A–Z, a–z,{" "}
                <code>_</code>, <code>-</code>.
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-dim uppercase tracking-wide">
              Script (script.md)
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
                disabled={!projectPath}
                onClick={reloadScript}
              >
                Reload
              </button>
              <button
                type="button"
                className="px-2 py-0.5 bg-bg text-xs"
                onClick={importScript}
              >
                Import…
              </button>
            </div>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.currentTarget.value)}
            disabled={!projectPath}
            spellCheck={false}
            className="min-h-[260px] max-h-[40vh] w-full resize-y bg-inset text-text p-prompt-panel outline-none font-mono text-xs thin-scroll"
            placeholder="# Sequence 1&#10;&#10;## Shot 1&#10;..."
          />
          <div className="text-xs text-dim">
            Detected: {scriptCounts.sequences} sequence(s), {scriptCounts.shots}{" "}
            shot(s). <code>#</code> headings populate the SEQUENCE dropdown;{" "}
            <code>##</code> under the current sequence populate the SHOT
            dropdown. Body text below each heading appears above the matching
            prompt column.
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-dim uppercase tracking-wide">
              Asset index
            </div>
            <button
              type="button"
              className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
              disabled={reconcileBusy || !projectPath}
              onClick={reconcileAssetIndex}
            >
              {reconcileBusy ? "Scanning…" : "Reconcile"}
            </button>
          </div>
          <div className="text-xs text-dim">
            Scans every generated file: assigns an id to anything from before
            asset identity existed, and relinks files moved since the last scan.
            Runs automatically on project open — use this after moving files
            around outside the app.
          </div>
          {reconcileReport && (
            <div className="text-xs font-mono text-text">
              Scanned {reconcileReport.scanned} · backfilled{" "}
              {reconcileReport.sidecarBackfilled} · ingested{" "}
              {reconcileReport.dbIngested} · relinked {reconcileReport.relinked}{" "}
              · tags {reconcileReport.tagsSynced}
            </div>
          )}
        </div>

        <TagManager />
        </>
        )}

        {tab === "Costs" && (
        <>
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
              Not yet calculated. Computed from cached fal prices (Settings →
              APIs); older images without a stored cost are backfilled
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
        </>
        )}
      </div>

      <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
        <button className="px-3 py-1 bg-bg text-xs" onClick={onClose}>
          Cancel
        </button>
        <button
          className="px-3 py-1 bg-bg text-xs disabled:opacity-50"
          disabled={busy || !projectPath || scriptCounts.sequences === 0}
          onClick={promptCreateDirs}
        >
          CREATE DIRS
        </button>
        <button
          className="px-3 py-1 bg-bg text-xs disabled:opacity-50"
          disabled={busy || !projectPath}
          onClick={startExport}
        >
          EXPORT BY TAG
        </button>
        <button
          className="px-3 py-1 bg-accent text-bg text-xs disabled:opacity-50"
          disabled={busy || !config || !versionPrefixValid}
          onClick={save}
        >
          Save
        </button>
      </div>

      {exportModal && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6">
          <div className="bg-panel border border-dim shadow-xl w-full max-w-sm flex flex-col">
            <div className="px-4 py-2 bg-surface text-text text-sm">
              Export by tag
            </div>
            <div className="px-4 py-3 flex flex-col gap-3 text-xs">
              <div>
                <div className="text-dim mb-1">Destination:</div>
                <div className="font-mono truncate text-text">
                  {exportModal.destDir}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-dim mb-1">
                  Tags{" "}
                  <span className="opacity-60">
                    (none selected = everything tagged)
                  </span>
                  :
                </div>
                <div className="flex flex-wrap gap-1">
                  {defs.length === 0 && (
                    <span className="text-dim">No tags in this project.</span>
                  )}
                  {defs.map((d) => {
                    const on = exportModal.tags.includes(d.name);
                    return (
                      <button
                        key={d.name}
                        type="button"
                        onClick={() =>
                          setExportModal({
                            ...exportModal,
                            tags: on
                              ? exportModal.tags.filter((t) => t !== d.name)
                              : [...exportModal.tags, d.name],
                          })
                        }
                        className={`flex items-center gap-1 px-1.5 py-[1px] border ${
                          on
                            ? "bg-accent text-bg border-accent"
                            : "bg-bg border-dim hover:bg-panel"
                        }`}
                      >
                        <span
                          className="w-[6px] h-[6px]"
                          style={{ background: d.color }}
                        />
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-dim mb-1">Layout:</div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={exportModal.layout === "preserve"}
                    onChange={() =>
                      setExportModal({ ...exportModal, layout: "preserve" })
                    }
                  />
                  <span>Preserve folders</span>
                  <span className="text-dim">(dest/SEQ/SHOT/VERSION)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={exportModal.layout === "dump"}
                    onChange={() =>
                      setExportModal({ ...exportModal, layout: "dump" })
                    }
                  />
                  <span>Dump in one folder</span>
                  <span className="text-dim">
                    (files prefixed with seq_shot_)
                  </span>
                </label>
              </div>
            </div>
            <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
              <button
                className="px-3 py-1 bg-bg text-xs"
                onClick={() => setExportModal(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 bg-accent text-bg text-xs"
                onClick={confirmExport}
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDirs && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6">
          <div className="bg-panel border border-dim shadow-xl w-full max-w-sm flex flex-col">
            <div className="px-4 py-2 bg-surface text-text text-sm">
              Create directories?
            </div>
            <ul className="px-4 py-3 font-mono text-xs overflow-y-auto max-h-64 thin-scroll flex flex-col gap-0.5">
              {pendingDirs.map(({ seq, isNew: seqIsNew, shots }) => (
                <li key={seq}>
                  <span className={seqIsNew ? "text-accent" : "text-text"}>
                    {seq}/
                  </span>
                  {shots.map(({ name, isNew: shotIsNew }) => (
                    <div
                      key={name}
                      className={`pl-4 ${shotIsNew ? "text-accent" : "text-dim"}`}
                    >
                      {name}/
                    </div>
                  ))}
                </li>
              ))}
            </ul>
            <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
              <button
                className="px-3 py-1 bg-bg text-xs"
                onClick={() => setPendingDirs(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 bg-accent text-bg text-xs"
                onClick={confirmCreateDirs}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}

/** Rename / recolor / delete the project's tags. Renaming and deleting
 *  rewrite every affected sidecar, so both are confirmed before they run. */
function TagManager() {
  const projectPath = useSessionStore((s) => s.projectPath);
  const defs = useTagsStore((s) => s.defs);
  const renameTag = useTagsStore((s) => s.renameTag);
  const deleteTag = useTagsStore((s) => s.deleteTag);
  const setColor = useTagsStore((s) => s.setColor);
  const loadDefs = useTagsStore((s) => s.loadDefs);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    draft: string;
  } | null>(null);
  const [reindexed, setReindexed] = useState<number | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function commitRename() {
    if (!editing) return;
    const next = editing.draft.trim();
    const from = editing.name;
    setEditing(null);
    if (!next || next === from) return;
    await run(() => renameTag(from, next));
  }

  async function removeTag(name: string) {
    const ok = await confirmAction(
      `Remove the "${name}" tag from every image in this project?`,
      { title: "Delete tag", kind: "warning" },
    );
    if (ok) await run(() => deleteTag(name));
  }

  async function reindex() {
    if (!projectPath) return;
    await run(async () => {
      setReindexed(await cmd.project_tags_reindex(projectPath));
      // Reindex repairs the vocabulary from the sidecars too — pull it back,
      // and refresh the gallery so the dots pick up their colors.
      await loadDefs(projectPath);
      await useSessionStore.getState().rescanShot();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Tags
        </div>
        <button
          type="button"
          className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
          disabled={busy || !projectPath}
          onClick={reindex}
        >
          {busy ? "Working…" : "Rebuild tag index"}
        </button>
      </div>
      <div className="text-xs text-dim">
        Tags live in each image's <code>.json</code> sidecar, so they follow the
        file when it's copied, moved, or renamed. Rebuilding re-reads those
        sidecars into the local index and re-derives the tag list below from
        them — cheaper than a full reconcile, and the fix if tags ever look out
        of date or the list here looks empty.
      </div>
      {reindexed !== null && (
        <div className="text-xs font-mono text-text">
          Reindexed {reindexed} tagged file(s)
        </div>
      )}
      {defs.length === 0 ? (
        <div className="text-xs text-dim">
          No tags yet — add one from any thumbnail.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {defs.map((d) => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <input
                type="color"
                value={d.color || "#9b31f2"}
                disabled={busy}
                onChange={(e) =>
                  void run(() => setColor(d.name, e.target.value))
                }
                title={`Color for "${d.name}"`}
                className="w-5 h-5 bg-inset border border-dim p-0 cursor-pointer"
              />
              {editing?.name === d.name ? (
                <input
                  autoFocus
                  value={editing.draft}
                  disabled={busy}
                  onChange={(e) =>
                    setEditing({ name: d.name, draft: e.target.value })
                  }
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="flex-1 min-w-0 bg-inset px-1 py-[1px] outline-none"
                />
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing({ name: d.name, draft: d.name })}
                  title="Rename (rewrites every sidecar using this tag)"
                  className="flex-1 min-w-0 text-left px-1 py-[1px] truncate hover:bg-panel"
                >
                  {d.name}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeTag(d.name)}
                className="px-1.5 py-[1px] bg-bg hover:bg-panel disabled:opacity-50"
              >
                DELETE
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
