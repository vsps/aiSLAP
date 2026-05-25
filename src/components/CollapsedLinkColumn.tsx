import { useRef } from "react";
import type { ChainLink } from "../lib/types";
import type { LinkProblem } from "../lib/chainValidation";
import { worstSeverity } from "../lib/chainValidation";
import { useGenerationStore } from "../stores/generationStore";
import { IconBtn } from "./IconBtn";

type Props = {
  link: ChainLink;
  index: number;
  problems: LinkProblem[];
  onBeginDrag: (
    fromIdx: number,
    pointerId: number,
    handleEl: HTMLElement,
  ) => void;
};

export function CollapsedLinkColumn({
  link,
  index,
  problems,
  onBeginDrag,
}: Props) {
  const expandLink = useGenerationStore((s) => s.expandLink);
  const setLinkActive = useGenerationStore((s) => s.setLinkActive);
  const removeLink = useGenerationStore((s) => s.removeLink);
  const linksCount = useGenerationStore((s) => s.links.length);

  const severity = worstSeverity(problems);
  const colRef = useRef<HTMLDivElement>(null);

  const promptSnippet = (
    link.shotPrompts.find((p) => p.trim()) ??
    link.sequencePrompt ??
    ""
  )
    .trim()
    .slice(0, 80);
  const modelLabel = link.model?.name ?? "(no model)";
  const inactive = !link.active;

  const outline =
    severity === "error"
      ? "outline outline-2 outline-red-500"
      : severity === "warn"
        ? "outline outline-2 outline-yellow-500"
        : "";

  return (
    <div
      ref={colRef}
      data-link-idx={index}
      className={`bg-surface border border-border text-text w-[72px] flex flex-col shrink-0 cursor-pointer ${outline} ${inactive ? "opacity-50" : ""}`}
      title={
        problems.length > 0
          ? problems.map((p) => `${p.severity}: ${p.message}`).join("\n")
          : `Click to edit · ${modelLabel}`
      }
      onClick={(e) => {
        // Allow header buttons to handle their own clicks.
        if ((e.target as HTMLElement).closest("button, input")) return;
        expandLink(index);
      }}
    >
      <div className="flex items-center justify-between px-1 py-1 bg-accent">
        <input
          type="checkbox"
          checked={link.active}
          onChange={(e) => setLinkActive(link.id, e.currentTarget.checked)}
          title={link.active ? "Skip this link" : "Activate this link"}
          className="cursor-pointer"
        />
        <IconBtn
          name="close"
          size={16}
          title={linksCount > 1 ? "Delete link" : "Cannot delete the only link"}
          disabled={linksCount <= 1}
          onClick={(e) => {
            e.stopPropagation();
            removeLink(link.id);
          }}
        />
      </div>
      <div className="flex-1 px-1 py-2 flex flex-col items-center gap-2 min-h-0">
        <div className="text-[10px] font-mono opacity-70 text-center">
          #{index + 1}
        </div>
        <div
          className="text-xs font-semibold text-center break-words leading-tight"
          style={{ wordBreak: "break-word" }}
        >
          {modelLabel}
        </div>
        {link.consumesPrev && index > 0 && (
          <div className="text-[10px] opacity-60" title="Consumes previous link's output">
            ← prev
          </div>
        )}
        {promptSnippet && (
          <div className="text-[10px] opacity-70 text-center line-clamp-6 break-words">
            {promptSnippet}
          </div>
        )}
        {severity && (
          <div
            className={`mt-auto text-[10px] font-mono px-1 ${
              severity === "error" ? "text-red-500" : "text-yellow-500"
            }`}
          >
            {severity === "error" ? "ERR" : "WARN"}
          </div>
        )}
      </div>
      <div
        className="px-1 py-[2px] bg-bg/85 cursor-grab active:cursor-grabbing select-none flex items-center justify-center"
        title="Drag to reorder"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          e.stopPropagation();
          onBeginDrag(index, e.pointerId, e.currentTarget);
        }}
      >
        <span
          aria-hidden
          className="material-symbols-outlined opacity-60 pointer-events-none"
          style={{ fontSize: 18 }}
        >
          drag_indicator
        </span>
      </div>
    </div>
  );
}
