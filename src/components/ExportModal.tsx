import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import { pickSaveFile, showMessage } from "../lib/dialog";
import {
  getDisplayClips,
  resolveClipMedia,
  useTimelineStore,
} from "../stores/timelineStore";
import type {
  Config,
  ExportSegment,
  TimelineClip,
  ShotLatestMedia,
} from "../lib/types";
import { useSessionStore } from "../stores/sessionStore";
import { basename } from "../lib/paths";

type Props = {
  onClose: () => void;
};

const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 25,
  bitrateMbps: 8.0,
};

export function ExportModal({ onClose }: Props) {
  const clips = useTimelineStore((s) => s.clips);
  const totalDurationSec = useTimelineStore((s) => s.totalDurationSec);
  const shotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const videoDurations = useTimelineStore((s) => s.videoDurations);
  const sequencePath = useSessionStore((s) => s.sequencePath);

  const [width, setWidth] = useState(DEFAULTS.width);
  const [height, setHeight] = useState(DEFAULTS.height);
  const [fps, setFps] = useState(DEFAULTS.fps);
  const [bitrateMbps, setBitrateMbps] = useState(DEFAULTS.bitrateMbps);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, busy]);

  const segments = useMemo(
    () =>
      buildSegments(clips, totalDurationSec, shotsLatestMedia, videoDurations),
    [clips, totalDurationSec, shotsLatestMedia, videoDurations],
  );

  const defaultSaveName = sequencePath
    ? `${basename(sequencePath)}.mp4`
    : "timeline.mp4";

  const onPickPath = async () => {
    const p = await pickSaveFile("Export timeline", {
      extensions: ["mp4"],
      defaultPath: outputPath ?? defaultSaveName,
    });
    if (p) setOutputPath(p);
  };

  const onExport = async () => {
    if (!outputPath) {
      setErr("Pick an output path first.");
      return;
    }
    if (segments.length === 0) {
      setErr("Timeline is empty.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const cfg = (await cmd.config_load().catch(() => null)) as Config | null;
      const ffmpegPath = (cfg?.ffmpegPath ?? "").trim();
      if (!ffmpegPath) {
        setErr("ffmpeg path is not configured (open Settings).");
        setBusy(false);
        return;
      }
      await cmd.timeline_export({
        segments,
        outputPath,
        width,
        height,
        fps,
        bitrateKbps: Math.max(1, Math.round(bitrateMbps * 1000)),
        ffmpegPath,
      });
      setBusy(false);
      onClose();
      await showMessage(`Exported to: ${outputPath}`, { kind: "info" });
    } catch (e) {
      setBusy(false);
      setErr(String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-panel text-text max-w-[460px] w-full border border-dim shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 bg-accent text-text text-sm">
          Export timeline
        </div>
        <div className="p-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <label className="self-center text-dim">Width</label>
          <NumField value={width} setValue={setWidth} min={2} step={1} />

          <label className="self-center text-dim">Height</label>
          <NumField value={height} setValue={setHeight} min={2} step={1} />

          <label className="self-center text-dim">FPS</label>
          <NumField value={fps} setValue={setFps} min={1} step={1} />

          <label className="self-center text-dim">Bitrate (Mbps)</label>
          <NumField
            value={bitrateMbps}
            setValue={setBitrateMbps}
            min={0.1}
            step={0.5}
          />

          <label className="self-center text-dim">Output</label>
          <div className="flex items-center gap-2 min-w-0">
            <input
              readOnly
              value={outputPath ?? ""}
              placeholder="(not set)"
              className="flex-1 min-w-0 bg-bg border border-border text-text px-1 py-[1px] text-xs font-mono truncate"
              title={outputPath ?? ""}
            />
            <button
              type="button"
              className="bg-dim text-text px-2 py-[2px] text-xs"
              onClick={onPickPath}
            >
              Choose…
            </button>
          </div>
        </div>

        <div className="px-4 pb-2 text-xs text-dim">
          {segments.length} segments · {totalDurationSec.toFixed(1)}s total
        </div>

        {err && (
          <div className="px-4 pb-2 text-xs text-bad whitespace-pre-wrap">
            {err}
          </div>
        )}

        <div className="px-4 py-2 flex justify-end gap-2 border-t border-border">
          <button
            type="button"
            className="bg-dim text-text px-3 py-1"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bg-accent text-text px-3 py-1 disabled:opacity-50"
            onClick={onExport}
            disabled={busy || !outputPath}
          >
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumField({
  value,
  setValue,
  min,
  step,
}: {
  value: number;
  setValue: (n: number) => void;
  min: number;
  step: number;
}) {
  return (
    <input
      type="number"
      min={min}
      step={step}
      value={value}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n) && n >= min) setValue(n);
      }}
      className="bg-bg border border-border text-text px-1 py-[1px] text-xs font-mono w-24"
    />
  );
}

function buildSegments(
  clips: TimelineClip[],
  totalDurationSec: number,
  shotsLatestMedia: Map<string, ShotLatestMedia>,
  videoDurations: Map<string, number>,
): ExportSegment[] {
  const display = getDisplayClips(clips, totalDurationSec);
  const out: ExportSegment[] = [];
  for (let i = 0; i < display.length; i++) {
    const c = display[i];
    const isPad = i >= clips.length;
    const resolved = resolveClipMedia(c, shotsLatestMedia);
    if (!c.enabled || isPad || !resolved) {
      out.push({ kind: "blank", durationSec: c.durationSec });
      continue;
    }
    if (resolved.isVideo) {
      const srcDur = videoDurations.get(resolved.path);
      const rawOffset = c.sourceOffsetSec ?? 0;
      const effOffset =
        srcDur != null
          ? Math.min(rawOffset, Math.max(0, srcDur - c.durationSec))
          : rawOffset;
      out.push({
        kind: "video",
        path: resolved.path,
        durationSec: c.durationSec,
        sourceOffsetSec: effOffset,
      });
    } else {
      out.push({
        kind: "image",
        path: resolved.path,
        durationSec: c.durationSec,
      });
    }
  }
  return out;
}
