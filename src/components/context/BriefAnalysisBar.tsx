import { useState } from "react";
import { cmd } from "../../lib/tauri";
import { pickFile, showMessage } from "../../lib/dialog";
import { useSessionStore } from "../../stores/sessionStore";
import {
  LLM_MODELS,
  loadLastLlmModel,
  saveLastLlmModel,
  runBriefAnalysis,
  type BriefAnalysis,
} from "../../lib/llm";
import { Btn } from "../Btn";

type Props = {
  onScriptDerived: (script: string) => void;
};

/**
 * Drop a PDF/PPTX brief, extract its text + embedded images (Rust
 * `brief_extract` — images land straight in the project's Global SRC/BRIEF
 * folder), then derive a script from the text via an LLM. The derived script
 * is never applied silently — a confirm step shows it first, mirroring
 * CREATE DIRS's own preview-then-confirm.
 */
export function BriefAnalysisBar({ onScriptDerived }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const [model, setModel] = useState(loadLastLlmModel);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<BriefAnalysis | null>(null);

  async function analyze(filePath: string) {
    if (!projectPath) {
      await showMessage("Open a project first", { kind: "warning" });
      return;
    }
    setBusy(true);
    setStatus("Extracting…");
    try {
      const extracted = await cmd.brief_extract(projectPath, filePath);
      if (!extracted.text.trim()) {
        await showMessage("No text could be extracted from that file", {
          kind: "warning",
        });
        return;
      }
      setStatus(
        `Extracted ${extracted.imagesWritten.length} image(s)` +
          (extracted.imagesSkipped > 0
            ? ` (${extracted.imagesSkipped} skipped)`
            : "") +
          ` — analyzing with ${model}…`,
      );
      const controller = new AbortController();
      const result = await runBriefAnalysis({
        model,
        extractedText: extracted.text,
        signal: controller.signal,
      });
      // Global SRC's subfolder list is a snapshot taken at shot-open time —
      // refresh so the new BRIEF subfolder shows up without reopening the shot.
      await useSessionStore.getState().rescanShot();
      setPending(result);
      setStatus(null);
    } catch (e) {
      setStatus(null);
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function pickAndAnalyze() {
    const picked = await pickFile("Pick a brief (PDF or PPTX)", {
      extensions: ["pdf", "pptx"],
    });
    if (picked?.[0]) await analyze(picked[0]);
  }

  function acceptDerivedScript() {
    if (!pending) return;
    onScriptDerived(pending.script);
    setPending(null);
  }

  return (
    <div className="flex items-center gap-2 bg-inset px-2 py-1 shrink-0 text-xs">
      <span className="font-semibold text-dim uppercase tracking-wide">
        Brief analysis
      </span>
      <select
        value={model}
        onChange={(e) => {
          setModel(e.currentTarget.value);
          saveLastLlmModel(e.currentTarget.value);
        }}
        className="bg-bg px-2 py-1 font-mono text-xs"
      >
        {LLM_MODELS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <Btn disabled={busy || !projectPath} onClick={pickAndAnalyze}>
        {busy ? "Working…" : "Analyze PDF/PPTX…"}
      </Btn>
      <span className="text-dim flex-1 truncate">{status}</span>

      {pending && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6">
          <div className="bg-panel border border-dim shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="px-4 py-2 bg-surface text-text text-sm">
              Apply derived script?
            </div>
            <div className="p-4 flex flex-col gap-3 overflow-y-auto thin-scroll">
              {pending.brief && (
                <div>
                  <div className="text-xs font-semibold text-dim uppercase tracking-wide mb-1">
                    Brief
                  </div>
                  <div className="text-xs whitespace-pre-wrap">{pending.brief}</div>
                </div>
              )}
              <div>
                <div className="text-xs font-semibold text-dim uppercase tracking-wide mb-1">
                  Script — replaces the current editor content below
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap bg-inset p-2">
                  {pending.script}
                </pre>
              </div>
            </div>
            <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
              <Btn onClick={() => setPending(null)}>Cancel</Btn>
              <Btn onClick={acceptDerivedScript}>Apply to script</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
