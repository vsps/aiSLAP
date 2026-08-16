import type { PointerEvent as ReactPointerEvent } from "react";
import { useLayoutStore } from "../stores/layoutStore";

type Props = {
  /** Column version name — the key the width is stored under. */
  version: string;
  /** Current tile width, which is what gets stored (see `subCols` below). */
  width: number;
  /** Sub-columns the tile width is currently multiplied by. */
  subCols: number;
};

/** Vertical grab strip on a gallery column's right edge. Drag to resize just
 *  that column; double-click to drop the override and follow the global
 *  thumbnail slider again. Place inside a `relative` column wrapper.
 *
 *  Distinct from `ColumnResizeHandle`, which resizes the three *workbench*
 *  columns out of `layoutStore.widths` — a different map, different bounds.
 */
export function GalleryColumnResizeHandle({ version, width, subCols }: Props) {
  const setGalleryColumnWidth = useLayoutStore((s) => s.setGalleryColumnWidth);
  const clearGalleryColumnWidth = useLayoutStore(
    (s) => s.clearGalleryColumnWidth,
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    // The handle sits inside the column, which is both a drop target for image
    // drags and a click target for retargeting the version — neither should
    // see this gesture.
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    // What's stored is the *tile* width; the column renders `width * subCols`
    // wide. Divide the pointer delta so the visible edge tracks the cursor.
    // Captured at pointerdown so a reflow mid-drag doesn't change the scale.
    const startWidth = width;
    const scale = Math.max(1, subCols);

    const onMove = (ev: PointerEvent) => {
      setGalleryColumnWidth(version, startWidth + (ev.clientX - startX) / scale);
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
      onDoubleClick={(e) => {
        e.stopPropagation();
        clearGalleryColumnWidth(version);
      }}
      title="Drag to resize this column · double-click to reset"
      className="absolute top-0 right-0 z-20 h-full w-[6px] cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
    />
  );
}
