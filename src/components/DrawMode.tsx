import { useCallback, useEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { cmd } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import { showMessage } from "../lib/dialog";
import { dirname, basename } from "../lib/paths";
import { FullscreenModal } from "./FullscreenModal";

type Tool = "brush" | "line";

type Stroke = {
  color: string;
  size: number;
  erase: boolean;
  kind: Tool;
  points: [number, number][];
};

const COLORS = [
  "#ffffff", "#000000", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#06b6d4", "#3b82f6",
  "#a855f7", "#ec4899",
];

const SIZES = [4, 8, 16, 28, 44, 64];

// Traces a stroke's path on `ctx` (caller sets style + strokes/fills). Line
// strokes are just their two endpoints; brush strokes get the running
// quadratic-midpoint smoothing that turns raw sampled points into a smooth
// curve.
function tracePath(ctx: CanvasRenderingContext2D, kind: Tool, points: [number, number][]) {
  ctx.moveTo(points[0][0], points[0][1]);
  if (kind === "line") {
    const [x1, y1] = points[points.length - 1];
    ctx.lineTo(x1, y1);
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
}

type Props = {
  image: GalleryImage;
  onSave: (newPath: string) => void;
  onCancel: () => void;
};

export function DrawMode({ image, onSave, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);

  // Lazy brush state
  const brushPosRef = useRef<[number, number] | null>(null);
  const cursorPosRef = useRef<[number, number] | null>(null);
  const rafRef = useRef<number | null>(null);

  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState(SIZES[1]);
  const [erase, setErase] = useState(false);
  const [tool, setTool] = useState<Tool>("brush");
  const [smoothing, setSmoothing] = useState(15);
  const [saving, setSaving] = useState(false);
  const [imgReady, setImgReady] = useState(false);
  const [imgBounds, setImgBounds] = useState<DOMRect | null>(null);


  // Update canvas bounds when image loads or window resizes
  const updateBounds = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setImgBounds(el.getBoundingClientRect());
  }, []);

  useEffect(() => {
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [updateBounds]);

  // Render all strokes onto the canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgBounds) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of [
      ...strokesRef.current,
      ...(currentStrokeRef.current ? [currentStrokeRef.current] : []),
    ]) {
      if (s.points.length < 2) continue;
      ctx.save();
      ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      tracePath(ctx, s.kind, s.points);
      ctx.stroke();
      ctx.restore();
    }

    // Draw lazy brush indicator (brush tool only — line tool has no leash).
    const brush = tool === "brush" ? brushPosRef.current : null;
    const cursor = tool === "brush" ? cursorPosRef.current : null;
    if (brush && cursor) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      // Line from brush to cursor
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(brush[0], brush[1]);
      ctx.lineTo(cursor[0], cursor[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Cursor dot
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(cursor[0], cursor[1], 3, 0, Math.PI * 2);
      ctx.fill();
      // Brush circle
      ctx.strokeStyle = erase ? "rgba(255,100,100,0.8)" : color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(brush[0], brush[1], size / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }, [imgBounds, color, size, erase, tool]);

  // Lazy-brush loop: the brush trails the cursor on a leash of length
  // `smoothing`. Each frame the brush only moves the slack beyond that radius
  // toward the cursor, so jittery input is damped into smooth strokes. Runs on
  // rAF while drawing; with smoothing 0 the brush snaps to the cursor exactly.
  const animateBrush = useCallback(() => {
    const cursor = cursorPosRef.current;
    const brush = brushPosRef.current;
    if (!cursor || !brush) return;

    const dx = cursor[0] - brush[0];
    const dy = cursor[1] - brush[1];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (smoothing === 0 || dist <= 1) {
      brushPosRef.current = cursor;
    } else if (dist > smoothing) {
      // Pull the brush forward by exactly the overshoot past the leash radius.
      const t = 1 - smoothing / dist;
      brushPosRef.current = [brush[0] + dx * t, brush[1] + dy * t];
    }

    const newBrush = brushPosRef.current!;
    if (drawingRef.current && currentStrokeRef.current) {
      const pts = currentStrokeRef.current.points;
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - newBrush[0]) > 0.5 || Math.abs(last[1] - newBrush[1]) > 0.5) {
        pts.push([newBrush[0], newBrush[1]]);
      }
    }
    render();
    rafRef.current = requestAnimationFrame(animateBrush);
  }, [smoothing, render]);

  const startBrushLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(animateBrush);
  }, [animateBrush]);

  const stopBrushLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Mouse handlers (relative to canvas)
  const toCanvas = (e: React.MouseEvent): [number, number] => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pt = toCanvas(e);
    if (tool === "line") {
      // Straight lines are just two endpoints — no lazy-brush leash, the
      // second point is dragged live in onMouseMove until release.
      currentStrokeRef.current = { color, size, erase, kind: "line", points: [pt, pt] };
      drawingRef.current = true;
      render();
      return;
    }
    brushPosRef.current = pt;
    cursorPosRef.current = pt;
    currentStrokeRef.current = { color, size, erase, kind: "brush", points: [pt] };
    drawingRef.current = true;
    startBrushLoop();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const pt = toCanvas(e);
    cursorPosRef.current = pt;
    if (tool === "line") {
      if (drawingRef.current && currentStrokeRef.current) {
        currentStrokeRef.current.points[1] = pt;
        render();
      }
      return;
    }
    if (!drawingRef.current) {
      // Brush follows cursor instantly when idle; lag only applies mid-stroke
      brushPosRef.current = pt;
      render();
    }
  };

  const onMouseUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (tool === "line") {
      const s = currentStrokeRef.current;
      if (s) {
        const [[x0, y0], [x1, y1]] = s.points;
        if (Math.hypot(x1 - x0, y1 - y0) >= 2) strokesRef.current.push(s);
      }
      currentStrokeRef.current = null;
      render();
      return;
    }
    stopBrushLoop();
    if (currentStrokeRef.current && currentStrokeRef.current.points.length >= 2) {
      strokesRef.current.push(currentStrokeRef.current);
    }
    currentStrokeRef.current = null;
    render();
  };

  const onMouseLeave = () => {
    cursorPosRef.current = null;
    if (!drawingRef.current) {
      brushPosRef.current = null;
      render();
    }
  };

  const undo = () => {
    strokesRef.current.pop();
    render();
  };

  const clear = () => {
    strokesRef.current = [];
    render();
  };

  const save = async () => {
    const img = imgRef.current;
    if (!img || !imgBounds) return;
    setSaving(true);
    try {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const scale = nw / imgBounds.width;

      // Load via Blob URL to avoid canvas tainting from the Tauri asset protocol.
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const ext = image.path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp" : "image/png";
      const bytes = await readFile(image.path);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const cleanImg = new Image();
      cleanImg.src = blobUrl;
      await new Promise<void>((res, rej) => {
        cleanImg.onload = () => res();
        cleanImg.onerror = () => rej(new Error("image load failed"));
      });

      const offscreen = document.createElement("canvas");
      offscreen.width = nw;
      offscreen.height = nh;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(cleanImg, 0, 0, nw, nh);
      URL.revokeObjectURL(blobUrl);

      // Replay strokes at natural resolution
      for (const s of strokesRef.current) {
        if (s.points.length < 2) continue;
        ctx.save();
        ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.size * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        const scaled = s.points.map(([x, y]) => [x * scale, y * scale] as [number, number]);
        tracePath(ctx, s.kind, scaled);
        ctx.stroke();
        ctx.restore();
      }

      const dataUrl = offscreen.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];

      const dir = dirname(image.path);
      const name = basename(image.path).replace(/\.[^.]+$/, "");
      const savePath = `${dir}/${name}_paint.png`;

      await cmd.save_png_base64(savePath, base64);
      await useSessionStore.getState().rescanShot();
      onSave(savePath);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => () => stopBrushLoop(), [stopBrushLoop]);

  const src = fileSrc(image.path);

  return (
    <FullscreenModal
      onClose={onCancel}
      closeOnEscape={false}
      onMouseUp={onMouseUp}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Image + canvas area */}
      <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden">
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain select-none"
          onLoad={() => {
            setImgReady(true);
            updateBounds();
          }}
          style={{ userSelect: "none" }}
        />
        {imgReady && imgBounds && (
          <canvas
            ref={canvasRef}
            width={imgBounds.width}
            height={imgBounds.height}
            className="absolute cursor-crosshair"
            style={{
              left: imgBounds.left,
              top: imgBounds.top,
              width: imgBounds.width,
              height: imgBounds.height,
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          />
        )}
      </div>

      {/* Toolbar */}
      <div
        className="bg-panel text-text p-2 flex items-center gap-3 flex-wrap"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Tool: freehand brush vs straight line */}
        <div className="flex items-center gap-1">
          <button
            title="Brush"
            onClick={() => setTool("brush")}
            className={`text-xs px-2 py-0.5 border ${tool === "brush" ? "border-white text-white" : "border-dim text-dim"} hover:border-text hover:text-text`}
          >
            brush
          </button>
          <button
            title="Line — click+drag to draw a straight line"
            onClick={() => setTool("line")}
            className={`text-xs px-2 py-0.5 border ${tool === "line" ? "border-white text-white" : "border-dim text-dim"} hover:border-text hover:text-text`}
          >
            line
          </button>
        </div>

        <div className="w-px h-5 bg-dim" />

        {/* Colour swatches */}
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              title={c}
              onClick={() => { setColor(c); setErase(false); }}
              className="rounded-full border-2 transition-transform"
              style={{
                background: c,
                width: 18,
                height: 18,
                borderColor: !erase && color === c ? "white" : "transparent",
                transform: !erase && color === c ? "scale(1.25)" : "scale(1)",
              }}
            />
          ))}
        </div>

        {/* Eraser */}
        <button
          title="Eraser"
          onClick={() => setErase(true)}
          className={`text-xs px-2 py-0.5 border ${erase ? "border-white text-white" : "border-dim text-dim"} hover:border-text hover:text-text`}
        >
          eraser
        </button>

        <div className="w-px h-5 bg-dim" />

        {/* Brush sizes */}
        <div className="flex items-center gap-1">
          {SIZES.map((s) => (
            <button
              key={s}
              title={`${s}px`}
              onClick={() => setSize(s)}
              className="flex items-center justify-center rounded-full border-2 transition-transform"
              style={{
                width: 24,
                height: 24,
                borderColor: size === s ? "white" : "transparent",
              }}
            >
              <span
                className="rounded-full"
                style={{
                  width: Math.min(s, 20),
                  height: Math.min(s, 20),
                  background: "white",
                  opacity: size === s ? 1 : 0.4,
                }}
              />
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-dim" />

        {/* Smoothing slider — only meaningful for freehand brush strokes */}
        <label
          className={`flex items-center gap-2 text-xs text-dim ${tool === "line" ? "opacity-40" : ""}`}
        >
          Smooth
          <input
            type="range"
            min={0}
            max={80}
            value={smoothing}
            disabled={tool === "line"}
            onChange={(e) => setSmoothing(Number(e.currentTarget.value))}
            className="w-20 accent-white"
          />
          <span className="w-5 text-right">{smoothing}</span>
        </label>

        <div className="flex-1" />

        {/* Undo / Clear */}
        <button
          onClick={undo}
          className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text"
        >
          undo
        </button>
        <button
          onClick={clear}
          className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text"
        >
          clear
        </button>

        <div className="w-px h-5 bg-dim" />

        {/* Save / Cancel */}
        <button
          onClick={() => void save()}
          disabled={saving}
          className="text-xs px-3 py-0.5 bg-accent text-text hover:opacity-80 disabled:opacity-40"
        >
          {saving ? "saving…" : "save"}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-2 py-0.5 border border-dim text-dim hover:border-text hover:text-text"
        >
          cancel
        </button>
      </div>
    </FullscreenModal>
  );
}
