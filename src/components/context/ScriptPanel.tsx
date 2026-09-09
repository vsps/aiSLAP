import { useMemo } from "react";
import { showMessage, confirmAction, pickFile } from "../../lib/dialog";
import { useScriptStore } from "../../stores/scriptStore";
import { useSessionStore } from "../../stores/sessionStore";
import { parseScript } from "../../lib/script";
import { Btn } from "../Btn";

function withAssetsHeader(raw: string): string {
  const hasAssets = /^#\s+ASSETS\b/i.test(raw.trimStart());
  return hasAssets ? raw : "# ASSETS\n\n" + raw;
}

type Props = {
  script: string;
  onChange: (script: string) => void;
};

/**
 * The project's `script.md`, moved here from Project Settings — CONTEXT is
 * where the script drives everything else on the page (the shot tree,
 * per-shot storyboard/refs), so it belongs alongside them rather than behind
 * a settings dialog. `script`/`onChange` are lifted to `ContextMode` so
 * brief-analysis (which derives a whole new script) can write into the same
 * buffer this panel edits.
 */
export function ScriptPanel({ script, onChange }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const scriptRaw = useScriptStore((s) => s.raw);
  const saveScript = useScriptStore((s) => s.save);

  const scriptCounts = useMemo(() => {
    const p = parseScript(script);
    let shots = 0;
    for (const arr of p.shotsByParent.values()) shots += arr.length;
    return { sequences: p.sequences.length, shots };
  }, [script]);

  const dirty = script !== scriptRaw;

  async function reload() {
    if (!projectPath) return;
    if (dirty) {
      const ok = await confirmAction(
        "Discard unsaved script changes and reload script.md from disk?",
        { title: "Reload script", kind: "warning" },
      );
      if (!ok) return;
    }
    await useScriptStore.getState().loadFor(projectPath);
    onChange(useScriptStore.getState().raw);
  }

  async function importScript() {
    const picked = await pickFile("Import script", {
      extensions: ["md", "txt"],
    });
    if (!picked || picked.length === 0) return;
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      onChange(withAssetsHeader(await readTextFile(picked[0])));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function save() {
    if (!projectPath || !dirty) return;
    try {
      await saveScript(projectPath, script);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  return (
    <div className="flex flex-col gap-1 flex-1 min-w-0 min-h-0">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Script (script.md)
        </div>
        <div className="flex gap-1">
          <Btn disabled={!projectPath} onClick={reload}>
            Reload
          </Btn>
          <Btn onClick={importScript}>Import…</Btn>
          <Btn disabled={!projectPath || !dirty} onClick={save}>
            Save
          </Btn>
        </div>
      </div>
      <textarea
        value={script}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={!projectPath}
        spellCheck={false}
        className="flex-1 min-h-0 w-full resize-none bg-inset text-text p-prompt-panel outline-none font-mono text-xs thin-scroll"
        placeholder="# Sequence 1&#10;&#10;## Shot 1&#10;..."
      />
      <div className="text-xs text-dim">
        Detected: {scriptCounts.sequences} sequence(s), {scriptCounts.shots}{" "}
        shot(s). <code>#</code> headings are sequences, <code>##</code> under
        one are its shots. Use CREATE DIRS (shot tree, right) to lock them in.
        {dirty && <span className="text-accent"> Unsaved changes.</span>}
      </div>
    </div>
  );
}
