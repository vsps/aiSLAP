import { useEffect, useRef, useState } from "react";
import type { GalleryImage, ImageMetadata } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { THUMB_SUFFIXES } from "../lib/media";
import { cmd } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import { showMessage } from "../lib/dialog";
import { dirname, basename } from "../lib/paths";
import { formatTimecode } from "../lib/format";
import { getConfigCached, invalidateImageMetadata } from "../lib/metadataCache";
import { identifyMedia, recordAsset } from "../lib/generation/output";
import { FullscreenModal } from "./FullscreenModal";
import { IconBtn } from "./IconBtn";
import { Btn } from "./Btn";

type Props = {
  image: GalleryImage;
  onSave: (newPath: string) => void;
  onCancel: () => void;
};

/** Assumed framerate when ffmpeg isn't configured, so frame stepping still
 *  does something sane. Only affects the step size and the frame readout —
 *  the cut itself is made in seconds. */
const FALLBACK_FPS = 25;

/** Full media triple for the trimmed clip: a sidecar cloned from the source
 *  under a fresh identity, a poster frame, and an index row. Mirrors the
 *  video branch of writeOutputs (lib/generation/output.ts) — the sidecar
 *  write is the durable commit, everything after it is best-effort. */
async function adoptTrimmedClip(
  srcPath: string,
  outPath: string,
  ffmpegPath: string,
  startSec: number,
  endSec: number,
): Promise<void> {
  const src = await cmd.image_metadata_read(srcPath).catch(() => null);
  const { projectPath } = useSessionStore.getState();
  const projectId = projectPath
    ? ((await cmd.project_id_get(projectPath).catch(() => "")) ?? "")
    : "";

  // A derived file is deliberately re-identified — two files must never share
  // an assetId (see reidentify_copy in commands/image.rs).
  const identity = await identifyMedia(outPath, projectId, ffmpegPath);

  // Three fields are deliberately not inherited:
  //  - tags: a trimmed copy of the `select` take is not itself the selected take.
  //  - costUsd: the trim is local work, and inheriting it would double-count
  //    the clip in project_cost_scan.
  //  - refs stays the ORIGINAL generation's inputs rather than being repointed
  //    at the source clip, so RESTORE PROMPT still reproduces the generation
  //    rather than the edit. Lineage lives in derivedFrom instead.
  const { tags: _tags, costUsd: _cost, costUsdActual: _actual, ...inherited } =
    src ?? {};
  const meta: ImageMetadata = {
    model: "",
    modelId: "",
    endpoint: "",
    settings: {},
    refs: [],
    ...inherited,
    timestamp: new Date().toISOString(),
    assetId: identity.assetId,
    contentHash: identity.contentHash,
    derivedFrom: {
      op: "trim",
      path: srcPath,
      assetId: src?.assetId,
      startSec,
      endSec,
    },
  };
  await cmd.image_metadata_write(outPath, meta);
  // metadataCache assumes a sidecar never changes — this path just gained one.
  invalidateImageMetadata(outPath);

  // Without a poster frame the gallery tile renders blank for a video. Goes
  // into the project's thumbnail cache, same as a generated output's — sweeping
  // the containing folder is idempotent, so the other files there are untouched.
  await cmd.thumbs_ensure(dirname(outPath), false, ffmpegPath).catch(() => null);

  if (projectPath) {
    await recordAsset(projectPath, outPath, meta, identity).catch(() => {});
  }
}

/** First `<stem>_trim[_n].mp4` where no member of the media triple exists —
 *  mirrors resolve_dest_stem's Uniquify policy in commands/image.rs. Never
 *  overwrites: the source is the durable record, and aiSLAP has no hard
 *  delete. Always .mp4, since the re-encode always produces h264/aac. */
async function freeTrimPath(src: string): Promise<string> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const dir = dirname(src);
  const stem = basename(src).replace(/\.[^.]+$/, "");
  for (let n = 0; ; n++) {
    const s = `${stem}_trim${n ? `_${n}` : ""}`;
    const taken = await Promise.all([
      exists(`${dir}/${s}.mp4`),
      exists(`${dir}/${s}.json`),
      ...THUMB_SUFFIXES.map((suffix) => exists(`${dir}/${s}${suffix}`)),
    ]);
    if (!taken.some(Boolean)) return `${dir}/${s}.mp4`;
  }
}

/** Set in/out points on a video and write the cut as a new sibling clip.
 *  Mounted by ImageZoomModal alongside DrawMode/CropMode — those are the
 *  still-image editors, this is the video one. */
export function TrimMode({ image, onSave, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState<number | null>(null);
  const [inSec, setInSec] = useState(0);
  const [outSec, setOutSec] = useState(0);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  // null while the config is still loading, "" once we know it's unset.
  const [ffmpegPath, setFfmpegPath] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const frameStep = 1 / (fps ?? FALLBACK_FPS);
  const canSave =
    duration > 0 && outSec - inSec >= frameStep && !!ffmpegPath && !saving;

  // ffmpeg gives us fps (frame stepping, frame readout) and a duration
  // fallback for a webm whose header doesn't carry one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await getConfigCached();
      const path = (cfg?.ffmpegPath ?? "").trim();
      if (cancelled) return;
      setFfmpegPath(path);
      if (!path) return;
      const info = await cmd
        .video_info_probe(image.path, path)
        .catch(() => ({ fps: null, durationSec: null }));
      if (cancelled) return;
      if (info.fps && info.fps > 0) setFps(info.fps);
      if (info.durationSec && info.durationSec > 0) {
        setDuration((d) => (Number.isFinite(d) && d > 0 ? d : info.durationSec!));
        setOutSec((o) => (o > 0 ? o : info.durationSec!));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [image.path]);

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(duration || t, t));
    setCur(clamped);
    try {
      v.currentTime = clamped;
    } catch {
      // Element not ready yet — the next seek lands.
    }
  };

  const stepFrames = (delta: number) => {
    videoRef.current?.pause();
    seekTo(cur + delta);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (cur < inSec || cur >= outSec) seekTo(inSec);
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  const markIn = (t: number) => setInSec(Math.min(t, outSec - frameStep));
  const markOut = (t: number) => setOutSec(Math.max(t, inSec + frameStep));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (e.key === "Escape") el.blur();
        return;
      }
      if (e.key === "Escape") {
        if (!saving) onCancel();
      } else if (e.key === "i") {
        markIn(cur);
      } else if (e.key === "o") {
        markOut(cur);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrames(e.shiftKey ? -1 : -frameStep);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrames(e.shiftKey ? 1 : frameStep);
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Home") {
        e.preventDefault();
        seekTo(inSec);
      } else if (e.key === "End") {
        e.preventDefault();
        seekTo(outSec);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (canSave) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers close over cur/in/out; re-binding each render is fine, and
    // matches ImageZoomModal's own keydown effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const pct = (t: number) => `${duration > 0 ? (t / duration) * 100 : 0}%`;

  const secAtClientX = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || duration <= 0) return 0;
    return Math.max(
      0,
      Math.min(duration, ((clientX - r.left) / r.width) * duration),
    );
  };

  // Window listeners rather than pointer capture (same as TimelineClip's slip
  // drag) so a drag that leaves the bar keeps tracking.
  const startDrag = (which: "in" | "out") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    videoRef.current?.pause();
    const onMove = (ev: PointerEvent) => {
      const t = secAtClientX(ev.clientX);
      if (which === "in") markIn(t);
      else markOut(t);
      // Show the frame being marked — that's the whole point of the feature.
      seekTo(t);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const save = async () => {
    const ffmpeg = (ffmpegPath ?? "").trim();
    if (!ffmpeg) {
      await showMessage("ffmpeg path is not configured (open Settings).", {
        kind: "warning",
      });
      return;
    }
    setSaving(true);
    try {
      videoRef.current?.pause();
      const outPath = await freeTrimPath(image.path);
      await cmd.video_trim({
        inputPath: image.path,
        outputPath: outPath,
        startSec: inSec,
        endSec: outSec,
        ffmpegPath: ffmpeg,
      });
      await adoptTrimmedClip(image.path, outPath, ffmpeg, inSec, outSec);
      const session = useSessionStore.getState();
      await session.rescanShot();
      session.setSelectedImage(outPath);
      onSave(outPath);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const numField =
    "bg-bg border border-border text-text px-1 py-[1px] text-xs font-mono w-24";
  const frameOf = (t: number) => Math.round(t * (fps ?? FALLBACK_FPS));

  return (
    <FullscreenModal
      onClose={onCancel}
      closeOnEscape={false}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden">
        <video
          ref={videoRef}
          src={fileSrc(image.path)}
          className="max-h-full max-w-full object-contain select-none"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (!Number.isFinite(d) || d <= 0) return;
            setDuration(d);
            setOutSec((o) => (o > 0 ? o : d));
          }}
          onError={() =>
            setPreviewError("preview unavailable — trimming by timecode")
          }
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCur(t);
            // Loop inside the selection so the marks can be judged by ear/eye.
            if (!e.currentTarget.paused && t >= outSec) {
              e.currentTarget.currentTime = inSec;
            }
          }}
        />
      </div>

      <div
        className="bg-panel text-text px-3 pt-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          ref={barRef}
          className="relative h-10 bg-inset border border-border select-none cursor-pointer"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            videoRef.current?.pause();
            seekTo(secAtClientX(e.clientX));
          }}
        >
          <div
            className="absolute inset-y-0 left-0 bg-black/60"
            style={{ width: pct(inSec) }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-black/60"
            style={{ left: pct(outSec) }}
          />
          <div
            className="absolute inset-y-0 bg-accent/25"
            style={{
              left: pct(inSec),
              width: `calc(${pct(outSec)} - ${pct(inSec)})`,
            }}
          />
          <div
            className="absolute inset-y-0 w-px bg-white pointer-events-none"
            style={{ left: pct(cur) }}
          />
          <div
            className="absolute inset-y-0 w-1.5 -translate-x-1/2 bg-accent cursor-ew-resize"
            style={{ left: pct(inSec) }}
            title="In point"
            onPointerDown={startDrag("in")}
          />
          <div
            className="absolute inset-y-0 w-1.5 -translate-x-1/2 bg-accent cursor-ew-resize"
            style={{ left: pct(outSec) }}
            title="Out point"
            onPointerDown={startDrag("out")}
          />
        </div>
      </div>

      <div
        className="bg-panel text-text p-2 flex items-center gap-3 flex-wrap"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconBtn
          name="fast_rewind"
          size={20}
          title="Go to in point (Home)"
          onClick={() => seekTo(inSec)}
        />
        <IconBtn
          name={playing ? "pause" : "play_arrow"}
          size={22}
          title={playing ? "Pause (Space)" : "Play selection (Space)"}
          onClick={togglePlay}
        />
        <span className="text-xs text-dim font-mono">
          IN {formatTimecode(inSec)}
          {fps ? ` f${frameOf(inSec)}` : ""} · OUT {formatTimecode(outSec)}
          {fps ? ` f${frameOf(outSec)}` : ""} · LEN{" "}
          {Math.max(0, outSec - inSec).toFixed(3)}s
        </span>
        <div className="w-px h-4 bg-dim/40 mx-1" />
        <Btn title="Set in point at playhead (i)" onClick={() => markIn(cur)}>
          set in
        </Btn>
        <Btn title="Set out point at playhead (o)" onClick={() => markOut(cur)}>
          set out
        </Btn>
        <input
          type="number"
          step={0.001}
          min={0}
          max={duration || undefined}
          value={inSec.toFixed(3)}
          title="In point (seconds)"
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (Number.isFinite(v)) markIn(Math.max(0, v));
          }}
          className={numField}
        />
        <input
          type="number"
          step={0.001}
          min={0}
          max={duration || undefined}
          value={outSec.toFixed(3)}
          title="Out point (seconds)"
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (Number.isFinite(v)) markOut(Math.min(duration || v, v));
          }}
          className={numField}
        />
        {ffmpegPath === "" && (
          <span className="text-xs text-bad">
            ffmpeg path is not configured (open Settings).
          </span>
        )}
        {previewError && (
          <span className="text-xs text-bad">{previewError}</span>
        )}
        <Btn className="ml-auto" onClick={() => void save()} disabled={!canSave}>
          {saving ? "trimming…" : "trim & save"}
        </Btn>
        <Btn onClick={onCancel} disabled={saving}>
          cancel
        </Btn>
      </div>
    </FullscreenModal>
  );
}
