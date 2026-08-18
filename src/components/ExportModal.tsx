import { useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import { pickSaveFile, showMessage } from "../lib/dialog";
import { buildSegments, useTimelineStore } from "../stores/timelineStore";
import type { InterchangeFormat } from "../lib/types";
import { useSessionStore } from "../stores/sessionStore";
import { basename } from "../lib/paths";
import { ModalDialog } from "./ModalDialog";

type Props = {
  onClose: () => void;
};

const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 25,
  bitrateMbps: 8.0,
};

/** `null` = render an mp4 with ffmpeg; anything else writes an edit list. */
type Format = null | InterchangeFormat;

const FORMATS: { value: Format; label: string; ext: string; hint: string }[] = [
  {
    value: null,
    label: "MP4",
    ext: "mp4",
    hint: "Render the cut with ffmpeg. Video only — no audio.",
  },
  {
    value: "otio",
    label: "OTIO",
    ext: "otio",
    hint: "OpenTimelineIO edit list. Resolve 17+ and Premiere import it natively.",
  },
  {
    value: "xmeml",
    label: "FCP7 XML",
    ext: "xml",
    hint: "Legacy xmeml edit list. Widest reach — Resolve, Premiere, and most others.",
  },
];

export function ExportModal({ onClose }: Props) {
  const clips = useTimelineStore((s) => s.clips);
  const totalDurationSec = useTimelineStore((s) => s.totalDurationSec);
  const shotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const videoDurations = useTimelineStore((s) => s.videoDurations);
  const sequencePath = useSessionStore((s) => s.sequencePath);

  const [format, setFormat] = useState<Format>(null);
  const [width, setWidth] = useState(DEFAULTS.width);
  const [height, setHeight] = useState(DEFAULTS.height);
  const [fps, setFps] = useState(DEFAULTS.fps);
  const [bitrateMbps, setBitrateMbps] = useState(DEFAULTS.bitrateMbps);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const spec = FORMATS.find((f) => f.value === format) ?? FORMATS[0];
  const isRender = format === null;

  const closeUnlessBusy = () => {
    if (!busy) onClose();
  };

  const segments = useMemo(
    () =>
      buildSegments(clips, totalDurationSec, shotsLatestMedia, videoDurations),
    [clips, totalDurationSec, shotsLatestMedia, videoDurations],
  );

  const sequenceName = sequencePath ? basename(sequencePath) : "timeline";
  const defaultSaveName = `${sequenceName}.${spec.ext}`;

  const onPickFormat = (next: Format) => {
    setFormat(next);
    // The chosen path carries the old format's extension; make the user
    // re-pick rather than silently writing OTIO into a .mp4.
    setOutputPath(null);
    setErr(null);
  };

  const onPickPath = async () => {
    const p = await pickSaveFile("Export timeline", {
      extensions: [spec.ext],
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
      if (format === null) {
        const cfg = await cmd.config_load().catch(() => null);
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
      } else {
        // Edit lists are plain text — no ffmpeg needed, so no path check.
        await cmd.timeline_export_interchange({
          segments,
          outputPath,
          format,
          name: sequenceName,
          width,
          height,
          fps,
        });
      }
      setBusy(false);
      onClose();
      await showMessage(`Exported to: ${outputPath}`, { kind: "info" });
    } catch (e) {
      setBusy(false);
      setErr(String(e));
    }
  };

  return (
    <ModalDialog
      onClose={closeUnlessBusy}
      padded={false}
      panelClassName="max-w-[460px] w-full shadow-xl"
    >
      <div className="px-4 py-2 bg-accent text-text text-sm">
        Export timeline
      </div>
        <div className="p-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <label className="self-center text-dim">Format</label>
          <div className="flex items-center gap-1">
            {FORMATS.map((f) => (
              <button
                key={f.label}
                type="button"
                title={f.hint}
                disabled={busy}
                onClick={() => onPickFormat(f.value)}
                className={`px-2 py-[2px] text-xs disabled:opacity-50 ${
                  f.value === format ? "bg-accent text-text" : "bg-dim text-text"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <label className="self-center text-dim">Width</label>
          <NumField value={width} setValue={setWidth} min={2} step={1} />

          <label className="self-center text-dim">Height</label>
          <NumField value={height} setValue={setHeight} min={2} step={1} />

          <label className="self-center text-dim">FPS</label>
          <NumField value={fps} setValue={setFps} min={1} step={1} />

          {isRender && (
            <>
              <label className="self-center text-dim">Bitrate (Mbps)</label>
              <NumField
                value={bitrateMbps}
                setValue={setBitrateMbps}
                min={0.1}
                step={0.5}
              />
            </>
          )}

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
          <div className="pt-1">{spec.hint}</div>
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
            {busy ? (isRender ? "Exporting…" : "Writing…") : isRender ? "Export" : "Write"}
          </button>
        </div>
    </ModalDialog>
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
