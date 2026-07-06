import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { Icon } from "../lib/icon";

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
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 4;
    const left = Math.min(anchor.x, window.innerWidth - r.width - pad);
    const top = Math.min(anchor.y, window.innerHeight - r.height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

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
                const startX = e.clientX;
                const startY = e.clientY;
                const onMove = (ev: PointerEvent) => {
                  const dx = ev.clientX - startX;
                  const dy = ev.clientY - startY;
                  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
                    cleanup();
                    onClose();
                    onDragStart({ fromPath: img.path, pointerEvent: e });
                  }
                };
                const onUp = () => cleanup();
                const cleanup = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.removeEventListener("pointercancel", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
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
              {img.starred && (
                <span className="absolute bottom-0.5 left-0.5 drop-shadow pointer-events-none">
                  <Icon name="star" size={16} fill />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
