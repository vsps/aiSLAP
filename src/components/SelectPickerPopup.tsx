import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";

type Props = {
  anchor: { x: number; y: number };
  images: GalleryImage[];
  selectedFilename: string;
  onPick: (filename: string) => void;
  onClose: () => void;
};

const THUMB = 72;
const COLS_MAX = 5;

export function SelectPickerPopup({ anchor, images, selectedFilename, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

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
              onClick={(e) => {
                e.stopPropagation();
                onPick(img.filename);
              }}
            >
              {src ? (
                <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">
                  {img.filename}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
