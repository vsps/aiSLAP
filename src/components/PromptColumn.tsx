import { useEffect, useState } from "react";
import {
  selectActiveLink,
  selectSequencePrompt,
  selectShotPrompts,
  useGenerationStore,
} from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import { useScriptStore } from "../stores/scriptStore";
import { findSequenceBody, findShotBody } from "../lib/script";
import { basename } from "../lib/paths";
import { confirmAction } from "../lib/dialog";
import { negativePromptParam } from "../lib/args";
import { useLayoutStore } from "../stores/layoutStore";
import { IconBtn } from "./IconBtn";
import { LlmPromptModal } from "./LlmPromptModal";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { CollapsedColumnBar } from "./CollapsedColumnBar";

// Clicking a column header toggles collapse, except when the click lands on
// an interactive control inside it (history nav, AI rewrite, clear, etc.).
function onHeaderClick(e: React.MouseEvent, toggle: () => void) {
  if ((e.target as HTMLElement).closest("button, input")) return;
  toggle();
}

type Scope = "sequence" | "shot";

type Props = {
  scope: Scope;
  title: string;
};

export function PromptColumn({ scope, title }: Props) {
  if (scope === "shot") return <ShotPromptColumn title={title} />;
  return <SequencePromptColumn title={title} />;
}

function ScriptSegment({
  text,
  included,
  onToggle,
}: {
  text: string;
  included: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-1 text-xs">
      <input
        type="checkbox"
        checked={included}
        onChange={(e) => onToggle(e.currentTarget.checked)}
        className="mt-[3px] accent-accent"
        title="Include script section in submitted prompt"
      />
      <pre className="flex-1 bg-bg/40 text-xs p-prompt-panel whitespace-pre-wrap opacity-80 max-h-[120px] overflow-y-auto thin-scroll font-mono">
        {text}
      </pre>
    </div>
  );
}

// ---------- Sequence: single textarea, store-managed cursor ----------

function SequencePromptColumn({ title }: { title: string }) {
  const live = useGenerationStore(selectSequencePrompt);
  const setLive = useGenerationStore((s) => s.setSequencePrompt);
  const setSequenceScriptIncluded = useGenerationStore((s) => s.setSequenceScriptIncluded);
  const setSequencePromptIncluded = useGenerationStore((s) => s.setSequencePromptIncluded);
  const activeLink = useGenerationStore(selectActiveLink);
  const history = useSessionStore((s) => s.sequenceHistory);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const navigatePromptHistory = useSessionStore((s) => s.navigatePromptHistory);
  const snapToLive = useSessionStore((s) => s.snapToLive);
  const parsed = useScriptStore((s) => s.parsed);
  const [llmOpen, setLlmOpen] = useState(false);
  const width = useLayoutStore((s) => s.widths.seqPrompt);
  const collapsed = useLayoutStore((s) => s.collapsed.seqPrompt);
  const toggleCollapsed = useLayoutStore((s) => s.toggleCollapsed);

  const atLive = history.cursor >= history.entries.length;
  const displayed = atLive ? live : history.entries[history.cursor]?.prompt ?? "";
  const readOnly = !atLive;
  const entry = atLive ? null : history.entries[history.cursor];

  const canGoBack = history.cursor > 0 && history.entries.length > 0;
  const canGoFwd = history.cursor < history.entries.length;

  const seqName = sequencePath ? basename(sequencePath) : "";
  const seqScript = seqName ? findSequenceBody(parsed, seqName) : "";

  const sequencePromptIncluded = activeLink?.sequencePromptIncluded !== false;
  const sequenceScriptIncluded = activeLink?.sequenceScriptIncluded !== false;
  const negPromptSupported = !!(activeLink?.model && negativePromptParam(activeLink.model));

  if (collapsed) {
    return (
      <CollapsedColumnBar title={title} onClick={() => toggleCollapsed("seqPrompt")} />
    );
  }

  return (
    <div
      className="relative bg-surface border border-border p-prompt-column text-text flex flex-col gap-prompt-column-gap shrink-0"
      style={{ width }}
    >
      <div
        className="flex items-center text-sm gap-[4px] font-semibold cursor-pointer select-none"
        title="Click to collapse"
        onClick={(e) => onHeaderClick(e, () => toggleCollapsed("seqPrompt"))}
      >
        <span title={negPromptSupported ? "Separate the negative prompt with a ---" : undefined}>
          {title}
        </span>
        {history.entries.length > 0 && (
          <span className="text-xs opacity-60 font-mono">
            {atLive ? history.entries.length : `${history.cursor + 1}/${history.entries.length}`}
          </span>
        )}
        <div className="flex-1" />
        {!readOnly && (
          <IconBtn
            name="auto_awesome"
            size={18}
            title="AI rewrite"
            onClick={() => setLlmOpen(true)}
          />
        )}
        <IconBtn
          name="keyboard_arrow_left"
          size={18}
          title={entry ? `Older · ${entry.timestamp}` : "Older"}
          onClick={() => navigatePromptHistory("sequence", -1)}
          disabled={!canGoBack}
        />
        <IconBtn
          name="keyboard_arrow_right"
          size={18}
          title="Newer / live"
          onClick={() => navigatePromptHistory("sequence", +1)}
          disabled={!canGoFwd}
        />
      </div>

      {seqScript && (
        <ScriptSegment
          text={seqScript}
          included={sequenceScriptIncluded}
          onToggle={setSequenceScriptIncluded}
        />
      )}

      <div className="flex items-start gap-1 flex-1 min-h-[120px]">
        <input
          type="checkbox"
          checked={sequencePromptIncluded}
          onChange={(e) => setSequencePromptIncluded(e.currentTarget.checked)}
          disabled={readOnly}
          className="mt-[6px] accent-accent"
          title="Include sequence prompt in submitted prompt"
        />
        <textarea
          value={displayed}
          readOnly={readOnly}
          onFocus={() => {
            if (readOnly) snapToLive("sequence");
          }}
          onChange={(e) => setLive(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.altKey && e.key === "ArrowLeft") {
              e.preventDefault();
              navigatePromptHistory("sequence", -1);
            } else if (e.altKey && e.key === "ArrowRight") {
              e.preventDefault();
              navigatePromptHistory("sequence", +1);
            }
          }}
          placeholder="Prompt prepended to all shots in this sequence"
          className={`flex-1 min-h-[120px] w-full resize-none bg-inset text-text p-prompt-panel outline-none ${
            readOnly ? "opacity-70 cursor-text" : ""
          } ${!sequencePromptIncluded ? "opacity-50" : ""}`}
        />
      </div>

      {entry && (
        <div className="text-xs opacity-60 font-mono truncate" title={entry.timestamp}>
          {new Date(entry.timestamp).toLocaleString()}
        </div>
      )}

      {llmOpen && (
        <LlmPromptModal
          originalPrompt={displayed}
          onAccept={(v) => {
            setLive(v);
            setLlmOpen(false);
          }}
          onCancel={() => setLlmOpen(false)}
        />
      )}
      <ColumnResizeHandle columnKey="seqPrompt" />
    </div>
  );
}

// ---------- Shot: N textareas, column-level cursor over grouped history ----------

function ShotPromptColumn({ title }: { title: string }) {
  const shotPrompts = useGenerationStore(selectShotPrompts);
  const setShotPrompts = useGenerationStore((s) => s.setShotPrompts);
  const setShotScriptIncluded = useGenerationStore((s) => s.setShotScriptIncluded);
  const setShotPromptIncludedAt = useGenerationStore((s) => s.setShotPromptIncludedAt);
  const setShotPromptAt = useGenerationStore((s) => s.setShotPromptAt);
  const addShotPromptAfter = useGenerationStore((s) => s.addShotPromptAfter);
  const removeShotPromptAt = useGenerationStore((s) => s.removeShotPromptAt);
  const activeLink = useGenerationStore(selectActiveLink);
  const entries = useSessionStore((s) => s.shotHistory.entries);
  const shotPath = useSessionStore((s) => s.shotPath);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const parsed = useScriptStore((s) => s.parsed);
  const width = useLayoutStore((s) => s.widths.shotPrompt);
  const collapsed = useLayoutStore((s) => s.collapsed.shotPrompt);
  const toggleCollapsed = useLayoutStore((s) => s.toggleCollapsed);
  const [cursor, setCursor] = useState(entries.length);

  useEffect(() => {
    setCursor(entries.length);
  }, [entries.length]);

  const safeCursor = Math.min(cursor, entries.length);
  const atLive = safeCursor >= entries.length;
  const histEntry = atLive ? null : entries[safeCursor];

  const displayedPrompts: string[] = atLive
    ? shotPrompts
    : histEntry?.prompts ?? [histEntry?.prompt ?? ""];

  const canGoBack = safeCursor > 0 && entries.length > 0;
  const canGoFwd = safeCursor < entries.length;

  const seqName = sequencePath ? basename(sequencePath) : "";
  const shotName = shotPath ? basename(shotPath) : "";
  const shotScript = seqName && shotName ? findShotBody(parsed, seqName, shotName) : "";

  const shotScriptIncluded = activeLink?.shotScriptIncluded !== false;
  const shotPromptsIncluded =
    activeLink?.shotPromptsIncluded ?? shotPrompts.map(() => true);
  const negPromptSupported = !!(activeLink?.model && negativePromptParam(activeLink.model));

  // Replace all shot prompts with AI-split sections, after a warning. Returns
  // whether the split was applied (false when the user cancels).
  async function applySplit(parts: string[]): Promise<boolean> {
    const ok = await confirmAction(
      `Replace all ${shotPrompts.length} shot prompt(s) with ${parts.length} new one(s)?`,
      { title: "Split into prompts", kind: "warning" },
    );
    if (ok) setShotPrompts(parts);
    return ok;
  }

  if (collapsed) {
    return (
      <CollapsedColumnBar title={title} onClick={() => toggleCollapsed("shotPrompt")} />
    );
  }

  return (
    <div
      className="relative bg-surface border border-border p-prompt-column text-text flex flex-col gap-prompt-column-gap shrink-0 min-h-0"
      style={{ width }}
    >
      <div
        className="flex items-center text-sm gap-[4px] font-semibold cursor-pointer select-none"
        title="Click to collapse"
        onClick={(e) => onHeaderClick(e, () => toggleCollapsed("shotPrompt"))}
      >
        <span title={negPromptSupported ? "Separate the negative prompt with a ---" : undefined}>
          {title}
        </span>
        {entries.length > 0 && (
          <span className="text-xs opacity-60 font-mono">
            {atLive ? entries.length : `${safeCursor + 1}/${entries.length}`}
          </span>
        )}
        <div className="flex-1" />
        <button
          className="text-xs opacity-50 hover:opacity-100 px-1"
          title="Clear all shot prompts"
          onClick={() => setShotPrompts([""])}
        >
          clear
        </button>
        <IconBtn
          name="keyboard_arrow_left"
          size={18}
          title={histEntry ? `Older · ${histEntry.timestamp}` : "Older"}
          onClick={() => setCursor((c) => Math.max(0, c - 1))}
          disabled={!canGoBack}
        />
        <IconBtn
          name="keyboard_arrow_right"
          size={18}
          title="Newer / live"
          onClick={() => setCursor((c) => Math.min(entries.length, c + 1))}
          disabled={!canGoFwd}
        />
      </div>

      {shotScript && atLive && (
        <ScriptSegment
          text={shotScript}
          included={shotScriptIncluded}
          onToggle={setShotScriptIncluded}
        />
      )}

      <div className="flex-1 min-h-0 flex flex-col gap-prompt-column-gap overflow-y-auto thin-scroll pr-[6px]">
        {displayedPrompts.map((value, idx) => (
          <ShotPromptBox
            key={idx}
            index={idx}
            value={value}
            readOnly={!atLive}
            isFirst={idx === 0}
            included={shotPromptsIncluded[idx] !== false}
            onToggleIncluded={(v) => setShotPromptIncludedAt(idx, v)}
            onChange={(v) => setShotPromptAt(idx, v)}
            onAdd={() => addShotPromptAfter(idx)}
            onRemove={() => removeShotPromptAt(idx)}
            onSplit={applySplit}
            onFocusWhenReadOnly={() => setCursor(entries.length)}
          />
        ))}
      </div>

      {histEntry && (
        <div className="text-xs opacity-60 font-mono truncate" title={histEntry.timestamp}>
          {new Date(histEntry.timestamp).toLocaleString()}
        </div>
      )}
      <ColumnResizeHandle columnKey="shotPrompt" />
    </div>
  );
}

type ShotPromptBoxProps = {
  index: number;
  value: string;
  readOnly: boolean;
  isFirst: boolean;
  included: boolean;
  onToggleIncluded: (v: boolean) => void;
  onChange: (v: string) => void;
  onAdd: () => void;
  onRemove: () => void;
  onSplit: (parts: string[]) => Promise<boolean>;
  onFocusWhenReadOnly: () => void;
};

function ShotPromptBox({
  index,
  value,
  readOnly,
  isFirst,
  included,
  onToggleIncluded,
  onChange,
  onAdd,
  onRemove,
  onSplit,
  onFocusWhenReadOnly,
}: ShotPromptBoxProps) {
  const [llmOpen, setLlmOpen] = useState(false);
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="flex items-center gap-[4px] text-xs opacity-80">
        <input
          type="checkbox"
          checked={included}
          onChange={(e) => onToggleIncluded(e.currentTarget.checked)}
          disabled={readOnly}
          className="accent-accent"
          title="Include this prompt in submitted prompt"
        />
        <span className="font-mono">#{index + 1}</span>
        <div className="flex-1" />
        {!readOnly && (
          <>
            <IconBtn name="auto_awesome" size={16} title="AI rewrite" onClick={() => setLlmOpen(true)} />
            <IconBtn name="add" size={16} title="Add prompt below" onClick={onAdd} />
            {!isFirst && <IconBtn name="remove" size={16} title="Remove this prompt" onClick={onRemove} />}
          </>
        )}
      </div>

      <textarea
        value={value}
        readOnly={readOnly}
        onFocus={() => { if (readOnly) onFocusWhenReadOnly(); }}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); onFocusWhenReadOnly(); }
        }}
        placeholder={isFirst ? "Shot prompt" : "Additional shot prompt"}
        className={`min-h-[120px] w-full resize-none bg-inset text-text p-prompt-panel outline-none ${
          readOnly ? "opacity-70 cursor-text" : ""
        } ${!included ? "opacity-50" : ""}`}
      />

      {llmOpen && (
        <LlmPromptModal
          originalPrompt={value}
          onAccept={(v) => {
            onChange(v);
            setLlmOpen(false);
          }}
          onSplit={(parts) => {
            void onSplit(parts).then((applied) => {
              if (applied) setLlmOpen(false);
            });
          }}
          onCancel={() => setLlmOpen(false)}
        />
      )}
    </div>
  );
}
