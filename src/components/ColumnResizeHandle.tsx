import type { PointerEvent as ReactPointerEvent } from "react";
import { useLayoutStore, type ColumnKey } from "../stores/layoutStore";

/** Vertical grab strip on a column's right edge. Drag to resize the column;
 *  the width is read live from the layout store and persisted on change.
 *  Place inside a `relative` column wrapper. */
export function ColumnResizeHandle({ columnKey }: { columnKey: ColumnKey }) {
  const setWidth = useLayoutStore((s) => s.setWidth);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = useLayoutStore.getState().widths[columnKey];

    const onMove = (ev: PointerEvent) => {
      setWidth(columnKey, startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize column"
      className="absolute top-0 right-0 z-20 h-full w-[6px] -mr-[5px] cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
    />
  );
}
