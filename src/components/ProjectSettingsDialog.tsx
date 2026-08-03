import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import {
  showMessage,
  confirmAction,
  pickDirectory,
  pickFile,
} from "../lib/dialog";
import { useScriptStore } from "../stores/scriptStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTagsStore } from "../stores/tagsStore";
import { normalizeTitle, parseScript } from "../lib/script";
import { ModalDialog } from "./ModalDialog";
import type { Config, ReconcileReport } from "../lib/types";

type Props = {
  onClose: () => void;
};

const FILENAME_TEMPLATE_DEFAULT =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

const VERSION_PREFIX_DEFAULT = "gen";
const VERSION_PREFIX_RE = /^[A-Za-z][A-Za-z_-]*$/;

function withAssetsHeader(raw: string): string {
  const hasAssets = /^#\s+ASSETS\b/i.test(raw.trimStart());
  return hasAssets ? raw : "# ASSETS\n\n" + raw;
}

export function ProjectSettingsDialog({ onClose }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
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
      panelClassName="relative max-w-[720px] w-full shadow-xl"
    >
      <div className="px-4 py-2 bg-surface text-text text-sm">
        Project Settings
      </div>

      <div className="p-4 flex flex-col gap-4 max-h-[75vh] overflow-y-auto thin-scroll">
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
              placeholder={FILENAME_TEMPLATE_DEFAULT}
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
            <code>&lt;seed&gt;</code> <code>&lt;provider&gt;</code>
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
