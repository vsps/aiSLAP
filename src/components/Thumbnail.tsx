import { memo, useEffect, useRef, useState } from "react";
import type { GalleryImage, ImageMetadata } from "../lib/types";
import { IconBtn } from "./IconBtn";
import { fileSrc } from "../lib/assets";
import { PathContextMenu } from "./PathContextMenu";
import { cmd } from "../lib/tauri";
import { seqShotNamesForMedia } from "../lib/prism";
import { assemblePromptFromMetadata } from "../lib/actions";
import { startThresholdDrag } from "../lib/dragThreshold";
import { getConfigCached, getImageMetadataCached } from "../lib/metadataCache";
import { useNearViewport } from "../lib/useNearViewport";
import { UNKNOWN_TAG_COLOR, useTagsStore } from "../stores/tagsStore";

type Props = {
  image: GalleryImage;
  selected: boolean;
  hidden?: boolean;
  columnVersion: string;
  isDragSource?: boolean;
  onSelect: (path: string) => void;
  /** Opens the tag editor, anchored to the button that was clicked. */
  onEditTags: (path: string, anchor?: DOMRect) => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** Disables drag start. Used in the tag view where drag-to-column has no destination. */
  dragDisabled?: boolean;
  /** Caps the computed aspect ratio. In grid views portrait images are forced square. */
  maxAspect?: number;
};

const DRAG_THRESHOLD_PX = 5;

type VideoInfoProbe = {
  fps: number | null;
  durationSec: number | null;
  width?: number | null;
  height?: number | null;
};

// Renders in long gallery columns (100+ instances), so it's wrapped in memo:
// a parent re-render skips re-rendering thumbs whose props are referentially
// equal. Callers should pass stable props/callbacks to get the full benefit.
export const Thumbnail = memo(function Thumbnail({
  image,
  selected,
  hidden,
  columnVersion,
  isDragSource,
  onSelect,
  onEditTags,
  onDragStart,
  dragDisabled,
  maxAspect,
}: Props) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const colorsByName = useTagsStore((s) => s.colorsByName);
  const tags = image.tags ?? [];
  const [aspect, setAspect] = useState<number>(1);
  const rootRef = useRef<HTMLDivElement>(null);

  // Natural pixel dimensions, for the hover tooltip. Set from the same
  // onLoad/onLoadedMetadata handlers that compute `aspect`.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // Hover tooltip state
  const [tooltipMeta, setTooltipMeta] = useState<ImageMetadata | null>(null);
  // Distinguishes "haven't looked up metadata yet" from "looked it up, there
  // isn't any" (e.g. SRC/ref images, which have no sidecar) — the latter
  // still gets a tooltip with filename/dims, just without metadata fields.
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [videoInfo, setVideoInfo] = useState<VideoInfoProbe | null>(null);
  // The tile renders a downscaled derivative, so `dims` (measured off the
  // rendered element) is the thumbnail's size, not the file's. The tooltip has
  // to report the real thing, which means asking the backend. Resolved lazily
  // on hover, since that's the only consumer, and cached for the mount.
  const [trueDims, setTrueDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoInfoCache = useRef<VideoInfoProbe | "loading" | null>(null);
  const trueDimsCache = useRef<{ w: number; h: number } | "none" | null>(null);

  // When selection arrives via keyboard nav the thumb may be offscreen; scroll
  // it back into view. "nearest" avoids jumpy scrolls for already-visible rows.
  useEffect(() => {
    if (selected)
      rootRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  // Nothing is fetched until the tile is within a screenful of the viewport.
  // The wrapper below stays mounted either way, so scrollIntoView, the aspect
  // box, the tag dots and the context menu all keep working while it's cold.
  const near = useNearViewport(rootRef);

  // Stills have cached thumbnails now too, so `thumbPath` is checked first for
  // every kind. The per-kind part is only the fallback: a still with no cache
  // entry yet still shows its original (large, but correct), while a video
  // without a poster must not — that path mounts a real <video> element.
  const srcUrl = image.thumbPath
    ? fileSrc(image.thumbPath)
    : image.isVideo || image.isModel3d
      ? null
      : fileSrc(image.path);

  // Reset aspect/dims when image changes so stale values don't persist briefly.
  // Gated on `near` too: an offscreen tile has nothing loaded to measure, and
  // firing here would reset the aspect of a tile that is only just scrolling in.
  useEffect(() => {
    if (!near) return;
    setAspect(1);
    setDims(null);
  }, [srcUrl, near]);

  function clampAspect(raw: number): number {
    return maxAspect != null ? Math.min(raw, maxAspect) : raw;
  }

  // Drag origin: start tracking on pointerdown, only convert to a drag once the
  // pointer has moved past the threshold. Below threshold = the click handler runs.
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if (dragDisabled) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest("button")) return;
    startThresholdDrag(e, DRAG_THRESHOLD_PX, () =>
      onDragStart({
        fromPath: image.path,
        fromColumnVersion: columnVersion,
        pointerEvent: e,
      }),
    );
  }

  function onMouseEnter(e: React.MouseEvent) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
    hoverTimerRef.current = setTimeout(async () => {
      const m = await getImageMetadataCached(image.path);
      setTooltipMeta(m);
      setMetaLoaded(true);

      // Video-only: fps/duration/dimensions aren't derivable from the
      // thumbnail image (which is what's actually rendered when a thumbPath
      // exists), so probe via ffmpeg. Cached per-thumbnail; a
      // missing/unconfigured ffmpeg just means the tooltip omits them.
      if (image.isVideo) {
        let v = videoInfoCache.current;
        if (v === null || v === "loading") {
          videoInfoCache.current = "loading";
          const cfg = await getConfigCached();
          const ffmpegPath = (cfg?.ffmpegPath ?? "").trim();
          v = ffmpegPath
            ? await cmd
                .video_info_probe(image.path, ffmpegPath)
                .catch(() => ({ fps: null, durationSec: null }))
            : { fps: null, durationSec: null };
          videoInfoCache.current = v;
        }
        setVideoInfo(v);
      } else if (!image.isModel3d) {
        // A still renders its cached 1024px thumbnail, so the real dimensions
        // have to come from the file's own header. Cheap — `imagesize` reads
        // the first few bytes rather than decoding.
        let d = trueDimsCache.current;
        if (d === null) {
          const read = await cmd
            .image_dimensions_read(image.path)
            .catch(() => null);
          d = read ? { w: read.width, h: read.height } : "none";
          trueDimsCache.current = d;
        }
        if (d !== "none") setTrueDims(d);
      }
    }, 600);
  }

  function onMouseMove(e: React.MouseEvent) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }

  function onMouseLeave() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setTooltipMeta(null);
    setMetaLoaded(false);
    setTooltipPos(null);
    setVideoInfo(null);
  }

  // The media's real size, in preference to whatever the tile happens to be
  // rendering — a still shows a 1024px cached thumbnail and a video shows a
  // downscaled poster, so `dims` (measured off the element) is the derivative's
  // size in both cases. `dims` stays as the fallback for the one tile that
  // still measures its actual media: a posterless video's <video> element.
  const shownDims =
    trueDims ??
    (videoInfo?.width != null && videoInfo.height != null
      ? { w: videoInfo.width, h: videoInfo.height }
      : null) ??
    dims;

  // e.g. "1920x1080" for images, "1920x1080 24fps 3.0s" for videos (fps/duration
  // only once the ffmpeg probe resolves — see onMouseEnter).
  const dimsLabel = shownDims
    ? image.isVideo
      ? [
          `${shownDims.w}x${shownDims.h}`,
          videoInfo?.fps != null
            ? `${Math.round(videoInfo.fps * 10) / 10}fps`
            : null,
          videoInfo?.durationSec != null
            ? `${videoInfo.durationSec.toFixed(1)}s`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : `${shownDims.w}x${shownDims.h}`
    : null;

  const tooltipPrompt = tooltipMeta
    ? assemblePromptFromMetadata(tooltipMeta)
    : null;

  // GLOBAL SRC sits directly under the project, so it has no sequence/shot to
  // show. Everything else is <shot>/<version>/<filename>, where <shot> may be a
  // PRISM media root — seqShotNamesForMedia resolves the entity either way.
  const sequenceShotLabel = (() => {
    if (columnVersion === "GLOBAL SRC") return "GLOBAL SRC";
    const { seq, shot } = seqShotNamesForMedia(image.path);
    return [seq, shot].filter(Boolean).join(" / ");
  })();

  if (hidden) return null;

  // Pending placeholder: pulsing skeleton square with a subtle spinner.
  if (image.pending) {
    return (
      <div
        ref={rootRef}
        className="group relative w-full shrink-0 overflow-hidden border border-dim/30 bg-panel"
        style={{
          paddingBottom: `${maxAspect != null ? maxAspect * 100 : 100}%`,
        }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-dim/40 border-t-accent animate-spin" />
        </div>
        <div className="absolute inset-0 bg-accent/5 animate-pulse" />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`group relative w-full shrink-0 overflow-hidden cursor-pointer border ${
        selected ? "border-accent" : "border-transparent"
      } ${isDragSource ? "opacity-40" : ""} bg-bg`}
      style={{ paddingBottom: `${aspect * 100}%` }}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(image.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {srcUrl ? (
        // `near &&` only on the two branches that actually read from disk —
        // the icon placeholders below cost nothing and are better shown early.
        near && (
          <img
            src={srcUrl}
            loading="lazy"
            decoding="async"
            alt=""
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0) {
                setAspect(clampAspect(el.naturalHeight / el.naturalWidth));
                setDims({ w: el.naturalWidth, h: el.naturalHeight });
              }
            }}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )
      ) : image.isVideo ? (
        // A posterless video mounts a real media element, which range-reads the
        // container header (and, for a non-faststart file, seeks to the end for
        // the moov atom). Far and away the most expensive tile on a share.
        near && (
          <video
            src={fileSrc(image.path)}
            preload="metadata"
            muted
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0) {
                setAspect(clampAspect(v.videoHeight / v.videoWidth));
                setDims({ w: v.videoWidth, h: v.videoHeight });
              }
            }}
          />
        )
      ) : image.isModel3d ? (
        <div className="absolute inset-0 flex items-center justify-center bg-dim text-text">
          <span className="material-symbols-outlined" style={{ fontSize: 40 }}>
            deployed_code
          </span>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-dim text-text">
          <span className="material-symbols-outlined" style={{ fontSize: 40 }}>
            play_circle
          </span>
        </div>
      )}
      {image.isVideo && (
        <span
          className="absolute top-1 right-1 material-symbols-outlined text-text drop-shadow"
          style={{ fontSize: 18 }}
        >
          play_circle
        </span>
      )}
      {image.isModel3d && (
        <span
          className="absolute top-1 right-1 material-symbols-outlined text-text drop-shadow"
          style={{ fontSize: 18 }}
        >
          deployed_code
        </span>
      )}
      {/* Tag dots — always on, top-left (the one free corner), so a tagged
          image reads as tagged without hovering. */}
      {tags.length > 0 && (
        <div
          className="absolute top-1 left-1 flex gap-[2px] drop-shadow"
          title={tags.join(", ")}
        >
          {tags.map((t) => (
            <span
              key={t}
              className="w-[6px] h-[6px]"
              style={{
                background: colorsByName.get(t.toLowerCase()) ?? UNKNOWN_TAG_COLOR,
              }}
            />
          ))}
        </div>
      )}
      {/* Corner toggles: hidden by default, visible on hover; white when off,
          accent + filled when ON; hovering the icon itself previews accent. */}
      <IconBtn
        name="sell"
        size={18}
        fill={tags.length > 0}
        title={tags.length > 0 ? `Tags: ${tags.join(", ")}` : "Add tags"}
        onClick={(e) => {
          e.stopPropagation();
          onEditTags(
            image.path,
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
          );
        }}
        className={`absolute bottom-1 left-1 drop-shadow transition-opacity transition-colors ${
          tags.length > 0
            ? "opacity-100 text-accent"
            : "opacity-0 group-hover:opacity-100 text-white hover:text-accent"
        }`}
      />
      {tooltipPos && metaLoaded && (
        <div
          className="fixed z-50 pointer-events-none max-w-xs bg-panel/95 border border-dim shadow-xl px-2 py-1.5 text-xs space-y-0.5"
          style={{
            left: Math.min(tooltipPos.x + 12, window.innerWidth - 260),
            top: tooltipPos.y - 8,
            transform: "translateY(-100%)",
          }}
        >
          {tooltipMeta?.provider && (
            <div className="text-dim">{tooltipMeta.provider}</div>
          )}
          {tooltipMeta?.model && (
            <div className="text-text font-semibold truncate">
              {tooltipMeta.model}
            </div>
          )}
          <div className="text-dim truncate">{sequenceShotLabel}</div>
          <div className="font-mono text-text truncate">{image.filename}</div>
          {dimsLabel && (
            <div className="text-dim font-mono truncate">{dimsLabel}</div>
          )}
          {tooltipPrompt && (
            <div className="text-dim mt-0.5 line-clamp-2 whitespace-pre-wrap">
              {tooltipPrompt}
            </div>
          )}
        </div>
      )}

      {menuPos && (
        <PathContextMenu
          x={menuPos.x}
          y={menuPos.y}
          path={image.path}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
});
