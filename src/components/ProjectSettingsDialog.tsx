import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import {
  showMessage,
  confirmAction,
  pickFile,
} from "../lib/dialog";
import { useScriptStore } from "../stores/scriptStore";
import { useSessionStore } from "../stores/sessionStore";
import { normalizeTitle, parseScript } from "../lib/script";
import { DEFAULT_FILENAME_TEMPLATE } from "../lib/generation/output";
import { ModalDialog } from "./ModalDialog";
import { rebuildProjectThumbs } from "../lib/thumbs";
import type {
  Config,
  ReconcileReport,
  ThumbsReport,
} from "../lib/types";
import { Btn } from "./Btn";

type Props = {
  onClose: () => void;
};

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

  // Thumbnail cache
  const [thumbsBusy, setThumbsBusy] = useState(false);
  const [thumbsReport, setThumbsReport] = useState<ThumbsReport | null>(null);

  async function rebuildThumbs() {
    if (!projectPath) return;
    setThumbsBusy(true);
    setThumbsReport(null);
    try {
      setThumbsReport(await rebuildProjectThumbs(projectPath));
      // Thumbnails the gallery is already showing don't change, but ones it
      // was rendering full-size do — pick them up without a navigation.
      await useSessionStore.getState().rescanShot();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setThumbsBusy(false);
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

      <div className="p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto thin-scroll">
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
            <Btn
              onClick={() =>
                setConfig((c) => (c ? { ...c, filenameTemplate: undefined } : c))
              }
            >
              reset
            </Btn>
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
            <Btn onClick={() => setVersionPrefix(VERSION_PREFIX_DEFAULT)}>
              reset
            </Btn>
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
              <Btn disabled={!projectPath} onClick={reloadScript}>
                Reload
              </Btn>
              <Btn onClick={importScript}>
                Import…
              </Btn>
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
            <Btn disabled={reconcileBusy || !projectPath} onClick={reconcileAssetIndex}>
              {reconcileBusy ? "Scanning…" : "Reconcile"}
            </Btn>
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

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-dim uppercase tracking-wide">
              Thumbnails
            </div>
            <Btn disabled={thumbsBusy || !projectPath} onClick={rebuildThumbs}>
              {thumbsBusy ? "Building…" : "Rebuild"}
            </Btn>
          </div>
          <div className="text-xs text-dim">
            Gallery tiles render small cached copies from{" "}
            <code>.aislap/thumbs</code> instead of the full-resolution files.
            Shots build theirs as you open them; this does the whole project at
            once and clears out entries whose media is gone. Safe to interrupt.
          </div>
          {thumbsReport && (
            <div className="text-xs font-mono text-text">
              Images {thumbsReport.imagesEncoded} · posters{" "}
              {thumbsReport.postersExtracted} · upgraded{" "}
              {thumbsReport.postersUpgraded} · pruned {thumbsReport.pruned}
              {thumbsReport.failed > 0 ? ` · failed ${thumbsReport.failed}` : ""}
              {thumbsReport.skippedNoFfmpeg > 0
                ? ` — ${thumbsReport.skippedNoFfmpeg} video(s) need an ffmpeg path in Settings`
                : ""}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
        <Btn onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          disabled={busy || !projectPath || scriptCounts.sequences === 0}
          onClick={promptCreateDirs}
        >
          CREATE DIRS
        </Btn>
        <Btn disabled={busy || !config || !versionPrefixValid} onClick={save}>
          Save
        </Btn>
      </div>

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
              <Btn onClick={() => setPendingDirs(null)}>
                Cancel
              </Btn>
              <Btn onClick={confirmCreateDirs}>
                Create
              </Btn>
            </div>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
