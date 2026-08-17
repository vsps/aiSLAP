import { useEffect, useRef, useState } from "react";
import { fileSrc } from "../lib/assets";
import { isVideoPath } from "../lib/media";
import { cmd } from "../lib/tauri";
import { getConfigCached } from "../lib/metadataCache";
import { useSessionStore } from "../stores/sessionStore";

/** Frame rate assumed for the A/B offset nudges when ffmpeg can't be probed.
 *  Only sets the size of one nudge — the wipe itself is unaffected. */
const FALLBACK_FPS = 25;

const aspectOf = (w: number, h: number): number | null =>
  w > 0 && h > 0 ? w / h : null;

/**
 * A/B compare view: drag media into the left/right halves (drop is committed
 * from Gallery.tsx's pointerup handler via data-compare-drop markers), then
 * wipe between them with a slider. Holding Ctrl shows slot A full-frame;
 * Ctrl+holding the left mouse button flips to slot B, for fast flicking.
 *
 * `offsetAFrames`/`offsetBFrames` slide the two clips against each other — two
 * takes of the same action rarely start on the same frame. Only their
 * difference matters: slot A is the free-running clock, so A's offset is
 * applied by shifting B the other way.
 *
 * `matchScale` uniformly scales slot B so its rendered width equals slot A's,
 * for comparing takes that differ in aspect ratio.
 */
export function ComparePreview({
  pathA,
  pathB,
  offsetAFrames = 0,
  offsetBFrames = 0,
  matchScale = false,
}: {
  pathA: string | null;
  pathB: string | null;
  offsetAFrames?: number;
  offsetBFrames?: number;
  matchScale?: boolean;
}) {
  const imageDrag = useSessionStore((s) => s.imageDrag);
  const [pct, setPct] = useState(50);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [mouseDownWhileCtrl, setMouseDownWhileCtrl] = useState(false);
  const [dragOverSlot, setDragOverSlot] = useState<"a" | "b" | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [arA, setArA] = useState<number | null>(null);
  const [arB, setArB] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  const isVideoA = pathA != null && isVideoPath(pathA);
  const isVideoB = pathB != null && isVideoPath(pathB);
  const bothVideo = isVideoA && isVideoB;
  // How far B must sit ahead of A on the clock, in seconds.
  const offsetDeltaSec =
    (offsetBFrames - offsetAFrames) / (fps ?? FALLBACK_FPS);

  // Track Ctrl / Ctrl+LMB so the user can flick between A and B at full frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") setCtrlHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        setCtrlHeld(false);
        setMouseDownWhileCtrl(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!ctrlHeld) setMouseDownWhileCtrl(false);
  }, [ctrlHeld]);

  // Highlight left/right drop halves while a gallery item is being dragged.
  useEffect(() => {
    if (!imageDrag) {
      setDragOverSlot(null);
      return;
    }
    const onMove = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) {
        setDragOverSlot(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      if (!inside) {
        setDragOverSlot(null);
        return;
      }
      setDragOverSlot(e.clientX - r.left < r.width / 2 ? "a" : "b");
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [imageDrag]);

  // The offset nudges are in frames, so they need slot A's real frame rate.
  // Best-effort: without ffmpeg configured a nudge is just 1/25s.
  useEffect(() => {
    let cancelled = false;
    setFps(null);
    if (!isVideoA || !pathA) return;
    void (async () => {
      const cfg = await getConfigCached();
      const ffmpeg = (cfg?.ffmpegPath ?? "").trim();
      if (!ffmpeg || cancelled) return;
      const info = await cmd
        .video_info_probe(pathA, ffmpeg)
        .catch(() => ({ fps: null, durationSec: null }));
      if (!cancelled && info.fps && info.fps > 0) setFps(info.fps);
    })();
    return () => {
      cancelled = true;
    };
  }, [isVideoA, pathA]);

  // Keep slot B's video synced to slot A's when both are videos, holding the
  // frame offset between them. The tolerance stops a re-seek every tick; the
  // effect below covers the case the tolerance would swallow.
  useEffect(() => {
    if (!bothVideo) return;
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b) return;
    const onTimeUpdate = () => {
      const target = a.currentTime + offsetDeltaSec;
      if (Math.abs(b.currentTime - target) > 0.15) b.currentTime = target;
    };
    a.addEventListener("timeupdate", onTimeUpdate);
    return () => a.removeEventListener("timeupdate", onTimeUpdate);
  }, [bothVideo, pathA, pathB, offsetDeltaSec]);

  // Apply an offset change straight away — a one-frame nudge is well inside
  // the drift tolerance above, and has to land while paused too.
  useEffect(() => {
    if (!bothVideo) return;
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b) return;
    const target = a.currentTime + offsetDeltaSec;
    const max = Number.isFinite(b.duration) ? b.duration : target;
    try {
      b.currentTime = Math.max(0, Math.min(max, target));
    } catch {
      // Element not ready — the next timeupdate lands it.
    }
  }, [bothVideo, offsetDeltaSec]);

  // Drop the old aspect the moment a slot changes, so match-scale falls back
  // to 1 rather than sizing the new media against the previous one's shape.
  useEffect(() => setArA(null), [pathA]);
  useEffect(() => setArB(null), [pathB]);

  // Rendered size of a fitted media, derived from the container box and the
  // media's own aspect — reading it back off the DOM would feed B's own
  // match-scale transform into the next measurement.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fittedWidth = (ar: number) =>
    box ? Math.min(box.w, box.h * ar) : 0;
  const scaleB =
    matchScale && arA && arB && box
      ? (fittedWidth(arA) || 1) / (fittedWidth(arB) || 1)
      : 1;

  // Ctrl-flicker: unmute whichever slot is shown full-frame, mute the other.
  const showingFull = ctrlHeld;
  const showingB = ctrlHeld && mouseDownWhileCtrl;
  useEffect(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (a) a.muted = !(showingFull && !showingB);
    if (b) b.muted = !(showingFull && showingB);
  }, [showingFull, showingB]);

  function togglePlayback() {
    const a = videoARef.current;
    const b = videoBRef.current;
    const anyPlaying = (a && !a.paused) || (b && !b.paused);
    if (anyPlaying) {
      a?.pause();
      b?.pause();
    } else {
      void a?.play().catch(() => {});
      void b?.play().catch(() => {});
    }
  }

  const hasVideo = isVideoA || isVideoB;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onPointerDown={(e) => {
        if (e.ctrlKey || e.metaKey) setMouseDownWhileCtrl(true);
        if (hasVideo) togglePlayback();
      }}
      onPointerUp={() => setMouseDownWhileCtrl(false)}
    >
      {pathA &&
        (isVideoA ? (
          <video
            ref={videoARef}
            key={pathA}
            src={fileSrc(pathA)}
            className="absolute inset-0 m-auto max-w-full max-h-full"
            muted
            loop
            playsInline
            preload="auto"
            autoPlay
            onLoadedMetadata={(e) =>
              setArA(aspectOf(e.currentTarget.videoWidth, e.currentTarget.videoHeight))
            }
          />
        ) : (
          <img
            key={pathA}
            src={fileSrc(pathA)}
            alt=""
            className="absolute inset-0 m-auto max-w-full max-h-full object-contain"
            draggable={false}
            onLoad={(e) =>
              setArA(aspectOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))
            }
          />
        ))}

      {pathB && (
        <div
          className="absolute inset-0"
          style={
            showingFull
              ? { clipPath: showingB ? "inset(0 0 0 0)" : "inset(0 100% 0 0)" }
              : { clipPath: `inset(0 0 0 ${pct}%)` }
          }
        >
          {isVideoB ? (
            <video
              ref={videoBRef}
              key={pathB}
              src={fileSrc(pathB)}
              className="absolute inset-0 m-auto max-w-full max-h-full"
              style={{ transform: `scale(${scaleB})` }}
              muted
              loop
              playsInline
              preload="auto"
              autoPlay
              onLoadedMetadata={(e) =>
                setArB(aspectOf(e.currentTarget.videoWidth, e.currentTarget.videoHeight))
              }
            />
          ) : (
            <img
              key={pathB}
              src={fileSrc(pathB)}
              alt=""
              className="absolute inset-0 m-auto max-w-full max-h-full object-contain"
              style={{ transform: `scale(${scaleB})` }}
              draggable={false}
              onLoad={(e) =>
                setArB(aspectOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))
              }
            />
          )}
        </div>
      )}

      {!pathA && !pathB && (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-xs">
          Drag media to the left/right half to compare
        </div>
      )}

      {pathA && pathB && (
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-1 left-2 right-2 z-10"
        />
      )}

      {imageDrag && (
        <>
          <div
            className={`absolute inset-y-0 left-0 w-1/2 ${
              dragOverSlot === "a" ? "outline outline-2 outline-accent -outline-offset-2" : ""
            }`}
            data-compare-drop="a"
          />
          <div
            className={`absolute inset-y-0 right-0 w-1/2 ${
              dragOverSlot === "b" ? "outline outline-2 outline-accent -outline-offset-2" : ""
            }`}
            data-compare-drop="b"
          />
        </>
      )}
    </div>
  );
}
