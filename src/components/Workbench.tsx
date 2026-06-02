import { useMemo, useState } from "react";
import { ModelSettingsColumn } from "./ModelSettingsColumn";
import { PromptColumn } from "./PromptColumn";
import { RefImagesColumn } from "./RefImagesColumn";
import { LatestImageColumn } from "./LatestImageColumn";
import { RunColumn } from "./RunColumn";
import { CollapsedLinkColumn } from "./CollapsedLinkColumn";
import { ChainAddBar } from "./ChainAddBar";
import { useGenerationStore } from "../stores/generationStore";
import { preflightChain, problemsByLinkId } from "../lib/chainValidation";

export function Workbench() {
  const links = useGenerationStore((s) => s.links);
  const expandedIdx = useGenerationStore((s) => s.expandedIdx);
  const moveLink = useGenerationStore((s) => s.moveLink);

  const problems = useMemo(() => preflightChain(links), [links]);
  const problemsByLink = useMemo(() => problemsByLinkId(problems), [problems]);

  const [dragState, setDragState] = useState<
    { fromIdx: number; overIdx: number | null } | null
  >(null);

  function beginDrag(fromIdx: number, pointerId: number, handleEl: HTMLElement) {
    handleEl.setPointerCapture(pointerId);
    setDragState({ fromIdx, overIdx: null });
    let currentOver: number | null = null;

    const findIdxAt = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const col = el.closest<HTMLElement>("[data-link-idx]");
      if (!col) return null;
      const n = Number(col.dataset.linkIdx);
      return Number.isFinite(n) ? n : null;
    };

    const onMove = (ev: PointerEvent) => {
      currentOver = findIdxAt(ev.clientX, ev.clientY);
      setDragState({ fromIdx, overIdx: currentOver });
    };
    const onUp = () => {
      handleEl.releasePointerCapture(pointerId);
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onUp);
      setDragState(null);
      if (currentOver != null && currentOver !== fromIdx) {
        moveLink(fromIdx, currentOver);
      }
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  }

  // When expandedIdx is null all links render as collapsed columns side by
  // side; otherwise we split collapsed columns to the left and right of the
  // expanded link's four-panel editor.
  const isSubmitReady = expandedIdx == null;
  const leftCollapsed = isSubmitReady ? links : links.slice(0, expandedIdx);
  const rightCollapsed = isSubmitReady ? [] : links.slice(expandedIdx + 1);
  const leftOffset = 0;
  const rightOffset = isSubmitReady ? 0 : expandedIdx + 1;

  return (
    <div
      className={`flex flex-1 min-h-0 gap-prompt-surface bg-panel overflow-hidden ${
        dragState ? "select-none" : ""
      }`}
    >
      {leftCollapsed.map((link, i) => (
        <CollapsedLinkColumn
          key={link.id}
          link={link}
          index={leftOffset + i}
          problems={problemsByLink.get(link.id) ?? []}
          onBeginDrag={beginDrag}
        />
      ))}
      {!isSubmitReady && (
        <>
          <ModelSettingsColumn />
          <PromptColumn scope="sequence" title="SEQUENCE PROMPT" />
          <PromptColumn scope="shot" title="SHOT PROMPT" />
          <RefImagesColumn />
        </>
      )}
      {rightCollapsed.map((link, i) => (
        <CollapsedLinkColumn
          key={link.id}
          link={link}
          index={rightOffset + i}
          problems={problemsByLink.get(link.id) ?? []}
          onBeginDrag={beginDrag}
        />
      ))}
      <ChainAddBar />
      <LatestImageColumn />
      <RunColumn />
    </div>
  );
}
