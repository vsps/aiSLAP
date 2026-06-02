import { useEffect, useState } from "react";
import { useGenerationStore } from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import { useScriptStore } from "../stores/scriptStore";
import { findSequenceBody, findShotBody } from "../lib/script";
import { basename } from "../lib/paths";
import { confirmAction } from "../lib/dialog";
import { useLayoutStore } from "../stores/layoutStore";
import { IconBtn } from "./IconBtn";
import { LlmPromptModal } from "./LlmPromptModal";
import { ColumnResizeHandle } from "./ColumnResizeHandle";

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
  const generation = useGenerationStore();
  const session = useSessionStore();
  const parsed = useScriptStore((s) => s.parsed);
  const [llmOpen, setLlmOpen] = useState(false);
  const width = useLayoutStore((s) => s.widths.seqPrompt);

  const history = session.sequenceHistory;
  const live = generation.sequencePrompt;
  const setLive = generation.setSequencePrompt;

  const atLive = history.cursor >= history.entries.length;
  const displayed = atLive ? live : history.entries[history.cursor]?.prompt ?? "";
  const readOnly = !atLive;
  const entry = atLive ? null : history.entries[history.cursor];

  const canGoBack = history.cursor > 0 && history.entries.length > 0;
  const canGoFwd = history.cursor < history.entries.length;

  const seqName = session.sequencePath ? basename(session.sequencePath) : "";
  const seqScript = seqName ? findSequenceBody(parsed, seqName) : "";

  const activeLink = generation.expandedIdx != null
    ? generation.links[generation.expandedIdx]
    : generation.links[0];
  const sequencePromptIncluded = activeLink?.sequencePromptIncluded !== false;
  const sequenceScriptIncluded = activeLink?.sequenceScriptIncluded !== false;

  return (
    <div
      className="relative bg-surface border border-border p-prompt-column text-text flex flex-col gap-prompt-column-gap shrink-0"
      style={{ width }}
    >
      <div className="flex items-center text-sm gap-[4px] font-semibold">
        <span>{title}</span>
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
          onClick={() => session.navigatePromptHistory("sequence", -1)}
          disabled={!canGoBack}
        />
        <IconBtn
          name="keyboard_arrow_right"
          size={18}
          title="Newer / live"
          onClick={() => session.navigatePromptHistory("sequence", +1)}
          disabled={!canGoFwd}
        />
      </div>

      {seqScript && (
        <ScriptSegment
          text={seqScript}
          included={sequenceScriptIncluded}
          onToggle={generation.setSequenceScriptIncluded}
        />
      )}

      <div className="flex items-start gap-1 flex-1 min-h-[120px]">
        <input
          type="checkbox"
          checked={sequencePromptIncluded}
          onChange={(e) => generation.setSequencePromptIncluded(e.currentTarget.checked)}
          disabled={readOnly}
          className="mt-[6px] accent-accent"
          title="Include sequence prompt in submitted prompt"
        />
        <textarea
          value={displayed}
          readOnly={readOnly}
          onFocus={() => {
            if (readOnly) session.snapToLive("sequence");
          }}
          onChange={(e) => setLive(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.altKey && e.key === "ArrowLeft") {
              e.preventDefault();
              session.navigatePromptHistory("sequence", -1);
            } else if (e.altKey && e.key === "ArrowRight") {
              e.preventDefault();
              session.navigatePromptHistory("sequence", +1);
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
  const gen = useGenerationStore();
  const entries = useSessionStore((s) => s.shotHistory.entries);
  const shotPath = useSessionStore((s) => s.shotPath);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const parsed = useScriptStore((s) => s.parsed);
  const width = useLayoutStore((s) => s.widths.shotPrompt);
  const [cursor, setCursor] = useState(entries.length);

  useEffect(() => {
    setCursor(entries.length);
  }, [entries.length]);

  const safeCursor = Math.min(cursor, entries.length);
  const atLive = safeCursor >= entries.length;
  const histEntry = atLive ? null : entries[safeCursor];

  const displayedPrompts: string[] = atLive
    ? gen.shotPrompts
    : histEntry?.prompts ?? [histEntry?.prompt ?? ""];

  const canGoBack = safeCursor > 0 && entries.length > 0;
  const canGoFwd = safeCursor < entries.length;

  const seqName = sequencePath ? basename(sequencePath) : "";
  const shotName = shotPath ? basename(shotPath) : "";
  const shotScript = seqName && shotName ? findShotBody(parsed, seqName, shotName) : "";

  const activeLink = gen.expandedIdx != null ? gen.links[gen.expandedIdx] : gen.links[0];
  const shotScriptIncluded = activeLink?.shotScriptIncluded !== false;
  const shotPromptsIncluded =
    activeLink?.shotPromptsIncluded ?? gen.shotPrompts.map(() => true);

  // Replace all shot prompts with AI-split sections, after a warning. Returns
  // whether the split was applied (false when the user cancels).
  async function applySplit(parts: string[]): Promise<boolean> {
    const ok = await confirmAction(
      `Replace all ${gen.shotPrompts.length} shot prompt(s) with ${parts.length} new one(s)?`,
      { title: "Split into prompts", kind: "warning" },
    );
    if (ok) gen.setShotPrompts(parts);
    return ok;
  }

  return (
    <div
      className="relative bg-surface border border-border p-prompt-column text-text flex flex-col gap-prompt-column-gap shrink-0 min-h-0"
      style={{ width }}
    >
      <div className="flex items-center text-sm gap-[4px] font-semibold">
        <span>{title}</span>
        {entries.length > 0 && (
          <span className="text-xs opacity-60 font-mono">
            {atLive ? entries.length : `${safeCursor + 1}/${entries.length}`}
          </span>
        )}
        <div className="flex-1" />
        <button
          className="text-xs opacity-50 hover:opacity-100 px-1"
          title="Clear all shot prompts"
          onClick={() => gen.setShotPrompts([""])}
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
          onToggle={gen.setShotScriptIncluded}
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
            onToggleIncluded={(v) => gen.setShotPromptIncludedAt(idx, v)}
            onChange={(v) => gen.setShotPromptAt(idx, v)}
            onAdd={() => gen.addShotPromptAfter(idx)}
            onRemove={() => gen.removeShotPromptAt(idx)}
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
