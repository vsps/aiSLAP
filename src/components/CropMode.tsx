import { useCallback, useEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { cmd } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import { showMessage } from "../lib/dialog";
import { dirname, basename } from "../lib/paths";

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "tl" | "tc" | "tr" | "ml" | "mr" | "bl" | "bc" | "br" | "move";

type Props = {
  image: GalleryImage;
  onSave: (newPath: string) => void;
  onCancel: () => void;
};

const MIN = 20;

const HANDLES: { id: Exclude<Handle, "move">; cursor: string; style: React.CSSProperties }[] = [
  { id: "tl", cursor: "nwse-resize", style: { top: -4, left: -4 } },
  { id: "tc", cursor: "ns-resize",   style: { top: -4, left: "50%", marginLeft: -4 } },
  { id: "tr", cursor: "nesw-resize", style: { top: -4, right: -4 } },
  { id: "ml", cursor: "ew-resize",   style: { top: "50%", left: -4, marginTop: -4 } },
  { id: "mr", cursor: "ew-resize",   style: { top: "50%", right: -4, marginTop: -4 } },
  { id: "bl", cursor: "nesw-resize", style: { bottom: -4, left: -4 } },
  { id: "bc", cursor: "ns-resize",   style: { bottom: -4, left: "50%", marginLeft: -4 } },
  { id: "br", cursor: "nwse-resize", style: { bottom: -4, right: -4 } },
];

function applyDrag(
  handle: Handle,
  start: Rect,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
  lockAspect: boolean,
): Rect {
  if (handle === "move") {
    return {
      x: Math.max(0, Math.min(imgW - start.w, start.x + dx)),
      y: Math.max(0, Math.min(imgH - start.h, start.y + dy)),
      w: start.w,
      h: start.h,
    };
  }

  if (!lockAspect) {
    let { x, y, w, h } = start;
    if (handle === "tl" || handle === "ml" || handle === "bl") {
      const nx = Math.max(0, Math.min(x + w - MIN, x + dx));
      w = x + w - nx; x = nx;
    }
    if (handle === "tr" || handle === "mr" || handle === "br") {
      w = Math.max(MIN, Math.min(imgW - x, w + dx));
    }
    if (handle === "tl" || handle === "tc" || handle === "tr") {
      const ny = Math.max(0, Math.min(y + h - MIN, y + dy));
      h = y + h - ny; y = ny;
    }
    if (handle === "bl" || handle === "bc" || handle === "br") {
      h = Math.max(MIN, Math.min(imgH - y, h + dy));
    }
    return { x, y, w, h };
  }

  // Aspect-locked path. Lock to the source image aspect ratio.
  const ar = imgW / imgH;
  const { x: sx, y: sy, w: sw, h: sh } = start;
  const fixedR = sx + sw;
  const fixedB = sy + sh;
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;

  let newW: number, newH: number, newX: number, newY: number;

  if (handle === "tc" || handle === "bc") {
    newH = Math.max(MIN, sh + (handle === "tc" ? -dy : dy));
    newW = newH * ar;
    newX = cx - newW / 2;
    newY = handle === "tc" ? fixedB - newH : sy;
  } else if (handle === "ml" || handle === "mr") {
    newW = Math.max(MIN, sw + (handle === "ml" ? -dx : dx));
    newH = newW / ar;
    newX = handle === "ml" ? fixedR - newW : sx;
    newY = cy - newH / 2;
  } else {
    // Corner — dominant axis wins, opposite corner stays anchored.
    const anchorRight = handle === "tl" || handle === "bl";
    const anchorBottom = handle === "tl" || handle === "tr";
    const candW = sw + (anchorRight ? -dx : dx);
    const candH = sh + (anchorBottom ? -dy : dy);
    if (candW / sw > candH / sh) {
      newW = Math.max(MIN, candW);
      newH = newW / ar;
    } else {
      newH = Math.max(MIN, candH);
      newW = newH * ar;
    }
    newX = anchorRight ? fixedR - newW : sx;
    newY = anchorBottom ? fixedB - newH : sy;
  }

  // If the proposed rect leaves the image, reject — keep the previous state.
  if (newW < MIN || newH < MIN) return start;
  if (newX < 0 || newY < 0 || newX + newW > imgW || newY + newH > imgH) return start;

  return { x: newX, y: newY, w: newW, h: newH };
}

export function CropMode({ image, onSave, onCancel }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgReady, setImgReady] = useState(false);
  const [imgBounds, setImgBounds] = useState<DOMRect | null>(null);
  const [naturalSize, setNaturalSize] = useState<[number, number]>([0, 0]);
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [rotation, setRotation] = useState<0 | 270>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const dragRef = useRef<{ handle: Handle; startX: number; startY: number; startCrop: Rect; imgW: number; imgH: number } | null>(null);

  const updateBounds = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setImgBounds(b);
    setCrop((c) => (c.w === 0 ? { x: 0, y: 0, w: b.width, h: b.height } : c));
  }, []);

  useEffect(() => {
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [updateBounds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function startDrag(e: React.PointerEvent, handle: Handle) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { handle, startX: e.clientX, startY: e.clientY, startCrop: { ...crop }, imgW: imgBounds!.width, imgH: imgBounds!.height };
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setCrop(applyDrag(d.handle, d.startCrop, e.clientX - d.startX, e.clientY - d.startY, d.imgW, d.imgH, !e.shiftKey));
  }

  function stopDrag(e: React.PointerEvent) {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const save = async () => {
    const img = imgRef.current;
    if (!img || !imgBounds) return;
    setSaving(true);
    try {
      const scaleX = img.naturalWidth / imgBounds.width;
      const scaleY = img.naturalHeight / imgBounds.height;
      const sx = Math.round(crop.x * scaleX);
      const sy = Math.round(crop.y * scaleY);
      const sw = Math.round(crop.w * scaleX);
      const sh = Math.round(crop.h * scaleY);

      const { readFile } = await import("@tauri-apps/plugin-fs");
      const ext = image.path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      const bytes = await readFile(image.path);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const cleanImg = new Image();
      cleanImg.src = blobUrl;
      await new Promise<void>((res, rej) => { cleanImg.onload = () => res(); cleanImg.onerror = () => rej(new Error("load failed")); });

      const outW = rotation === 270 ? sh : sw;
      const outH = rotation === 270 ? sw : sh;
      const offscreen = document.createElement("canvas");
      offscreen.width = outW;
      offscreen.height = outH;
      const ctx = offscreen.getContext("2d")!;
      ctx.save();
      ctx.translate(outW / 2, outH / 2);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      if (flipH) ctx.scale(-1, 1);
      if (flipV) ctx.scale(1, -1);
      ctx.drawImage(cleanImg, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
      URL.revokeObjectURL(blobUrl);

      const base64 = offscreen.toDataURL("image/png").split(",")[1];
      const dir = dirname(image.path);
      const name = basename(image.path).replace(/\.[^.]+$/, "");
      const savePath = `${dir}/${name}_crop.png`;
      await cmd.save_png_base64(savePath, base64);
      await useSessionStore.getState().rescanShot();
      onSave(savePath);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const src = fileSrc(image.path);
  const ib = imgBounds;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden">
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain select-none"
          style={{ userSelect: "none", transform: `rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})` }}
          onLoad={() => {
            const img = imgRef.current!;
            setNaturalSize([img.naturalWidth, img.naturalHeight]);
            setImgReady(true);
            updateBounds();
          }}
        />
        {imgReady && ib && (
          <div className="fixed" style={{ left: ib.left, top: ib.top, width: ib.width, height: ib.height, pointerEvents: "none" }}>
            {/* Dark overlay strips outside crop */}
            <div className="absolute bg-black/60" style={{ top: 0, left: 0, right: 0, height: crop.y }} />
            <div className="absolute bg-black/60" style={{ top: crop.y + crop.h, left: 0, right: 0, bottom: 0 }} />
            <div className="absolute bg-black/60" style={{ top: crop.y, left: 0, width: crop.x, height: crop.h }} />
            <div className="absolute bg-black/60" style={{ top: crop.y, left: crop.x + crop.w, right: 0, height: crop.h }} />

            {/* Crop rect */}
            <div
              className="absolute border border-white"
              style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h, pointerEvents: "auto", cursor: "move" }}
              onPointerDown={(e) => startDrag(e, "move")}
              onPointerMove={onMove}
              onPointerUp={stopDrag}
              onPointerCancel={() => { dragRef.current = null; }}
            >
              {/* Rule-of-thirds guides */}
              <div className="absolute inset-0 opacity-20" style={{ pointerEvents: "none" }}>
                <div className="absolute bg-white" style={{ left: "33.33%", top: 0, width: 1, height: "100%" }} />
                <div className="absolute bg-white" style={{ left: "66.67%", top: 0, width: 1, height: "100%" }} />
                <div className="absolute bg-white" style={{ top: "33.33%", left: 0, height: 1, width: "100%" }} />
                <div className="absolute bg-white" style={{ top: "66.67%", left: 0, height: 1, width: "100%" }} />
              </div>

              {/* Resize handles */}
              {HANDLES.map(({ id, cursor, style }) => (
                <div
                  key={id}
                  className="absolute w-2 h-2 bg-white border border-black/50"
                  style={{ ...style, cursor }}
                  onPointerDown={(e) => startDrag(e, id)}
                  onPointerMove={onMove}
                  onPointerUp={stopDrag}
                  onPointerCancel={() => { dragRef.current = null; }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="bg-panel text-text p-2 flex items-center gap-3" onMouseDown={(e) => e.stopPropagation()}>
        {ib && naturalSize[0] > 0 && (
          <span className="text-xs text-dim font-mono">
            {Math.round(crop.w / ib.width * naturalSize[0])} × {Math.round(crop.h / ib.height * naturalSize[1])} px
          </span>
        )}
        <span className="text-xs text-dim">hold Shift for free aspect</span>
        <div className="w-px h-4 bg-dim/40 mx-1" />
        <button
          title="Rotate 90° CCW"
          onClick={() => setRotation((r) => (r === 270 ? 0 : 270))}
          className={`text-xs px-2 py-0.5 border ${rotation ? "border-accent text-accent" : "border-dim text-dim hover:border-text hover:text-text"}`}
        >
          ↺ 90°
        </button>
        <button
          title="Flip horizontal"
          onClick={() => setFlipH((v) => !v)}
          className={`text-xs px-2 py-0.5 border ${flipH ? "border-accent text-accent" : "border-dim text-dim hover:border-text hover:text-text"}`}
        >
          ↔
        </button>
        <button
          title="Flip vertical"
          onClick={() => setFlipV((v) => !v)}
          className={`text-xs px-2 py-0.5 border ${flipV ? "border-accent text-accent" : "border-dim text-dim hover:border-text hover:text-text"}`}
        >
          ↕
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void save()}
          disabled={saving}
          className="text-xs px-3 py-0.5 bg-accent text-text hover:opacity-80 disabled:opacity-40"
        >
          {saving ? "saving…" : "crop & save"}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
