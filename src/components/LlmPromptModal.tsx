import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SYSTEM_PROMPT,
  LLM_MODELS,
  loadLastLlmInstruction,
  loadLastLlmModel,
  runLlmRewrite,
  saveLastLlmInstruction,
  saveLastLlmModel,
} from "../lib/llm";
import { splitPromptsByDelimiter } from "../lib/args";
import { ModalDialog } from "./ModalDialog";

type Props = {
  originalPrompt: string;
  onAccept: (rewritten: string) => void;
  onCancel: () => void;
  /** When provided, shows a "Split" action that divides the output on `---`
   *  lines into multiple prompts (one parallel run each). */
  onSplit?: (parts: string[]) => void;
};

export function LlmPromptModal({ originalPrompt, onAccept, onCancel, onSplit }: Props) {
  const [model, setModel] = useState<string>(() => loadLastLlmModel());
  const [instruction, setInstruction] = useState<string>(() =>
    loadLastLlmInstruction(),
  );
  const [inputPrompt, setInputPrompt] = useState(originalPrompt);
  const [outputPrompt, setOutputPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight LLM call on unmount (Escape/backdrop close is
  // handled by ModalDialog via onClose={cancel}).
  useEffect(() => () => abortRef.current?.abort(), []);

  function cancel() {
    abortRef.current?.abort();
    onCancel();
  }

  async function run() {
    if (running) return;
    if (!inputPrompt.trim()) {
      setError("input prompt is empty");
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setError(null);
    saveLastLlmModel(model);
    saveLastLlmInstruction(instruction);
    try {
      const out = await runLlmRewrite({
        model,
        prompt: inputPrompt,
        systemPrompt: instruction.trim() || DEFAULT_SYSTEM_PROMPT,
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted) setOutputPrompt(out);
    } catch (e: unknown) {
      if (!ctrl.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      }
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }

  function accept() {
    abortRef.current?.abort();
    onAccept(outputPrompt);
  }

  const splitParts = splitPromptsByDelimiter(outputPrompt);
  const canSplit = !!onSplit && splitParts.length >= 2;

  function split() {
    abortRef.current?.abort();
    onSplit?.(splitParts);
  }

  return (
    <ModalDialog
      onClose={cancel}
      panelClassName="w-[640px] max-w-[92vw] max-h-[92vh] gap-3"
    >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
            auto_awesome
          </span>
          <div className="text-sm font-semibold">AI Rewrite</div>
          <div className="flex-1" />
          <button
            type="button"
            className="text-sm px-1 hover:bg-accent"
            onClick={cancel}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <label className="opacity-70 font-mono text-xs w-[60px]">Model</label>
          <select
            className="bg-bg text-text px-1 py-[2px] flex-1 outline-none"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
            disabled={running}
          >
            {LLM_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs opacity-70 font-mono">Input</div>
          <textarea
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.currentTarget.value)}
            disabled={running}
            className="min-h-[120px] max-h-[40vh] w-full resize-y bg-inset text-text p-prompt-panel outline-none thin-scroll"
            placeholder="Prompt to send to the LLM"
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs opacity-70 font-mono">Instruction</div>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.currentTarget.value)}
            disabled={running}
            className="min-h-[60px] max-h-[30vh] w-full resize-y bg-inset text-text p-prompt-panel outline-none thin-scroll"
            placeholder={DEFAULT_SYSTEM_PROMPT}
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs opacity-70 font-mono">Output</div>
          <textarea
            value={outputPrompt}
            onChange={(e) => setOutputPrompt(e.currentTarget.value)}
            className="min-h-[120px] max-h-[40vh] w-full resize-y bg-inset text-text p-prompt-panel outline-none thin-scroll"
            placeholder={running ? "Running…" : "Click RUN to generate"}
          />
          {onSplit && (
            <div className="text-xs opacity-50 font-mono">
              Separate prompts with <span className="opacity-90">---</span> on its own line, then Split to run each in parallel.
            </div>
          )}
        </div>

        {error && <div className="text-xs text-red-500 break-words">{error}</div>}

        <div className="flex justify-end gap-2 mt-1">
          <button
            type="button"
            className="px-3 py-1 text-sm hover:bg-accent"
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 text-sm bg-accent hover:opacity-80 disabled:opacity-40"
            onClick={() => void run()}
            disabled={running || !inputPrompt.trim()}
          >
            {running ? "Running…" : "Run"}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-sm bg-accent hover:opacity-80 disabled:opacity-40"
            onClick={accept}
            disabled={!outputPrompt.trim()}
          >
            Accept
          </button>
          {onSplit && (
            <button
              type="button"
              className="px-3 py-1 text-sm bg-accent hover:opacity-80 disabled:opacity-40"
              onClick={split}
              disabled={!canSplit}
              title={canSplit ? `Split into ${splitParts.length} prompts` : "Add --- delimiter lines to split"}
            >
              Split{canSplit ? ` (${splitParts.length})` : ""}
            </button>
          )}
        </div>
    </ModalDialog>
  );
}
