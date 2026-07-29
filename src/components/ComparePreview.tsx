import { useEffect, useRef, useState } from "react";
import { fileSrc } from "../lib/assets";
import { isVideoPath } from "../lib/media";
import { useSessionStore } from "../stores/sessionStore";

/**
 * A/B compare view: drag media into the left/right halves (drop is committed
 * from Gallery.tsx's pointerup handler via data-compare-drop markers), then
 * wipe between them with a slider. Holding Ctrl shows slot A full-frame;
 * Ctrl+holding the left mouse button flips to slot B, for fast flicking.
 */
export function ComparePreview({
  pathA,
  pathB,
}: {
  pathA: string | null;
  pathB: string | null;
}) {
  const imageDrag = useSessionStore((s) => s.imageDrag);
  const [pct, setPct] = useState(50);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [mouseDownWhileCtrl, setMouseDownWhileCtrl] = useState(false);
  const [dragOverSlot, setDragOverSlot] = useState<"a" | "b" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  const isVideoA = pathA != null && isVideoPath(pathA);
  const isVideoB = pathB != null && isVideoPath(pathB);
  const bothVideo = isVideoA && isVideoB;

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

  // Keep slot B's video synced to slot A's when both are videos.
  useEffect(() => {
    if (!bothVideo) return;
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b) return;
    const onTimeUpdate = () => {
      if (Math.abs(b.currentTime - a.currentTime) > 0.15) {
        b.currentTime = a.currentTime;
      }
    };
    a.addEventListener("timeupdate", onTimeUpdate);
    return () => a.removeEventListener("timeupdate", onTimeUpdate);
  }, [bothVideo, pathA, pathB]);

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
          />
        ) : (
          <img
            key={pathA}
            src={fileSrc(pathA)}
            alt=""
            className="absolute inset-0 m-auto max-w-full max-h-full object-contain"
            draggable={false}
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
              muted
              loop
              playsInline
              preload="auto"
              autoPlay
            />
          ) : (
            <img
              key={pathB}
              src={fileSrc(pathB)}
              alt=""
              className="absolute inset-0 m-auto max-w-full max-h-full object-contain"
              draggable={false}
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
