import { useEffect, useMemo, useState } from "react";
import type { GalleryImage, ImageMetadata } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { IconBtn } from "./IconBtn";
import { PathContextMenu } from "./PathContextMenu";
import { DrawMode } from "./DrawMode";
import { CropMode } from "./CropMode";
import { useSessionStore } from "../stores/sessionStore";
import { cmd } from "../lib/tauri";

type Props = {
  image: GalleryImage;
  onClose: () => void;
  onAddToRefs: () => void;
  onCopySettings: () => void;
  onTrace: () => void;
  onDelete: () => void;
};

export function ImageZoomModal({
  image,
  onClose,
  onAddToRefs,
  onCopySettings,
  onTrace,
  onDelete,
}: Props) {
  const [fit, setFit] = useState<"fit" | "one">("fit");
  const [meta, setMeta] = useState<ImageMetadata | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const columns = useSessionStore((s) => s.columns);
  const setZoomImage = useSessionStore((s) => s.setZoomImage);
  const zoomInitialMode = useSessionStore((s) => s.zoomInitialMode);
  const setZoomInitialMode = useSessionStore((s) => s.setZoomInitialMode);

  // Consume the one-shot mode flag set by the gallery edit/crop shortcut.
  useEffect(() => {
    if (zoomInitialMode === "draw") {
      setDrawMode(true);
      setZoomInitialMode(null);
    } else if (zoomInitialMode === "crop") {
      setCropMode(true);
      setZoomInitialMode(null);
    }
  }, [zoomInitialMode, setZoomInitialMode]);

  // Flat image list across all columns in display order, for prev/next nav.
  const flatImages = useMemo(
    () => columns.flatMap((c) => c.images),
    [columns],
  );
  const currentIdx = flatImages.findIndex((i) => i.path === image.path);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < flatImages.length - 1;

  const step = (delta: number) => {
    if (currentIdx < 0) return;
    const next = currentIdx + delta;
    if (next < 0 || next >= flatImages.length) return;
    setZoomImage(flatImages[next].path);
  };

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " ") {
        e.preventDefault();
        setFit((f) => (f === "fit" ? "one" : "fit"));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // step closes over currentIdx/flatImages; re-bind each render is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, currentIdx, flatImages.length]);

  useEffect(() => {
    let cancelled = false;
    cmd
      .image_metadata_read(image.path)
      .then((m) => {
        if (!cancelled) setMeta(m as ImageMetadata | null);
      })
      .catch(() => {
        if (!cancelled) setMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [image.path]);

  const src = fileSrc(image.path);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/90 flex flex-col"
      onClick={onClose}
    >
      <div className="flex-1 min-h-0 overflow-auto thin-scroll flex items-center justify-center relative">
        {image.isVideo ? (
          <video
            src={src}
            controls
            autoPlay
            className={fit === "fit" ? "max-h-full max-w-full" : ""}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={onCtx}
          />
        ) : (
          <img
            src={src}
            alt={image.filename}
            className={fit === "fit" ? "max-h-full max-w-full object-contain" : ""}
            style={fit === "one" ? { maxWidth: "none", maxHeight: "none" } : undefined}
            onClick={(e) => {
              e.stopPropagation();
              setFit((f) => (f === "fit" ? "one" : "fit"));
            }}
            onContextMenu={onCtx}
          />
        )}
        {hasPrev && (
          <button
            type="button"
            title="Previous (←)"
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-panel/70 hover:bg-panel text-text rounded-full p-1"
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
          >
            <IconBtn name="chevron_left" size={32} />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            title="Next (→)"
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-panel/70 hover:bg-panel text-text rounded-full p-1"
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
          >
            <IconBtn name="chevron_right" size={32} />
          </button>
        )}
      </div>

      <div
        className="bg-panel text-text p-3 flex items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono truncate" title={image.path}>
            {image.filename}
          </div>
          {meta && (
            <div className="text-xs text-dim truncate">
              {meta.model}
              {meta.iterationTotal ? ` · ${meta.iterationIndex}/${meta.iterationTotal}` : ""} ·{" "}
              {meta.timestamp}
            </div>
          )}
          {meta?.shotPrompt || meta?.prompt ? (
            <div className="text-xs truncate" title={meta.shotPrompt ?? meta.prompt ?? ""}>
              {meta.shotPrompt ?? meta.prompt}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn name="add_photo_alternate" size={20} title="Add to refs" onClick={onAddToRefs} />
          <IconBtn name="copy_all" size={20} title="Reuse prompt" onClick={onCopySettings} />
          <IconBtn name="conversion_path" size={20} title="Trace" onClick={onTrace} />
          {!image.isVideo && (
            <IconBtn name="crop" size={20} title="Crop" onClick={() => setCropMode(true)} />
          )}
          {!image.isVideo && (
            <IconBtn name="edit" size={20} title="Draw / paint" onClick={() => setDrawMode(true)} />
          )}
          <IconBtn name="delete" size={20} title="Delete" onClick={onDelete} />
          <div className="w-3" />
          <IconBtn name="close" size={24} title="Close (Esc)" onClick={onClose} />
        </div>
      </div>
      {drawMode && (
        <DrawMode
          image={image}
          onSave={() => setDrawMode(false)}
          onCancel={() => setDrawMode(false)}
        />
      )}
      {cropMode && (
        <CropMode
          image={image}
          onSave={() => setCropMode(false)}
          onCancel={() => setCropMode(false)}
        />
      )}
      {menuPos && (
        <PathContextMenu
          x={menuPos.x}
          y={menuPos.y}
          path={image.path}
          onClose={() => setMenuPos(null)}
          items={[
            "add_to_refs",
            "copy_settings",
            "---",
            "zoom",
            "edit",
            "crop",
            "trace",
            "---",
            "toggle_star",
            "set_clip_media",
            "---",
            "copy_prompt",
            "copy_path",
            "copy_image",
            "copy_to_global_src",
            "open_location",
            "rename",
            "---",
            "delete",
          ]}
        />
      )}
    </div>
  );
}
