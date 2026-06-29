import { useCallback, useEffect, useRef, useState } from "react";
import { fileSrc } from "../lib/assets";
import { basename } from "../lib/paths";
import { guessContentType } from "../lib/args";
import { showMessage } from "../lib/dialog";
import { FalProvider } from "../lib/providers/fal";
import type { SamBox, SamPoint } from "../lib/types";

type Props = {
  sourcePath: string;
  mediaKind: "image" | "video";
  points: SamPoint[];
  boxes: SamBox[];
  onSave: (points: SamPoint[], boxes: SamBox[]) => void;
  onClose: () => void;
};

type Arm = "point" | "box" | null;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Grab a single video frame as a PNG blob via an offscreen blob-URL video
// (avoids canvas taint from the asset protocol). `time` is in seconds.
async function captureVideoFrame(path: string, time: number): Promise<Blob> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error("video load failed"));
    });
    await new Promise<void>((res) => {
      const target = Math.min(time, v.duration || time);
      if (Math.abs(v.currentTime - target) < 0.01) return res();
      v.onseeked = () => res();
      v.currentTime = target;
    });
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("frame capture failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SamPromptModal({ sourcePath, mediaKind, points, boxes, onSave, onClose }: Props) {
  const mediaRef = useRef<HTMLImageElement & HTMLVideoElement>(null);
  const [pts, setPts] = useState<SamPoint[]>(points);
  const [bxs, setBxs] = useState<SamBox[]>(boxes);
  const [arm, setArm] = useState<Arm>(null);
  const [newLabel, setNewLabel] = useState<0 | 1>(1);
  const [fps, setFps] = useState(30);
  const [frame, setFrame] = useState(0);
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const [nat, setNat] = useState<[number, number]>([0, 0]);
  // Rubber-band box preview in display (overlay-local) coords.
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number } | null>(null);
  // Mask preview (one-off SAM call).
  const [previewing, setPreviewing] = useState(false);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [previewFrame, setPreviewFrame] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isVideo = mediaKind === "video";

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateBounds = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    setBounds(el.getBoundingClientRect());
    const w = isVideo ? el.videoWidth : el.naturalWidth;
    const h = isVideo ? el.videoHeight : el.naturalHeight;
    if (w && h) setNat([w, h]);
  }, [isVideo]);

  useEffect(() => {
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [updateBounds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (arm) setArm(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [arm, onClose]);

  const [natW, natH] = nat;
  const sx = bounds && natW ? bounds.width / natW : 1;
  const sy = bounds && natH ? bounds.height / natH : 1;

  // Overlay-local client → image-pixel space.
  function toPx(clientX: number, clientY: number): [number, number] | null {
    const el = mediaRef.current;
    if (!el || !natW || !natH) return null;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    const x = clamp(Math.round((clientX - b.left) * (natW / b.width)), 0, natW);
    const y = clamp(Math.round((clientY - b.top) * (natH / b.height)), 0, natH);
    return [x, y];
  }

  function addPointAt(clientX: number, clientY: number) {
    const p = toPx(clientX, clientY);
    if (!p) return;
    const pt: SamPoint = { x: p[0], y: p[1], label: newLabel, object_id: 0 };
    if (isVideo) pt.frame_index = frame;
    setPts((arr) => [...arr, pt]);
  }

  function onOverlayPointerDown(e: React.PointerEvent) {
    if (arm === "point") {
      addPointAt(e.clientX, e.clientY);
      return;
    }
    if (arm === "box") {
      const el = mediaRef.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { sx: e.clientX - b.left, sy: e.clientY - b.top };
      setDraft({ x: e.clientX - b.left, y: e.clientY - b.top, w: 0, h: 0 });
    }
  }

  function onOverlayPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || arm !== "box") return;
    const el = mediaRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const cx = e.clientX - b.left;
    const cy = e.clientY - b.top;
    setDraft({ x: Math.min(d.sx, cx), y: Math.min(d.sy, cy), w: Math.abs(cx - d.sx), h: Math.abs(cy - d.sy) });
  }

  function onOverlayPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || arm !== "box" || !natW) {
      setDraft(null);
      return;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
    const el = mediaRef.current!;
    const b = el.getBoundingClientRect();
    const cx = e.clientX - b.left;
    const cy = e.clientY - b.top;
    const x1 = clamp(Math.round(Math.min(d.sx, cx) * (natW / b.width)), 0, natW);
    const y1 = clamp(Math.round(Math.min(d.sy, cy) * (natH / b.height)), 0, natH);
    const x2 = clamp(Math.round(Math.max(d.sx, cx) * (natW / b.width)), 0, natW);
    const y2 = clamp(Math.round(Math.max(d.sy, cy) * (natH / b.height)), 0, natH);
    setDraft(null);
    if (x2 - x1 < 2 || y2 - y1 < 2) return; // ignore stray clicks
    const box: SamBox = { x_min: x1, y_min: y1, x_max: x2, y_max: y2, object_id: 0 };
    if (isVideo) box.frame_index = frame;
    setBxs((arr) => [...arr, box]);
  }

  async function runPreview() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPreviewing(true);
    try {
      const provider = new FalProvider();
      await provider.prepare();

      let blob: Blob;
      let name: string;
      if (isVideo) {
        blob = await captureVideoFrame(sourcePath, mediaRef.current?.currentTime ?? 0);
        name = "frame.png";
      } else {
        blob = await fetch(fileSrc(sourcePath)).then((r) => r.blob());
        name = basename(sourcePath) || "source.png";
      }
      if (ac.signal.aborted) return;
      const file = new File([blob], name, { type: blob.type || guessContentType(name) });
      const url = await provider.uploadFile(file, ac.signal);

      // For video, segment only the current frame's prompts (frame_index stripped).
      const srcPts = isVideo ? pts.filter((p) => (p.frame_index ?? 0) === frame) : pts;
      const srcBxs = isVideo ? bxs.filter((b) => (b.frame_index ?? 0) === frame) : bxs;
      const input: Record<string, unknown> = { image_url: url };
      if (srcPts.length) {
        input.point_prompts = srcPts.map((p) => ({ x: p.x, y: p.y, label: p.label, object_id: p.object_id ?? 0 }));
      }
      if (srcBxs.length) {
        input.box_prompts = srcBxs.map((b) => ({ x_min: b.x_min, y_min: b.y_min, x_max: b.x_max, y_max: b.y_max, object_id: b.object_id ?? 0 }));
      }

      const out = await provider.run("fal-ai/sam-3/image", input, ac.signal, () => {});
      if (ac.signal.aborted) return;
      setMaskUrl(out.files[0]?.url ?? null);
      setPreviewFrame(isVideo ? frame : null);
    } catch (e) {
      if (!ac.signal.aborted) await showMessage(String(e), { kind: "error" });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setPreviewing(false);
    }
  }

  const src = fileSrc(sourcePath);
  const showMask = !!maskUrl && (!isVideo || frame === previewFrame);
  const visiblePts = isVideo ? pts.filter((p) => (p.frame_index ?? 0) === frame) : pts;
  const visibleBxs = isVideo ? bxs.filter((b) => (b.frame_index ?? 0) === frame) : bxs;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-1 min-h-0">
        {/* Media + pick overlay */}
        <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden">
          {isVideo ? (
            <video
              ref={mediaRef}
              src={src}
              controls
              className="max-h-full max-w-full object-contain select-none"
              onLoadedMetadata={updateBounds}
              onTimeUpdate={(e) => setFrame(Math.round(e.currentTarget.currentTime * fps))}
            />
          ) : (
            <img
              ref={mediaRef}
              src={src}
              alt=""
              draggable={false}
              className="max-h-full max-w-full object-contain select-none"
              onLoad={updateBounds}
            />
          )}
          {bounds && (
            <div
              className="fixed"
              style={{
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
                pointerEvents: arm ? "auto" : "none",
                cursor: arm ? "crosshair" : "default",
              }}
              onPointerDown={onOverlayPointerDown}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={onOverlayPointerUp}
              onPointerCancel={() => { dragRef.current = null; setDraft(null); }}
            >
              {showMask && (
                <img
                  src={maskUrl!}
                  alt=""
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.6, pointerEvents: "none" }}
                />
              )}
              {visibleBxs.map((b, i) => (
                <div
                  key={`b${i}`}
                  className="absolute border-2 border-cyan-400"
                  style={{ left: b.x_min * sx, top: b.y_min * sy, width: (b.x_max - b.x_min) * sx, height: (b.y_max - b.y_min) * sy, pointerEvents: "none" }}
                />
              ))}
              {visiblePts.map((p, i) => (
                <div
                  key={`p${i}`}
                  className="absolute w-3 h-3 rounded-full border-2 border-white -translate-x-1/2 -translate-y-1/2"
                  style={{ left: p.x * sx, top: p.y * sy, background: p.label === 1 ? "#22c55e" : "#ef4444", pointerEvents: "none" }}
                />
              ))}
              {draft && (
                <div
                  className="absolute border-2 border-dashed border-cyan-300"
                  style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h, pointerEvents: "none" }}
                />
              )}
            </div>
          )}
        </div>

        {/* Side list */}
        <div className="w-72 shrink-0 bg-panel text-text border-l border-dim flex flex-col">
          <div className="p-2 text-xs font-mono opacity-70 border-b border-dim">
            {pts.length} point{pts.length === 1 ? "" : "s"} · {bxs.length} box{bxs.length === 1 ? "" : "es"}
            {natW > 0 && <span className="opacity-50"> · {natW}×{natH}px</span>}
          </div>
          <div className="flex-1 overflow-y-auto thin-scroll p-2 flex flex-col gap-2">
            {pts.map((p, i) => (
              <div key={`pl${i}`} className="flex items-center gap-1 text-[11px] font-mono">
                <span className="w-8 opacity-60">pt{i}</span>
                <NumCell value={p.x} onChange={(v) => setPts((a) => a.map((q, j) => (j === i ? { ...q, x: v } : q)))} />
                <NumCell value={p.y} onChange={(v) => setPts((a) => a.map((q, j) => (j === i ? { ...q, y: v } : q)))} />
                <button
                  className={`px-1 ${p.label === 1 ? "text-green-400" : "text-red-400"}`}
                  title="toggle fg/bg"
                  onClick={() => setPts((a) => a.map((q, j) => (j === i ? { ...q, label: q.label === 1 ? 0 : 1 } : q)))}
                >
                  {p.label === 1 ? "fg" : "bg"}
                </button>
                {isVideo && <span className="opacity-50" title="frame">f{p.frame_index ?? 0}</span>}
                <button className="px-1 text-red-500 ml-auto" title="delete" onClick={() => setPts((a) => a.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {bxs.map((b, i) => (
              <div key={`bl${i}`} className="flex items-center gap-1 text-[11px] font-mono">
                <span className="w-8 opacity-60 text-cyan-400">bx{i}</span>
                <NumCell value={b.x_min} onChange={(v) => setBxs((a) => a.map((q, j) => (j === i ? { ...q, x_min: v } : q)))} />
                <NumCell value={b.y_min} onChange={(v) => setBxs((a) => a.map((q, j) => (j === i ? { ...q, y_min: v } : q)))} />
                <NumCell value={b.x_max} onChange={(v) => setBxs((a) => a.map((q, j) => (j === i ? { ...q, x_max: v } : q)))} />
                <NumCell value={b.y_max} onChange={(v) => setBxs((a) => a.map((q, j) => (j === i ? { ...q, y_max: v } : q)))} />
                {isVideo && <span className="opacity-50" title="frame">f{b.frame_index ?? 0}</span>}
                <button className="px-1 text-red-500 ml-auto" title="delete" onClick={() => setBxs((a) => a.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {pts.length === 0 && bxs.length === 0 && (
              <div className="text-xs text-dim">Arm a tool, then click (point) or drag (box) on the preview.</div>
            )}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-panel text-text p-2 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setArm((a) => (a === "point" ? null : "point"))}
          className={`text-xs px-3 py-0.5 border ${arm === "point" ? "border-accent text-accent" : "border-dim text-dim hover:border-text hover:text-text"}`}
        >
          + point
        </button>
        <button
          onClick={() => setNewLabel((l) => (l === 1 ? 0 : 1))}
          className={`text-xs px-2 py-0.5 border ${newLabel === 1 ? "border-green-500 text-green-400" : "border-red-500 text-red-400"}`}
          title="label for new points"
        >
          {newLabel === 1 ? "fg" : "bg"}
        </button>
        <button
          onClick={() => setArm((a) => (a === "box" ? null : "box"))}
          className={`text-xs px-3 py-0.5 border ${arm === "box" ? "border-accent text-accent" : "border-dim text-dim hover:border-text hover:text-text"}`}
        >
          + box
        </button>
        {isVideo && (
          <span className="text-xs text-dim flex items-center gap-1">
            <span>frame {frame}</span>
            <span className="opacity-50">@</span>
            <input
              type="number"
              min={1}
              value={fps}
              onChange={(e) => setFps(Math.max(1, parseInt(e.currentTarget.value, 10) || 1))}
              className="bg-bg text-text px-1 py-[1px] w-14"
              title="frames per second (to map scrub time → frame_index)"
            />
            <span className="opacity-50">fps</span>
          </span>
        )}
        <button
          onClick={() => { setPts([]); setBxs([]); }}
          disabled={pts.length === 0 && bxs.length === 0}
          className="text-xs px-2 py-0.5 text-red-500 hover:underline disabled:opacity-40 disabled:no-underline"
        >
          clear
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void runPreview()}
          disabled={previewing}
          className="text-xs px-3 py-0.5 border border-dim text-dim hover:border-text hover:text-text disabled:opacity-40"
          title="Run SAM on the current image/frame + prompts and overlay the mask"
        >
          {previewing ? "previewing…" : "preview"}
        </button>
        {maskUrl && (
          <button
            onClick={() => { setMaskUrl(null); setPreviewFrame(null); }}
            className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text"
          >
            clear preview
          </button>
        )}
        <button onClick={() => onSave(pts, bxs)} className="text-xs px-3 py-0.5 bg-accent text-text hover:opacity-80">save</button>
        <button onClick={onClose} className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text">cancel</button>
      </div>
    </div>
  );
}

function NumCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = parseInt(e.currentTarget.value, 10);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="bg-bg text-text px-1 py-[1px] w-14"
    />
  );
}
