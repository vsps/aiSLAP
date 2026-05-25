import { useEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { IconBtn } from "./IconBtn";
import { Icon } from "../lib/icon";
import { fileSrc } from "../lib/assets";
import { PathContextMenu } from "./PathContextMenu";

type Props = {
  image: GalleryImage;
  selected: boolean;
  hidden?: boolean;
  columnVersion: string;
  isDragSource?: boolean;
  onSelect: () => void;
  onZoom: () => void;
  onAddToRefs: () => void;
  onCopySettings: () => void;
  onEdit: () => void;
  onCrop?: () => void;
  onToggleStar: () => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  traceActive?: boolean;
  /** Disables drag start. Used in the starred view where drag-to-column has no destination. */
  dragDisabled?: boolean;
  /** Whether this image is currently the shot's exclusive "clip media" pick. */
  clipMediaSelected?: boolean;
  /** When defined, renders the clip-media toggle button. */
  onToggleClipMedia?: () => void;
};

const DRAG_THRESHOLD_PX = 5;

export function Thumbnail({
  image,
  selected,
  hidden,
  columnVersion,
  isDragSource,
  onSelect,
  onZoom,
  onAddToRefs,
  onCopySettings,
  onEdit,
  onCrop,
  onToggleStar,
  onDragStart,
  dragDisabled,
  clipMediaSelected,
  onToggleClipMedia,
}: Props) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Aspect = height/width. Initial 1 (square) while we probe the natural size,
  // then we update once the Image loads. Falls back to 1 for missing thumbs.
  const [aspect, setAspect] = useState<number>(1);
  const rootRef = useRef<HTMLDivElement>(null);

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
      title={image.filename}
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
      {image.starred && (
        <span
          className="absolute bottom-1 left-1 text-accent drop-shadow pointer-events-none group-hover:opacity-0 transition-opacity"
        >
          <Icon name="visibility" size={18} fill />
        </span>
      )}
      {clipMediaSelected && (
        <span
          className="absolute bottom-1 right-1 text-accent drop-shadow pointer-events-none group-hover:opacity-0 transition-opacity"
          title="Clip media"
        >
          <Icon name="movie" size={18} fill />
        </span>
      )}

      {/* Action strip — top */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center gap-[2px] bg-bg/80 px-[2px] py-[1px] opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <IconBtn
          name="visibility"
          size={16}
          fill={!!image.starred}
          title={image.starred ? "Demote from gallery" : "Promote to gallery"}
          onClick={onToggleStar}
          className={image.starred ? "text-accent" : ""}
        />
        {onToggleClipMedia && (
          <IconBtn
            name="movie"
            size={16}
            fill={!!clipMediaSelected}
            title={clipMediaSelected ? "Clear clip media" : "Set as clip media"}
            onClick={onToggleClipMedia}
            className={clipMediaSelected ? "text-accent" : ""}
          />
        )}
        <IconBtn name="zoom_in" size={16} title="Zoom" onClick={onZoom} />
        <IconBtn name="add_photo_alternate" size={16} title="Use as reference" onClick={onAddToRefs} />
        <IconBtn name="copy_all" size={16} title="Reuse prompt" onClick={onCopySettings} />
        {!image.isVideo && onCrop && (
          <IconBtn name="crop" size={16} title="Crop" onClick={onCrop} />
        )}
        {!image.isVideo && (
          <IconBtn name="edit" size={16} title="Edit (draw)" onClick={onEdit} />
        )}
      </div>

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
}
