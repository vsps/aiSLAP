import { useEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";
import { useScriptStore } from "../stores/scriptStore";
import { useSessionStore } from "../stores/sessionStore";
import { normalizeTitle, parseScript } from "../lib/script";
import type { Config } from "../lib/types";

type Props = {
  onClose: () => void;
};

const FILENAME_TEMPLATE_DEFAULT =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

const VERSION_PREFIX_DEFAULT = "gen";
const VERSION_PREFIX_RE = /^[A-Za-z][A-Za-z_-]*$/;

export function ProjectSettingsDialog({ onClose }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const scriptRaw = useScriptStore((s) => s.raw);
  const saveScript = useScriptStore((s) => s.save);
  const [config, setConfig] = useState<Config | null>(null);
  const [script, setScript] = useState(scriptRaw);
  const [busy, setBusy] = useState(false);
  const [versionPrefix, setVersionPrefix] = useState<string>(VERSION_PREFIX_DEFAULT);
  const [versionPrefixOriginal, setVersionPrefixOriginal] =
    useState<string>(VERSION_PREFIX_DEFAULT);

  type PendingShot = { name: string; isNew: boolean };
  type PendingSeq  = { seq: string; isNew: boolean; shots: PendingShot[] };
  const [pendingDirs, setPendingDirs] = useState<PendingSeq[] | null>(null);

  const scriptCounts = useMemo(() => {
    const p = parseScript(script);
    let shots = 0;
    for (const arr of p.shotsByParent.values()) shots += arr.length;
    return { sequences: p.sequences.length, shots };
  }, [script]);

  useEffect(() => {
    void (async () => {
      const c = (await cmd.config_load().catch(() => null)) as Config | null;
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
    const trimmed = scriptRaw.trimStart();
    const hasAssets = /^#\s+ASSETS\b/i.test(trimmed);
    setScript(hasAssets ? scriptRaw : "# ASSETS\n\n" + scriptRaw);
  }, [scriptRaw]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  function sanitizeName(name: string): string {
    return [...name].map((c) =>
      "/\\:*?\"<>|".includes(c) || c.charCodeAt(0) < 32 ? "_" : c
    ).join("");
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
        for (const s of parsed.shotsByParent.get(normalizeTitle(seqNames[i])) ?? []) {
          shotEntries.push({ seqIdx: i, name: s.title, path: `${seqPaths[i]}/${sanitizeName(s.title)}` });
        }
      }

      const exists = await cmd.dirs_exist([...seqPaths, ...shotEntries.map((e) => e.path)]);
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
      await showMessage(`Created ${newSeqs} sequence(s), ${newShots} shot(s)`, { kind: "info" });
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
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="relative bg-panel text-text max-w-[720px] w-full border border-dim shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 bg-surface text-text text-sm">Project Settings</div>

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
                  3-digit number is appended automatically. Existing folders
                  are not renamed.
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
            <div className="text-xs font-semibold text-dim uppercase tracking-wide">
              Script (script.md)
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
              Detected: {scriptCounts.sequences} sequence(s), {scriptCounts.shots} shot(s).{" "}
              <code>#</code> headings populate the SEQUENCE dropdown; <code>##</code>{" "}
              under the current sequence populate the SHOT dropdown. Body text below
              each heading appears above the matching prompt column.
            </div>
          </div>
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
            className="px-3 py-1 bg-accent text-bg text-xs disabled:opacity-50"
            disabled={busy || !config || !versionPrefixValid}
            onClick={save}
          >
            Save
          </button>
        </div>

        {pendingDirs && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6">
            <div className="bg-panel border border-dim shadow-xl w-full max-w-sm flex flex-col">
              <div className="px-4 py-2 bg-surface text-text text-sm">Create directories?</div>
              <ul className="px-4 py-3 font-mono text-xs overflow-y-auto max-h-64 thin-scroll flex flex-col gap-0.5">
                {pendingDirs.map(({ seq, isNew: seqIsNew, shots }) => (
                  <li key={seq}>
                    <span className={seqIsNew ? "text-accent" : "text-text"}>{seq}/</span>
                    {shots.map(({ name, isNew: shotIsNew }) => (
                      <div key={name} className={`pl-4 ${shotIsNew ? "text-accent" : "text-dim"}`}>{name}/</div>
                    ))}
                  </li>
                ))}
              </ul>
              <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
                <button className="px-3 py-1 bg-bg text-xs" onClick={() => setPendingDirs(null)}>
                  Cancel
                </button>
                <button className="px-3 py-1 bg-accent text-bg text-xs" onClick={confirmCreateDirs}>
                  Create
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
