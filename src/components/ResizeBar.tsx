import { useRef } from "react";

type Props = {
  orientation: "horizontal" | "vertical";
  value: number;
  onChange: (next: number) => void;
  /** Drag direction for growing `value`. "up"/"left" → drag that way increases value. */
  grow?: "up" | "down" | "left" | "right";
};

/**
 * Thin draggable divider. Coalesces pointermove updates to one per animation
 * frame to keep gallery resizes responsive when many columns / thumbnails are
 * mounted — raw mouse events can fire >120Hz and storm React re-renders.
 */
export function ResizeBar({ orientation, value, onChange, grow }: Props) {
  const startRef = useRef<{ axis: number; value: number } | null>(null);
  const latestAxisRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const horizontal = orientation === "horizontal";
  const growDir = grow ?? (horizontal ? "up" : "right");

  function cancelPending() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function flush() {
    rafRef.current = null;
    const s = startRef.current;
    const axis = latestAxisRef.current;
    if (!s || axis == null) return;
    const delta = axis - s.axis;
    const signed = growDir === "up" || growDir === "left" ? -delta : delta;
    onChange(s.value + signed);
  }

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      className={
        horizontal
          ? "shrink-0 accent-hover h-[7px] w-full cursor-row-resize"
          : // Vertical: the gutter itself. Transparent at rest, highlights on
            // hover/drag — mirrors the work-surface ColumnResizeHandle.
            "shrink-0 w-[5px] h-full cursor-col-resize bg-transparent hover:bg-accent/40 active:bg-accent/60 transition-colors"
      }
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        startRef.current = {
          axis: horizontal ? e.clientY : e.clientX,
          value,
        };
      }}
      onPointerMove={(e) => {
        if (!startRef.current) return;
        latestAxisRef.current = horizontal ? e.clientY : e.clientX;
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(flush);
        }
      }}
      onPointerUp={(e) => {
        startRef.current = null;
        latestAxisRef.current = null;
        cancelPending();
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        startRef.current = null;
        latestAxisRef.current = null;
        cancelPending();
      }}
    />
  );
}
