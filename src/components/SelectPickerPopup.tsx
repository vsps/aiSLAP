import { useRef } from "react";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { startThresholdDrag } from "../lib/dragThreshold";
import { usePopupDismiss, useClampedPosition } from "../lib/popup";
import { tagColor, useTagsStore } from "../stores/tagsStore";

type Props = {
  anchor: { x: number; y: number };
  images: GalleryImage[];
  selectedFilename: string;
  onPick: (filename: string) => void;
  onClose: () => void;
  /** When provided, images can be drag-started (e.g. to another stack, shot, GLOBAL SRC, or REFERENCES). */
  onDragStart?: (payload: {
    fromPath: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

const THUMB = 72;
const COLS_MAX = 5;
const DRAG_THRESHOLD_PX = 5;

export function SelectPickerPopup({
  anchor,
  images,
  selectedFilename,
  onPick,
  onClose,
  onDragStart,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, anchor.x, anchor.y);
  usePopupDismiss(ref, onClose);
  const defs = useTagsStore((s) => s.defs);

  const cols = Math.min(images.length, COLS_MAX);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-panel text-text border border-dim shadow-xl p-1.5"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, ${THUMB}px)` }}
      >
        {images.map((img) => {
          const isSelect = img.filename === selectedFilename;
          const src = img.isVideo
            ? img.thumbPath
              ? fileSrc(img.thumbPath)
              : null
            : fileSrc(img.path);
          return (
            <button
              key={img.path}
              type="button"
              title={img.filename}
              className={`relative bg-bg overflow-hidden border ${
                isSelect ? "border-accent" : "border-transparent"
              } hover:border-accent`}
              style={{ width: THUMB, height: THUMB }}
              onPointerDown={(e) => {
                if (!onDragStart || e.button !== 0) return;
                startThresholdDrag(e, DRAG_THRESHOLD_PX, () => {
                  onClose();
                  onDragStart({ fromPath: img.path, pointerEvent: e });
                });
              }}
              onClick={(e) => {
                e.stopPropagation();
                onPick(img.filename);
              }}
            >
              {src ? (
                <img
                  src={src}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">
                  {img.filename}
                </div>
              )}
              {(img.tags ?? []).length > 0 && (
                <span
                  className="absolute bottom-0.5 left-0.5 flex gap-[2px] drop-shadow pointer-events-none"
                  title={(img.tags ?? []).join(", ")}
                >
                  {(img.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="w-[6px] h-[6px]"
                      style={{ background: tagColor(defs, t) }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
