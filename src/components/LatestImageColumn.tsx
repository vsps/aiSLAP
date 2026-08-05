import { useEffect, useMemo, useRef, useState } from "react";
import {
  imageIndexOf,
  taggedImageIndexOf,
  useSessionStore,
} from "../stores/sessionStore";
import {
  useTimelineStore,
  resolveClipMedia,
  clipAtPlayhead,
  nextVideoClipAfter,
  type ResolvedClipMedia,
} from "../stores/timelineStore";
import { fileSrc } from "../lib/assets";
import { IconBtn } from "./IconBtn";
import { ComparePreview } from "./ComparePreview";
import { PathContextMenu } from "./PathContextMenu";
import { editTagsAt, performImageAction } from "../lib/actions";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";
import { basename, dirname } from "../lib/paths";
import { syntheticImage } from "../lib/media";
import type {
  GalleryImage,
  GalleryColumn,
  SeqTaggedGroup,
  TimelineClip,
  ShotLatestMedia,
} from "../lib/types";

/**
 * Fills remaining horizontal space between RefImages and Run. Shows the
 * current selection, or the last image in the target version (i.e. the most
 * recent generation). Videos render with native controls.
 *
 * When the timeline is playing (or scrubbed past 0), this column instead
 * becomes the timeline preview surface.
 */
export function LatestImageColumn() {
  const columns = useSessionStore((s) => s.columns);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const targetVersion = useSessionStore((s) => s.targetVersion);
  const taggedGroups = useSessionStore((s) => s.taggedGroups);
  const tlClips = useTimelineStore((s) => s.clips);
  const tlTotal = useTimelineStore((s) => s.totalDurationSec);
  const tlPlaying = useTimelineStore((s) => s.playing);
  const tlPlayhead = useTimelineStore((s) => s.playheadSec);
  const tlShotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const tlVideoDurations = useTimelineStore((s) => s.videoDurations);
  const shotPath = useSessionStore((s) => s.shotPath);
  const clipMediaPath = useTimelineStore((s) =>
    shotPath ? (s.shotsLatestMedia.get(shotPath)?.clipMediaPath ?? null) : null,
  );
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);

  const timelineActive = useTimelineStore((s) => s.timelineActive);

  const compareMode = useSessionStore((s) => s.compareMode);
  const compareA = useSessionStore((s) => s.compareA);
  const compareB = useSessionStore((s) => s.compareB);
  const setCompareMode = useSessionStore((s) => s.setCompareMode);

  const image = useMemo(
    () => pickImage(columns, selectedImagePath, targetVersion, taggedGroups),
    [columns, selectedImagePath, targetVersion, taggedGroups],
  );
  // Clip media only applies to images living in a shot version dir, not SRC refs.
  const isSrcImage = useMemo(
    () =>
      image
        ? (columns.find(
            (c) =>
              c.images.some((i) => i.path === image.path) ||
              c.srcImages.some((i) => i.path === image.path),
          )?.isSrc ?? false)
        : false,
    [columns, image],
  );
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function exportCurrentFrame(): Promise<void> {
    const v = videoRef.current;
    if (!image || !v) return;
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      await showMessage("Video not ready yet — wait for it to load.", {
        kind: "warning",
      });
      return;
    }
    // The visible <video> loads via the tauri:// asset protocol, which taints
    // a canvas drawn from it. Refetch the bytes through fetch() so we get a
    // same-origin Blob, then draw from an offscreen <video> over a blob URL.
    const t = v.currentTime;
    let blobUrl: string | null = null;
    let off: HTMLVideoElement | null = null;
    try {
      const resp = await fetch(fileSrc(image.path));
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
      const blob = await resp.blob();
      blobUrl = URL.createObjectURL(blob);

      off = document.createElement("video");
      off.muted = true;
      off.preload = "auto";
      off.crossOrigin = "anonymous";
      off.src = blobUrl;

      await new Promise<void>((res, rej) => {
        const ok = () => {
          cleanup();
          res();
        };
        const fail = () => {
          cleanup();
          rej(new Error("offscreen video load failed"));
        };
        const cleanup = () => {
          off!.removeEventListener("loadedmetadata", ok);
          off!.removeEventListener("error", fail);
        };
        off!.addEventListener("loadedmetadata", ok, { once: true });
        off!.addEventListener("error", fail, { once: true });
      });

      const target = Math.min(t, Math.max(0, (off.duration || t) - 0.001));
      await new Promise<void>((res, rej) => {
        const ok = () => {
          cleanup();
          res();
        };
        const fail = () => {
          cleanup();
          rej(new Error("seek failed"));
        };
        const cleanup = () => {
          off!.removeEventListener("seeked", ok);
          off!.removeEventListener("error", fail);
        };
        off!.addEventListener("seeked", ok, { once: true });
        off!.addEventListener("error", fail, { once: true });
        off!.currentTime = target;
      });

      const w = off.videoWidth;
      const h = off.videoHeight;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(off, 0, 0, w, h);
      const base64 = cv.toDataURL("image/png").split(",")[1] ?? "";

      const sec = Math.floor(t);
      const ms3 = String(Math.round((t - sec) * 1000)).padStart(3, "0");
      const stem = basename(image.path).replace(/\.[^.]+$/, "");
      const savePath = `${dirname(image.path)}/${stem}_frame_t${sec}s${ms3}.png`;
      await cmd.save_png_base64(savePath, base64);
      const session = useSessionStore.getState();
      await session.rescanShot();
      session.setSelectedImage(savePath);
    } catch (e) {
      await showMessage(`Frame export failed: ${e}`, { kind: "error" });
    } finally {
      if (off) {
        off.src = "";
        off.removeAttribute("src");
        off.load();
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  const onCtx = (e: React.MouseEvent) => {
    if (!image) return;
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className="bg-surface border border-border p-prompt-column text-text flex-1 min-w-0 flex flex-col gap-prompt-column-gap shrink">
      <div className="flex items-center text-sm font-semibold">
        <span>{timelineActive ? "TIMELINE" : "PREVIEW"}</span>
        {!timelineActive && image && (
          <>
            <span className="flex-1" />
            <span
              className="text-xs opacity-60 font-mono truncate"
              title={image.path}
            >
              {image.filename}
            </span>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 bg-inset relative overflow-hidden">
        {tlClips.length > 0 && (
          <div
            className={`absolute inset-0 ${timelineActive ? "" : "invisible"}`}
          >
            <TimelinePreview
              clips={tlClips}
              totalDurationSec={tlTotal}
              playheadSec={tlPlayhead}
              playing={tlPlaying}
              shotsLatestMedia={tlShotsLatestMedia}
              videoDurations={tlVideoDurations}
            />
          </div>
        )}
        {!timelineActive && compareMode && (
          <ComparePreview pathA={compareA} pathB={compareB} />
        )}
        {!timelineActive && !compareMode && (
          <div className="absolute inset-0 flex items-center justify-center">
            {image ? (
              image.isVideo ? (
                <video
                  ref={videoRef}
                  key={image.path}
                  src={fileSrc(image.path)}
                  controls
                  className="max-w-full max-h-full"
                  onContextMenu={onCtx}
                />
              ) : (
                <img
                  key={image.path}
                  src={fileSrc(image.path)}
                  alt={image.filename}
                  className="max-w-full max-h-full object-contain cursor-zoom-in"
                  onClick={() => void performImageAction("zoom", image.path)}
                  onContextMenu={onCtx}
                />
              )
            ) : (
              <div className="text-xs text-dim">No image</div>
            )}
          </div>
        )}
      </div>
      {!timelineActive && (
        <div className="flex items-center justify-center gap-2 py-1">
          <IconBtn
            name="compare"
            size={22}
            fill={compareMode}
            title={compareMode ? "Exit compare mode" : "Compare mode"}
            onClick={() => setCompareMode(!compareMode)}
          />
          {image && (
            <>
              <IconBtn
                name="zoom_in"
                size={22}
                title="Zoom"
                onClick={() => void performImageAction("zoom", image.path)}
              />
              <IconBtn
                name="copy_all"
                size={22}
                title="Reuse prompt"
                onClick={() =>
                  void performImageAction("copy_settings", image.path)
                }
              />
              <IconBtn
                name="add_photo_alternate"
                size={22}
                title="Use as reference (Ctrl: replace all)"
                onClick={(e) =>
                  void performImageAction(
                    e.ctrlKey || e.metaKey ? "replace_ref" : "add_to_refs",
                    image.path,
                  )
                }
              />
              <IconBtn
                name="sell"
                size={22}
                fill={(image.tags ?? []).length > 0}
                title={
                  (image.tags ?? []).length > 0
                    ? `Tags: ${(image.tags ?? []).join(", ")}`
                    : "Add tags"
                }
                onClick={(e) =>
                  editTagsAt(
                    image.path,
                    (e.currentTarget as HTMLElement).getBoundingClientRect(),
                  )
                }
              />
              {shotPath && !isSrcImage && (
                <IconBtn
                  name="movie"
                  size={22}
                  fill={image.path === clipMediaPath}
                  title={
                    image.path === clipMediaPath
                      ? "Clear clip media"
                      : "Set as clip media"
                  }
                  onClick={() =>
                    void setShotClipMedia(
                      shotPath,
                      image.path === clipMediaPath ? null : image.path,
                    )
                  }
                />
              )}
              {image.isVideo && (
                <IconBtn
                  name="photo_camera"
                  size={22}
                  title="Save current frame as still"
                  onClick={() => void exportCurrentFrame()}
                />
              )}
              {!image.isVideo && (
                <IconBtn
                  name="edit"
                  size={22}
                  title="Edit (draw)"
                  onClick={() => void performImageAction("edit", image.path)}
                />
              )}
              {!image.isVideo && (
                <IconBtn
                  name="crop"
                  size={22}
                  title="Crop"
                  onClick={() => void performImageAction("crop", image.path)}
                />
              )}
            </>
          )}
        </div>
      )}
      {menuPos && image && !timelineActive && (
        <PathContextMenu
          x={menuPos.x}
          y={menuPos.y}
          path={image.path}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

type ActiveContent =
  | {
      kind: "video";
      clip: TimelineClip;
      startSec: number;
      resolved: ResolvedClipMedia;
      effOffset: number;
    }
  | { kind: "image"; resolved: ResolvedClipMedia }
  | { kind: "blank" };

function computeActive(
  clips: TimelineClip[],
  totalDurationSec: number,
  playheadSec: number,
  shotsLatestMedia: Map<string, ShotLatestMedia>,
  videoDurations: Map<string, number>,
): { active: ActiveContent; ctxClipId: string | null } {
  const ctx = clipAtPlayhead(clips, totalDurationSec, playheadSec);
  if (!ctx) return { active: { kind: "blank" }, ctxClipId: null };
  const { clip, startSec, isPad } = ctx;
  if (!clip.enabled || isPad) {
    return { active: { kind: "blank" }, ctxClipId: clip.id };
  }
  const resolved = resolveClipMedia(clip, shotsLatestMedia);
  if (!resolved) return { active: { kind: "blank" }, ctxClipId: clip.id };
  if (resolved.isVideo) {
    const raw = clip.sourceOffsetSec ?? 0;
    const srcDur = videoDurations.get(resolved.path);
    const effOffset =
      srcDur != null
        ? Math.min(raw, Math.max(0, srcDur - clip.durationSec))
        : raw;
    return {
      active: { kind: "video", clip, startSec, resolved, effOffset },
      ctxClipId: clip.id,
    };
  }
  return { active: { kind: "image", resolved }, ctxClipId: clip.id };
}

type SlotInfo = {
  clipId: string;
  path: string;
  offset: number;
  clipStartSec: number;
  isActive: boolean;
};

/**
 * Renders the timeline preview using a persistent two-slot video pool:
 * one slot holds the active clip, the other preloads + pre-seeks the next
 * video clip so boundary transitions don't pay a fresh decode/seek cost.
 * Image and blank/disabled clips render as overlays above the slots so the
 * upcoming video stays warm across non-video gaps.
 */
function TimelinePreview({
  clips,
  totalDurationSec,
  playheadSec,
  playing,
  shotsLatestMedia,
  videoDurations,
}: {
  clips: TimelineClip[];
  totalDurationSec: number;
  playheadSec: number;
  playing: boolean;
  shotsLatestMedia: Map<string, ShotLatestMedia>;
  videoDurations: Map<string, number>;
}) {
  const { active, ctxClipId } = computeActive(
    clips,
    totalDurationSec,
    playheadSec,
    shotsLatestMedia,
    videoDurations,
  );

  const next = nextVideoClipAfter(
    clips,
    totalDurationSec,
    ctxClipId,
    shotsLatestMedia,
    videoDurations,
  );

  const activeId = active.kind === "video" ? active.clip.id : null;
  const nextId = next ? next.clip.id : null;

  // Sticky two-slot assignment. Re-use a slot if it already holds the
  // active or next clip; only swap source when a slot's assignment
  // would otherwise go stale.
  const slotsRef = useRef<{ a: string | null; b: string | null }>({
    a: null,
    b: null,
  });
  let { a, b } = slotsRef.current;
  if (a !== activeId && a !== nextId) a = null;
  if (b !== activeId && b !== nextId) b = null;
  if (activeId && a !== activeId && b !== activeId) {
    if (a === null) a = activeId;
    else b = activeId;
  }
  if (nextId && a !== nextId && b !== nextId) {
    if (a === null) a = nextId;
    else if (b === null) b = nextId;
  }
  slotsRef.current = { a, b };

  const slotInfo = (id: string | null): SlotInfo | null => {
    if (!id) return null;
    if (active.kind === "video" && active.clip.id === id) {
      return {
        clipId: id,
        path: active.resolved.path,
        offset: active.effOffset,
        clipStartSec: active.startSec,
        isActive: true,
      };
    }
    if (next && next.clip.id === id) {
      return {
        clipId: id,
        path: next.resolved.path,
        offset: next.effOffset,
        clipStartSec: next.startSec,
        isActive: false,
      };
    }
    return null;
  };

  const slotA = slotInfo(a);
  const slotB = slotInfo(b);

  return (
    <div className="relative w-full h-full">
      <VideoSlot info={slotA} playheadSec={playheadSec} playing={playing} />
      <VideoSlot info={slotB} playheadSec={playheadSec} playing={playing} />
      {active.kind === "image" && (
        <img
          key={active.resolved.path}
          src={fileSrc(active.resolved.path)}
          alt=""
          className="absolute inset-0 m-auto max-w-full max-h-full object-contain z-20"
          draggable={false}
        />
      )}
      {active.kind === "blank" && (
        <div className="absolute inset-0 bg-black z-20" />
      )}
    </div>
  );
}

function VideoSlot({
  info,
  playheadSec,
  playing,
}: {
  info: SlotInfo | null;
  playheadSec: number;
  playing: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const path = info?.path ?? null;
  const offset = info?.offset ?? 0;
  const isActive = info?.isActive ?? false;
  const clipStartSec = info?.clipStartSec ?? 0;

  // Pre-seek the source to its slipped start so the boundary swap shows
  // the correct frame immediately. Re-runs on path/offset change.
  useEffect(() => {
    const v = ref.current;
    if (!v || !path) return;
    const seek = () => {
      try {
        v.currentTime = offset;
      } catch {
        /* element not ready */
      }
    };
    if (v.readyState >= 1) seek();
    v.addEventListener("loadedmetadata", seek);
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [path, offset]);

  // Drive play/pause for the active slot; keep the inactive one paused.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (isActive && playing) {
      void v.play().catch(() => {
        /* metadata not ready yet — retried on next playhead tick */
      });
    } else {
      v.pause();
    }
  }, [isActive, playing]);

  // Drift-correct currentTime for the active slot. Skip when inactive so
  // we don't fight the pre-seek.
  useEffect(() => {
    if (!isActive) return;
    const v = ref.current;
    if (!v) return;
    const target = playheadSec - clipStartSec + offset;
    if (!Number.isFinite(target) || target < 0) return;
    if (Math.abs(v.currentTime - target) > 0.15) {
      try {
        v.currentTime = target;
      } catch {
        /* element not ready */
      }
    }
  }, [isActive, playheadSec, clipStartSec, offset]);

  return (
    <video
      ref={ref}
      src={path ? fileSrc(path) : undefined}
      className={`absolute inset-0 m-auto max-w-full max-h-full ${
        isActive ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
      }`}
      muted={false}
      playsInline
      preload="auto"
    />
  );
}

function pickImage(
  columns: GalleryColumn[],
  selectedImagePath: string | null,
  targetVersion: string | null,
  taggedGroups: SeqTaggedGroup[],
): GalleryImage | null {
  if (selectedImagePath) {
    // `imageIndexOf` searches images before srcImages, same precedence as the
    // two sequential column scans this replaced.
    const hit = imageIndexOf(columns).get(selectedImagePath);
    if (hit) return hit;
    // Selected image belongs to a shot other than the one currently open
    // (e.g. picked from the tag view) — its columns aren't loaded here, but
    // it's still the user's explicit selection, so show it rather than
    // silently falling back to "no image". Check the tag-view data first so
    // the tag dots/metadata reflect reality; otherwise fall back to a bare
    // synthetic image built from the path alone.
    return (
      taggedImageIndexOf(taggedGroups).get(selectedImagePath) ??
      syntheticImage(selectedImagePath)
    );
  }
  // Fall back to the last image in the target version column.
  const target = columns.find((c) => c.version === targetVersion && !c.isSrc);
  if (target && target.images.length)
    return target.images[target.images.length - 1];
  // Otherwise last image in the latest non-SRC column.
  for (let i = columns.length - 1; i >= 0; i--) {
    const c = columns[i];
    if (!c.isSrc && c.images.length) return c.images[c.images.length - 1];
  }
  return null;
}
