import { useEffect, useRef, useState } from "react";
import type { GalleryColumn, GalleryImage } from "../lib/types";
import { cmd } from "../lib/tauri";
import { fileSrc } from "../lib/assets";

type Props = {
  anchor: HTMLElement | null;
  shotPath: string;
  currentMediaPath: string | null;
  onPick: (path: string | null) => void;
  onClose: () => void;
};

const columnsCache = new Map<string, GalleryColumn[]>();

function videoThumbCandidate(p: string): string {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 ? p.slice(0, dot) : p) + ".thumb.png";
}

export function ClipMediaPicker({
  anchor,
  shotPath,
  currentMediaPath,
  onPick,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<GalleryColumn[] | null>(
    columnsCache.get(shotPath) ?? null,
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (columns) return;
    let cancelled = false;
    cmd
      .shot_open(shotPath)
      .then((r) => {
        if (cancelled) return;
        columnsCache.set(shotPath, r.columns);
        setColumns(r.columns);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [shotPath, columns]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rect = anchor?.getBoundingClientRect();
  const style = rect
    ? {
        left: Math.min(
          window.innerWidth - 280,
          Math.max(8, rect.left),
        ),
        top: rect.top - 8,
        transform: "translateY(-100%)",
      }
    : { left: 100, top: 100 };

  return (
    <div
      ref={menuRef}
      className="fixed z-40 bg-panel text-text border border-dim shadow-xl p-1 w-[260px] max-h-[60vh] overflow-auto thin-scroll"
      style={style}
    >
      <div className="flex items-center px-2 py-1 text-xs opacity-70">
        <span>Pick clip media</span>
        <span className="flex-1" />
        <button
          type="button"
          className="text-dim hover:text-text"
          onClick={() => {
            onPick(null);
            onClose();
          }}
          title="Use default (clip-eye / latest)"
        >
          reset
        </button>
      </div>

      {err && (
        <div className="px-2 py-1 text-xs text-bad">{err}</div>
      )}
      {!columns && !err && (
        <div className="px-2 py-1 text-xs text-dim">loading…</div>
      )}
      {columns?.filter((col) => !col.isSrc).map((col) => (
        <div key={col.id} className="mt-1">
          <div className="px-2 py-[2px] text-[10px] uppercase opacity-60 font-mono">
            {col.version}
          </div>
          {col.images.length === 0 && (
            <div className="px-2 py-1 text-xs text-dim">empty</div>
          )}
          <div className="grid grid-cols-3 gap-[2px] p-[2px]">
            {col.images.map((img) => (
              <ImageTile
                key={img.path}
                img={img}
                selected={img.path === currentMediaPath}
                onClick={() => {
                  onPick(img.path);
                  onClose();
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ImageTile({
  img,
  selected,
  onClick,
}: {
  img: GalleryImage;
  selected: boolean;
  onClick: () => void;
}) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const src = img.isVideo
    ? thumbBroken
      ? null
      : fileSrc(img.thumbPath ?? videoThumbCandidate(img.path))
    : fileSrc(img.path);

  return (
    <button
      type="button"
      onClick={onClick}
      title={img.filename}
      className={`relative aspect-square overflow-hidden border ${
        selected ? "border-accent" : "border-border hover:border-edge"
      } bg-inset`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setThumbBroken(true)}
          draggable={false}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center material-symbols-outlined text-dim">
          movie
        </span>
      )}
      {img.isVideo && (
        <span
          className="absolute top-[2px] right-[2px] material-symbols-outlined text-text drop-shadow"
          style={{ fontSize: 14 }}
        >
          play_circle
        </span>
      )}
    </button>
  );
}
