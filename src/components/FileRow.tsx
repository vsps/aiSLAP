import { memo, useEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { PathContextMenu } from "./PathContextMenu";
import { startThresholdDrag } from "../lib/dragThreshold";

type Props = {
  image: GalleryImage;
  selected: boolean;
  columnVersion: string;
  isDragSource?: boolean;
  onSelect: (path: string) => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** Disables drag start, matching `Thumbnail`. */
  dragDisabled?: boolean;
};

const DRAG_THRESHOLD_PX = 5;

/** One filename row — what a gallery column renders instead of a `Thumbnail`
 *  in list mode. Deliberately carries only the affordances that still make
 *  sense without a picture: select, drag to another column, context menu.
 *  No aspect probe, no hover metadata tooltip, no tag dots — filenames only.
 *
 *  Memo'd for the same reason `Thumbnail` is: a column can hold hundreds. */
export const FileRow = memo(function FileRow({
  image,
  selected,
  columnVersion,
  isDragSource,
  onSelect,
  onDragStart,
  dragDisabled,
}: Props) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keyboard nav can select a row that's scrolled out of view — same reason
  // Thumbnail does this. "nearest" avoids jumping an already-visible row.
  useEffect(() => {
    if (selected)
      rootRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if (dragDisabled) return;
    startThresholdDrag(e, DRAG_THRESHOLD_PX, () =>
      onDragStart({
        fromPath: image.path,
        fromColumnVersion: columnVersion,
        pointerEvent: e,
      }),
    );
  }

  if (image.pending) {
    return (
      <div className="px-1 py-[2px] text-xs font-mono text-dim animate-pulse truncate">
        generating…
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`px-1 py-[2px] text-xs font-mono truncate cursor-pointer select-none ${
        selected ? "bg-accent text-text" : "text-text hover:bg-panel"
      } ${isDragSource ? "opacity-40" : ""}`}
      title={image.filename}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(image.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {image.filename}
      {menuPos && (
        <PathContextMenu
          x={menuPos.x}
          y={menuPos.y}
          path={image.path}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
});
