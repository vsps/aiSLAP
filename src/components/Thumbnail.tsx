import { memo, useEffect, useRef, useState } from "react";
import type { GalleryImage, ImageMetadata } from "../lib/types";
import { IconBtn } from "./IconBtn";
import { fileSrc } from "../lib/assets";
import { PathContextMenu } from "./PathContextMenu";
import { cmd } from "../lib/tauri";

type Props = {
  image: GalleryImage;
  selected: boolean;
  hidden?: boolean;
  columnVersion: string;
  isDragSource?: boolean;
  onSelect: () => void;
  onToggleStar: () => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** Disables drag start. Used in the starred view where drag-to-column has no destination. */
  dragDisabled?: boolean;
  /** Whether this image is currently the shot's exclusive "clip media" pick. */
  clipMediaSelected?: boolean;
  /** When defined, renders the clip-media toggle button. */
  onToggleClipMedia?: () => void;
};

const DRAG_THRESHOLD_PX = 5;

// Renders in long gallery columns (100+ instances), so it's wrapped in memo:
// a parent re-render skips re-rendering thumbs whose props are referentially
// equal. Callers should pass stable props/callbacks to get the full benefit.
export const Thumbnail = memo(function Thumbnail({
  image,
  selected,
  hidden,
  columnVersion,
  isDragSource,
  onSelect,
  onToggleStar,
  onDragStart,
  dragDisabled,
  clipMediaSelected,
  onToggleClipMedia,
}: Props) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [aspect, setAspect] = useState<number>(1);
  const rootRef = useRef<HTMLDivElement>(null);

  // Hover tooltip state
  const [tooltipMeta, setTooltipMeta] = useState<ImageMetadata | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaCache = useRef<ImageMetadata | null | "loading">(null);

  // When selection arrives via keyboard nav the thumb may be offscreen; scroll
  // it back into view. "nearest" avoids jumpy scrolls for already-visible rows.
  useEffect(() => {
    if (selected) rootRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const srcUrl = image.isVideo ? (image.thumbPath ? fileSrc(image.thumbPath) : null) : fileSrc(image.path);

  // Reset aspect when image changes so the old ratio doesn't persist briefly.
  useEffect(() => { setAspect(1); }, [srcUrl]);

  // Drag origin: start tracking on pointerdown, only convert to a drag once the
  // pointer has moved past the threshold. Below threshold = the click handler runs.
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if (dragDisabled) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        cleanup();
        onDragStart({
          fromPath: image.path,
          fromColumnVersion: columnVersion,
          pointerEvent: e,
        });
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
  }

  function onMouseEnter(e: React.MouseEvent) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
    hoverTimerRef.current = setTimeout(async () => {
      let m = metaCache.current;
      if (m === null || m === "loading") {
        metaCache.current = "loading";
        m = await cmd.image_metadata_read(image.path).catch(() => null) as ImageMetadata | null;
        metaCache.current = m;
      }
      setTooltipMeta(m);
    }, 600);
  }

  function onMouseMove(e: React.MouseEvent) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }

  function onMouseLeave() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setTooltipMeta(null);
    setTooltipPos(null);
  }

  const tooltipPrompt = tooltipMeta
    ? [tooltipMeta.sequencePrompt, ...(tooltipMeta.shotPrompts ?? (tooltipMeta.shotPrompt ? [tooltipMeta.shotPrompt] : [tooltipMeta.prompt]))]
        .filter(Boolean)
        .join(" / ")
    : null;

  if (hidden) return null;

  return (
    <div
      ref={rootRef}
      className={`group relative w-full shrink-0 overflow-hidden cursor-pointer border ${
        selected ? "border-accent" : "border-transparent"
      } ${isDragSource ? "opacity-40" : ""} bg-bg`}
      style={{ paddingBottom: `${aspect * 100}%` }}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {srcUrl ? (
        <img
          src={srcUrl}
          loading="lazy"
          decoding="async"
          alt=""
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth > 0) setAspect(el.naturalHeight / el.naturalWidth);
          }}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : image.isVideo ? (
        <video
          src={fileSrc(image.path)}
          preload="metadata"
          muted
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth > 0) setAspect(v.videoHeight / v.videoWidth);
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-dim text-text">
          <span className="material-symbols-outlined" style={{ fontSize: 40 }}>
            play_circle
          </span>
        </div>
      )}
      {image.isVideo && (
        <span
          className="absolute top-1 right-1 material-symbols-outlined text-text drop-shadow"
          style={{ fontSize: 18 }}
        >
          play_circle
        </span>
      )}
      {/* Corner toggles: hidden by default, visible on hover; stay visible + accent when ON. */}
      <IconBtn
        name="visibility"
        size={18}
        fill={!!image.starred}
        title={image.starred ? "Remove from favorites" : "Add to favorites"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar();
        }}
        className={`absolute bottom-1 left-1 drop-shadow transition-opacity ${
          image.starred
            ? "opacity-100 text-accent"
            : "opacity-0 group-hover:opacity-100"
        }`}
      />
      {onToggleClipMedia && (
        <IconBtn
          name="movie"
          size={18}
          fill={!!clipMediaSelected}
          title={clipMediaSelected ? "Clear clip media" : "Set as clip media"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleClipMedia();
          }}
          className={`absolute bottom-1 right-1 drop-shadow transition-opacity ${
            clipMediaSelected
              ? "opacity-100 text-accent"
              : "opacity-0 group-hover:opacity-100"
          }`}
        />
      )}

      {tooltipPos && tooltipMeta !== null && (
        <div
          className="fixed z-50 pointer-events-none max-w-xs bg-panel/95 border border-dim shadow-xl px-2 py-1.5 text-xs"
          style={{
            left: Math.min(tooltipPos.x + 12, window.innerWidth - 260),
            top: tooltipPos.y - 8,
            transform: "translateY(-100%)",
          }}
        >
          <div className="font-mono text-text truncate">{image.filename}</div>
          {tooltipPrompt && (
            <div className="text-dim mt-0.5 line-clamp-4 whitespace-pre-wrap">{tooltipPrompt}</div>
          )}
        </div>
      )}

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
