import { useEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";
import { useScriptStore } from "../stores/scriptStore";
import { useSessionStore } from "../stores/sessionStore";
import { parseScript } from "../lib/script";
import type { Config } from "../lib/types";

type Props = {
  onClose: () => void;
};

const FILENAME_TEMPLATE_DEFAULT =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

export function ProjectSettingsDialog({ onClose }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const scriptRaw = useScriptStore((s) => s.raw);
  const saveScript = useScriptStore((s) => s.save);
  const [config, setConfig] = useState<Config | null>(null);
  const [script, setScript] = useState(scriptRaw);
  const [busy, setBusy] = useState(false);

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
    setScript(scriptRaw);
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

  async function save() {
    if (!config) return;
    setBusy(true);
    try {
      await cmd.config_save(config);
      if (projectPath && script !== scriptRaw) {
        await saveScript(projectPath, script);
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
        className="bg-panel text-text max-w-[720px] w-full border border-dim shadow-xl"
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
                className="flex-1 bg-bg px-2 py-1 text-xs font-mono"
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
              Script (script.md)
            </div>
            <textarea
              value={script}
              onChange={(e) => setScript(e.currentTarget.value)}
              disabled={!projectPath}
              spellCheck={false}
              className="min-h-[260px] max-h-[40vh] w-full resize-y bg-bg text-text p-prompt-panel outline-none font-mono text-xs thin-scroll"
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
            className="px-3 py-1 bg-accent text-bg text-xs disabled:opacity-50"
            disabled={busy || !config}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
