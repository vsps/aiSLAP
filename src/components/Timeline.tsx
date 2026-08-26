import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDisplayClips,
  resolveClipMedia,
  useTimelineStore,
} from "../stores/timelineStore";
import { useLayoutStore } from "../stores/layoutStore";
import { fileSrc } from "../lib/assets";
import { videoThumbCandidates } from "../lib/media";
import { TimelineClip } from "./TimelineClip";
import { TimelineTransport } from "./TimelineTransport";

export function Timeline() {
  const clips = useTimelineStore((s) => s.clips);
  const totalDurationSec = useTimelineStore((s) => s.totalDurationSec);
  const shotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const videoDurations = useTimelineStore((s) => s.videoDurations);
  const setBoundary = useTimelineStore((s) => s.setBoundary);
  const moveClip = useTimelineStore((s) => s.moveClip);
  const playing = useTimelineStore((s) => s.playing);
  const playheadSec = useTimelineStore((s) => s.playheadSec);
  const setPlayheadSec = useTimelineStore((s) => s.setPlayheadSec);
  const pause = useTimelineStore((s) => s.pause);
  const recordVideoDuration = useTimelineStore((s) => s.recordVideoDuration);
  const timelineHeight = useLayoutStore((s) => s.panelSizes.timelineHeight);

  const stripRef = useRef<HTMLDivElement>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [slipIdx, setSlipIdx] = useState<number | null>(null);
  const reorderRef = useRef<{ fromIdx: number } | null>(null);

  const getStripWidthPx = useCallback(
    () => stripRef.current?.getBoundingClientRect().width ?? 0,
    [],
  );

  const onPlaceHeadAtClientX = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      if (!strip) return;
      const rect = strip.getBoundingClientRect();
      const total = useTimelineStore.getState().totalDurationSec;
      if (rect.width <= 0 || total <= 0) return;
      const t = Math.max(
        0,
        Math.min(total, ((clientX - rect.left) / rect.width) * total),
      );
      setPlayheadSec(t);
    },
    [setPlayheadSec],
  );

  // ---- rAF playback loop ----
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dtSec = (now - last) / 1000;
      last = now;
      const next = useTimelineStore.getState().playheadSec + dtSec;
      const total = useTimelineStore.getState().totalDurationSec;
      if (next >= total) {
        setPlayheadSec(total);
        pause();
        return;
      }
      setPlayheadSec(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, setPlayheadSec, pause]);

  // ---- Probe video durations for video clips that haven't been probed yet ----
  useEffect(() => {
    const paths = new Set<string>();
    for (const c of clips) {
      const r = resolveClipMedia(c, shotsLatestMedia);
      if (r?.isVideo && !videoDurations.has(r.path)) {
        paths.add(r.path);
      }
    }
    if (paths.size === 0) return;
    const probes: HTMLVideoElement[] = [];
    for (const p of paths) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = fileSrc(p);
      const onMeta = () => {
        if (Number.isFinite(v.duration) && v.duration > 0) {
          recordVideoDuration(p, v.duration);
        }
        v.removeEventListener("loadedmetadata", onMeta);
      };
      v.addEventListener("loadedmetadata", onMeta);
      probes.push(v);
    }
    return () => {
      for (const v of probes) {
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [clips, shotsLatestMedia, videoDurations, recordVideoDuration]);

  const display = getDisplayClips(clips, totalDurationSec);
  const empty = display.length === 0 || totalDurationSec <= 0;

  // Cumulative-% positions for each inner boundary (between display[i] and display[i+1]).
  // The boundary index in *user-clip* space (passed to setBoundary) is `i`.
  // We don't render a handle past the last display clip (right edge is locked).
  const cumulativePcts: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < display.length - 1; i++) {
      acc += display[i].durationSec;
      cumulativePcts.push((acc / totalDurationSec) * 100);
    }
  }

  // ---- Slip ghost geometry ----
  // While slipping, draw the source media's full extent at the strip's scale,
  // aligned so source-time `offsetSec` lands on the clip's left edge. It
  // deliberately overhangs the clip on both sides — that overhang *is* the
  // information (how much unused media is available in each direction), which
  // is why this lives on the strip and not inside the clip's overflow-hidden box.
  const slipGhost = (() => {
    if (slipIdx == null || totalDurationSec <= 0) return null;
    const c = display[slipIdx];
    if (!c) return null;
    const resolved = resolveClipMedia(c, shotsLatestMedia);
    if (!resolved?.isVideo) return null;
    const sourceDur = videoDurations.get(resolved.path);
    if (sourceDur == null || !(sourceDur > 0)) return null;

    const pctPerSec = 100 / totalDurationSec;
    const offsetSec = c.sourceOffsetSec ?? 0;
    const clipStartPct = slipIdx === 0 ? 0 : cumulativePcts[slipIdx - 1];
    return {
      clipStartPct,
      clipWidthPct: c.durationSec * pctPerSec,
      ghostLeftPct: clipStartPct - offsetSec * pctPerSec,
      ghostWidthPct: sourceDur * pctPerSec,
      headSlackSec: offsetSec,
      tailSlackSec: Math.max(0, sourceDur - offsetSec - c.durationSec),
      thumbSrcs: videoThumbCandidates(resolved.path).map(fileSrc),
    };
  })();

  // ---- Edge-resize handlers ----

  const onBoundaryPointerDown = useCallback(
    (boundaryIdx: number, e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const strip = stripRef.current;
      if (!strip) return;
      const rect = strip.getBoundingClientRect();
      const pxPerSec = rect.width / totalDurationSec;
      if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return;

      const startX = e.clientX;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      // We accumulate the delta relative to the start; setBoundary's input is a
      // *delta-from-current*, so we need to track what's been applied so far.
      let lastAppliedSec = 0;

      const onMove = (ev: PointerEvent) => {
        const dxPx = ev.clientX - startX;
        const targetSec = dxPx / pxPerSec;
        const stepDelta = targetSec - lastAppliedSec;
        if (Math.abs(stepDelta) < 0.001) return;
        setBoundary(boundaryIdx, stepDelta);
        lastAppliedSec = targetSec;
      };
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [setBoundary, totalDurationSec],
  );

  // ---- Drag-reorder coordination ----

  const onReorderStart = useCallback(
    (fromIdx: number, _fromId: string, _startX: number) => {
      reorderRef.current = { fromIdx };
      setDropIdx(fromIdx);

      const onMove = (ev: PointerEvent) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) return;
        const target = (el as HTMLElement).closest("[data-clip-idx]");
        if (!target) return;
        const idxStr = target.getAttribute("data-clip-idx");
        if (idxStr == null) return;
        const idx = Number(idxStr);
        if (!Number.isFinite(idx)) return;
        // Don't drop onto the pad clip.
        if (idx >= clips.length) return;
        setDropIdx(idx);
      };
      const onUp = () => {
        const r = reorderRef.current;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        reorderRef.current = null;
        const latest = latestDropIdxRef.current;
        setDropIdx(null);
        if (!r) return;
        if (latest != null && latest !== r.fromIdx) {
          moveClip(r.fromIdx, latest);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [clips.length, moveClip],
  );

  // Mirror dropIdx into a ref so pointerup handler reads the latest value.
  const latestDropIdxRef = useRef<number | null>(null);
  useEffect(() => {
    latestDropIdxRef.current = dropIdx;
  }, [dropIdx]);

  return (
    <div
      className="shrink-0 flex bg-panel border border-border overflow-hidden"
      style={{ height: `${timelineHeight}px` }}
    >
      <div ref={stripRef} className="flex-1 min-w-0 relative flex">
        {empty ? (
          <div className="flex-1 flex items-center justify-center text-dim text-xs">
            no shots in sequence
          </div>
        ) : (
          <>
            {display.map((c, i) => (
              <TimelineClip
                key={c.id}
                clip={c}
                clipIdx={i}
                isPad={i >= clips.length}
                shotsLatestMedia={shotsLatestMedia}
                widthPct={(c.durationSec / totalDurationSec) * 100}
                getStripWidthPx={getStripWidthPx}
                onReorderStart={onReorderStart}
                onPlaceHeadAtClientX={onPlaceHeadAtClientX}
                onSlipChange={setSlipIdx}
              />
            ))}

            {/* Slip ghost — the source's full extent, overhanging the clip.
                Its own overflow-hidden wrapper keeps a long source from
                painting over the transport to the right of the strip. */}
            {slipGhost && (
              <div className="absolute inset-0 overflow-hidden pointer-events-none z-[15]">
                <div
                  className="absolute top-0 bottom-0 border border-accent/70 bg-accent/10"
                  style={{
                    left: `${slipGhost.ghostLeftPct}%`,
                    width: `${slipGhost.ghostWidthPct}%`,
                  }}
                >
                  <div
                    className="absolute inset-0 opacity-20"
                    style={{
                      // Both thumbnail suffixes, JPEG layered over legacy PNG:
                      // a background-image that 404s is simply skipped, so the
                      // second entry shows through for pre-JPEG projects. No
                      // error event to thread through a CSS background.
                      backgroundImage: slipGhost.thumbSrcs
                        .map((s) => `url("${s.replace(/["\\]/g, "\\$&")}")`)
                        .join(", "),
                      backgroundRepeat: "repeat-x",
                      backgroundSize: "auto 100%",
                      backgroundPosition: "left center",
                    }}
                  />
                  {slipGhost.headSlackSec >= 0.1 && (
                    <span className="absolute top-0 left-0 px-[2px] bg-bg/80 text-accent text-[9px] font-mono leading-[12px]">
                      −{slipGhost.headSlackSec.toFixed(1)}s
                    </span>
                  )}
                  {slipGhost.tailSlackSec >= 0.1 && (
                    <span className="absolute top-0 right-0 px-[2px] bg-bg/80 text-accent text-[9px] font-mono leading-[12px]">
                      +{slipGhost.tailSlackSec.toFixed(1)}s
                    </span>
                  )}
                </div>
                {/* The trim window — which slice of the ghost actually plays. */}
                <div
                  className="absolute top-0 bottom-0 border-2 border-accent"
                  style={{
                    left: `${slipGhost.clipStartPct}%`,
                    width: `${slipGhost.clipWidthPct}%`,
                  }}
                />
              </div>
            )}

            {/* Resize handles overlaid at each inner boundary. */}
            {cumulativePcts.map((pct, i) => (
              <div
                key={`bnd-${i}`}
                onPointerDown={(e) => onBoundaryPointerDown(i, e)}
                className="group absolute top-0 bottom-0 z-10 cursor-col-resize flex items-center justify-center"
                style={{
                  left: `calc(${pct}% - 4px)`,
                  width: 8,
                }}
                title="Drag to resize"
              >
                <div className="w-[2px] h-full bg-handle/60 group-hover:bg-accent transition-colors" />
              </div>
            ))}

            {/* Drop indicator while reordering. */}
            {dropIdx != null && reorderRef.current && dropIdx !== reorderRef.current.fromIdx && (
              <div
                className="absolute top-0 bottom-0 w-[2px] bg-accent z-20 pointer-events-none"
                style={{
                  left: `${dropIndicatorPct(display, totalDurationSec, dropIdx, reorderRef.current.fromIdx)}%`,
                }}
              />
            )}

            {/* Playhead. */}
            {totalDurationSec > 0 && (
              <div
                className="absolute top-0 bottom-0 w-[1px] bg-accent z-20 pointer-events-none"
                style={{
                  left: `${(playheadSec / totalDurationSec) * 100}%`,
                }}
              />
            )}
          </>
        )}
      </div>
      <TimelineTransport />
    </div>
  );
}

/**
 * Drop indicator x-% along the strip. When dragging from `fromIdx` to `toIdx`,
 * the indicator sits at the *target* clip's left edge (or right edge if moving
 * right past it).
 */
function dropIndicatorPct(
  display: { durationSec: number }[],
  total: number,
  toIdx: number,
  fromIdx: number,
): number {
  // Sum durations up to and including `toIdx` if moving right (drop to right of target),
  // otherwise sum up to (not including) `toIdx` (drop to left of target).
  const movingRight = toIdx > fromIdx;
  const end = movingRight ? toIdx + 1 : toIdx;
  let acc = 0;
  for (let i = 0; i < end && i < display.length; i++) {
    acc += display[i].durationSec;
  }
  return (acc / total) * 100;
}
