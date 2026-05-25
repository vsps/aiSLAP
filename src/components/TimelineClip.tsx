import { useRef, useState } from "react";
import type {
  TimelineClip as TimelineClipT,
  ShotLatestMedia,
} from "../lib/types";
import { fileSrc } from "../lib/assets";
import { resolveClipMedia, useTimelineStore } from "../stores/timelineStore";
import { Icon } from "../lib/icon";
import { ClipMediaPicker } from "./ClipMediaPicker";
import { basename } from "../lib/paths";

type Props = {
  clip: TimelineClipT;
  clipIdx: number;
  isPad: boolean;
  shotsLatestMedia: Map<string, ShotLatestMedia>;
  widthPct: number;
  /** Read the strip's pixel width on demand (cached by Timeline). */
  getStripWidthPx: () => number;
  onReorderStart: (
    fromIdx: number,
    fromPath: string,
    startX: number,
  ) => void;
  /** Place the playhead at a screen X (clientX) anywhere along the strip. */
  onPlaceHeadAtClientX: (clientX: number) => void;
};

function videoThumbCandidate(videoPath: string): string {
  const dot = videoPath.lastIndexOf(".");
  const stem = dot >= 0 ? videoPath.slice(0, dot) : videoPath;
  return `${stem}.thumb.png`;
}

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

const DRAG_THRESHOLD_PX = 4;

export function TimelineClip({
  clip,
  clipIdx,
  isPad,
  shotsLatestMedia,
  widthPct,
  getStripWidthPx,
  onReorderStart,
  onPlaceHeadAtClientX,
}: Props) {
  const resolved = resolveClipMedia(clip, shotsLatestMedia);
  const toggleClipEnabled = useTimelineStore((s) => s.toggleClipEnabled);
  const setClipMedia = useTimelineStore((s) => s.setClipMedia);
  const setClipSourceOffset = useTimelineStore((s) => s.setClipSourceOffset);
  const videoDurations = useTimelineStore((s) => s.videoDurations);

  const [thumbBroken, setThumbBroken] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isBlank = clip.shotPath == null;
  const offsetSec = clip.sourceOffsetSec ?? 0;

  const sourceDur =
    resolved?.isVideo ? videoDurations.get(resolved.path) ?? null : null;
  const playableSec =
    sourceDur != null ? Math.max(0, sourceDur - offsetSec) : null;
  const freezeStartPct =
    playableSec != null && playableSec < clip.durationSec
      ? (playableSec / clip.durationSec) * 100
      : null;

  // Image area: click → place playhead, drag → slip media.
  const onImagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startOffset = offsetSec;

    const st = useTimelineStore.getState();
    const sourceDur =
      resolved?.isVideo ? st.videoDurations.get(resolved.path) ?? null : null;
    const slipSlack =
      sourceDur != null ? Math.max(0, sourceDur - clip.durationSec) : 0;
    const slippable =
      !isPad && resolved?.isVideo === true && slipSlack > 0.001;

    type Mode = "pending" | "slip" | "dead";
    let mode: Mode = "pending";

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (mode === "pending") {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        mode = slippable ? "slip" : "dead";
        if (mode === "dead") return;
      }
      if (mode === "slip" && sourceDur != null) {
        const w = getStripWidthPx();
        const total = useTimelineStore.getState().totalDurationSec;
        if (w <= 0 || total <= 0) return;
        const pxPerSec = w / total;
        // NLE convention: dragging right shifts visible content right → earlier
        // source content under the slot → offset decreases.
        const target = startOffset - dx / pxPerSec;
        const clamped = Math.max(0, Math.min(slipSlack, target));
        setClipSourceOffset(clip.id, clamped);
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (mode === "pending") {
        onPlaceHeadAtClientX(ev.clientX);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Label bar: click → open media picker, drag → reorder.
  const onLabelPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (isPad || clip.shotPath == null) return;
    e.stopPropagation();

    const startX = e.clientX;
    type Mode = "pending" | "reorder";
    let mode: Mode = "pending";

    const onMove = (ev: PointerEvent) => {
      if (mode !== "pending") return;
      const dx = ev.clientX - startX;
      if (Math.abs(dx) >= DRAG_THRESHOLD_PX) {
        mode = "reorder";
        onReorderStart(clipIdx, clip.id, startX);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (mode === "pending") {
        setPickerOpen(true);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={bodyRef}
      data-clip-idx={clipIdx}
      onPointerDown={onImagePointerDown}
      className={`relative h-full overflow-hidden border-r border-border select-none cursor-pointer ${
        isBlank ? "bg-inset" : "bg-surface"
      } ${clip.enabled ? "" : "opacity-40"}`}
      style={{ width: `${widthPct}%` }}
      title={
        resolved
          ? offsetSec > 0.001
            ? `${resolved.path}  ·  offset=${offsetSec.toFixed(2)}s`
            : resolved.path
          : isBlank
            ? "blank"
            : "no media"
      }
    >
      {resolved ? (
        resolved.isVideo ? (
          thumbBroken ? (
            <div className="absolute inset-0 flex items-center justify-center text-dim">
              <Icon name="videocam" size={20} />
            </div>
          ) : (
            <img
              src={fileSrc(videoThumbCandidate(resolved.path))}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setThumbBroken(true)}
              draggable={false}
            />
          )
        ) : (
          <img
            src={fileSrc(resolved.path)}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-xs">
          {isBlank ? "—" : "no media"}
        </div>
      )}

      {freezeStartPct != null && (
        <div
          className="absolute top-0 bottom-0 right-0 bg-black/45 pointer-events-none"
          style={{ left: `${freezeStartPct}%` }}
          title="Freeze frame — source is shorter than the clip"
        />
      )}

      {/* Disable toggle (not shown on the auto-pad). */}
      {!isPad && (
        <button
          type="button"
          title={clip.enabled ? "Disable clip" : "Enable clip"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleClipEnabled(clip.id);
          }}
          className="absolute top-[2px] left-[2px] w-[18px] h-[18px] inline-flex items-center justify-center bg-bg/70 hover:bg-bg text-text"
        >
          <Icon
            name={clip.enabled ? "visibility" : "visibility_off"}
            size={14}
            fill={!clip.enabled}
          />
        </button>
      )}

      <div
        onPointerDown={onLabelPointerDown}
        className={`absolute bottom-0 left-0 right-0 px-1 py-[1px] text-[10px] font-mono text-text whitespace-nowrap overflow-hidden flex items-center gap-1 ${
          isPad || clip.shotPath == null ? "" : "cursor-grab"
        }`}
        style={{
          backgroundColor: `hsl(${hashHue(clip.id)} 45% 22% / 0.92)`,
        }}
      >
        <span className="truncate flex-1">
          {clip.shotPath ? basename(clip.shotPath) : "—"}
        </span>
        {offsetSec > 0.1 && (
          <span className="shrink-0 text-accent">+{offsetSec.toFixed(1)}s</span>
        )}
        <span className="shrink-0 text-dim">{clip.durationSec.toFixed(1)}s</span>
      </div>

      {pickerOpen && clip.shotPath && (
        <ClipMediaPicker
          anchor={bodyRef.current}
          shotPath={clip.shotPath}
          currentMediaPath={clip.mediaPath}
          onPick={(path) => setClipMedia(clip.id, path)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
