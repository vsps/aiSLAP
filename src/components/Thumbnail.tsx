import { memo, useEffect, useRef, useState } from "react";
import type { GalleryImage, ImageMetadata } from "../lib/types";
import { IconBtn } from "./IconBtn";
import { fileSrc } from "../lib/assets";
import { PathContextMenu } from "./PathContextMenu";
import { cmd } from "../lib/tauri";
import { basename, dirname } from "../lib/paths";
import { assemblePromptFromMetadata } from "../lib/actions";
import { startThresholdDrag } from "../lib/dragThreshold";

type Props = {
  image: GalleryImage;
  selected: boolean;
  hidden?: boolean;
  columnVersion: string;
  isDragSource?: boolean;
  onSelect: (path: string) => void;
  onToggleStar: (path: string) => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** Disables drag start. Used in the starred view where drag-to-column has no destination. */
  dragDisabled?: boolean;
  /** Whether this image is currently the shot's exclusive "clip media" pick. */
  clipMediaSelected?: boolean;
  /** When defined, renders the clip-media toggle button. */
  onToggleClipMedia?: (path: string) => void;
  /** Caps the computed aspect ratio. In grid views portrait images are forced square. */
  maxAspect?: number;
};

const DRAG_THRESHOLD_PX = 5;

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
  onToggleStar,
  onDragStart,
  dragDisabled,
  clipMediaSelected,
  onToggleClipMedia,
  maxAspect,
}: Props) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [aspect, setAspect] = useState<number>(1);
  const rootRef = useRef<HTMLDivElement>(null);

  // Natural pixel dimensions, for the hover tooltip. Set from the same
  // onLoad/onLoadedMetadata handlers that compute `aspect`.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // Hover tooltip state
  const [tooltipMeta, setTooltipMeta] = useState<ImageMetadata | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [videoInfo, setVideoInfo] = useState<{ fps: number | null; durationSec: number | null } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaCache = useRef<ImageMetadata | null | "loading">(null);
  const videoInfoCache = useRef<{ fps: number | null; durationSec: number | null } | "loading" | null>(null);

  // When selection arrives via keyboard nav the thumb may be offscreen; scroll
  // it back into view. "nearest" avoids jumpy scrolls for already-visible rows.
  useEffect(() => {
    if (selected)
      rootRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const srcUrl =
    image.isVideo || image.isModel3d
      ? image.thumbPath
        ? fileSrc(image.thumbPath)
        : null
      : fileSrc(image.path);

  // Reset aspect/dims when image changes so stale values don't persist briefly.
  useEffect(() => {
    setAspect(1);
    setDims(null);
  }, [srcUrl]);

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
      let m = metaCache.current;
      if (m === null || m === "loading") {
        metaCache.current = "loading";
        m = await cmd.image_metadata_read(image.path).catch(() => null);
        metaCache.current = m;
      }
      setTooltipMeta(m);

      // Video-only: fps/duration aren't derivable from the thumbnail image
      // (which is what's actually rendered when a thumbPath exists), so probe
      // via ffmpeg. Cached per-thumbnail; a missing/unconfigured ffmpeg just
      // means the tooltip omits fps/duration.
      if (image.isVideo) {
        let v = videoInfoCache.current;
        if (v === null || v === "loading") {
          videoInfoCache.current = "loading";
          const cfg = await cmd.config_load().catch(() => null);
          const ffmpegPath = (cfg?.ffmpegPath ?? "").trim();
          v = ffmpegPath
            ? await cmd
                .video_info_probe(image.path, ffmpegPath)
                .catch(() => ({ fps: null, durationSec: null }))
            : { fps: null, durationSec: null };
          videoInfoCache.current = v;
        }
        setVideoInfo(v);
      }
    }, 600);
  }

  function onMouseMove(e: React.MouseEvent) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }

  function onMouseLeave() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setTooltipMeta(null);
    setTooltipPos(null);
    setVideoInfo(null);
  }

  // e.g. "1920x1080" for images, "1920x1080 24fps 3.0s" for videos (fps/duration
  // only once the ffmpeg probe resolves — see onMouseEnter).
  const dimsLabel = dims
    ? image.isVideo
      ? [
          `${dims.w}x${dims.h}`,
          videoInfo?.fps != null ? `${Math.round(videoInfo.fps * 10) / 10}fps` : null,
          videoInfo?.durationSec != null ? `${videoInfo.durationSec.toFixed(1)}s` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : `${dims.w}x${dims.h}`
    : null;

  const tooltipPrompt = tooltipMeta ? assemblePromptFromMetadata(tooltipMeta) : null;

  // Path layout is <project>/<sequence>/<shot>/<version>/<filename>. GLOBAL SRC
  // sits directly under <project>, so it has no sequence/shot to show.
  const sequenceShotLabel =
    columnVersion === "GLOBAL SRC"
      ? "GLOBAL SRC"
      : [basename(dirname(dirname(dirname(image.path)))), basename(dirname(dirname(image.path)))]
          .filter(Boolean)
          .join(" / ");

  if (hidden) return null;

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
      ) : image.isVideo ? (
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
      {/* Corner toggles: hidden by default, visible on hover; white when off,
          accent + filled when ON; hovering the icon itself previews accent. */}
      <IconBtn
        name="star"
        size={18}
        fill={!!image.starred}
        title={image.starred ? "Remove from favorites" : "Add to favorites"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(image.path);
        }}
        className={`absolute bottom-1 left-1 drop-shadow transition-opacity transition-colors ${
          image.starred
            ? "opacity-100 text-accent"
            : "opacity-0 group-hover:opacity-100 text-white hover:text-accent"
        }`}
      />
      {onToggleClipMedia && (
        <IconBtn
          name="movie"
          size={18}
          fill={!!clipMediaSelected}
          title={clipMediaSelected ? "Clear clip media" : "Set as clip media"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleClipMedia(image.path);
          }}
          className={`absolute bottom-1 right-1 drop-shadow transition-opacity transition-colors ${
            clipMediaSelected
              ? "opacity-100 text-accent"
              : "opacity-0 group-hover:opacity-100 text-white hover:text-accent"
          }`}
        />
      )}

      {tooltipPos && tooltipMeta !== null && (
        <div
          className="fixed z-50 pointer-events-none max-w-xs bg-panel/95 border border-dim shadow-xl px-2 py-1.5 text-xs space-y-0.5"
          style={{
            left: Math.min(tooltipPos.x + 12, window.innerWidth - 260),
            top: tooltipPos.y - 8,
            transform: "translateY(-100%)",
          }}
        >
          {tooltipMeta.provider && <div className="text-dim">{tooltipMeta.provider}</div>}
          {tooltipMeta.model && (
            <div className="text-text font-semibold truncate">{tooltipMeta.model}</div>
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
