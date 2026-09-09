import { useEffect, useState } from "react";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";
import { useSessionStore } from "../stores/sessionStore";
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

export function ProjectSettingsDialog({ onClose }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionPrefix, setVersionPrefix] = useState<string>(
    VERSION_PREFIX_DEFAULT,
  );
  const [versionPrefixOriginal, setVersionPrefixOriginal] = useState<string>(
    VERSION_PREFIX_DEFAULT,
  );

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

  async function save() {
    if (!config) return;
    setBusy(true);
    try {
      await cmd.config_save(config);
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

        <div className="text-xs text-dim">
          The script (script.md) and CREATE DIRS moved to the CONTEXT page.
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
        <Btn disabled={busy || !config || !versionPrefixValid} onClick={save}>
          Save
        </Btn>
      </div>
    </ModalDialog>
  );
}
