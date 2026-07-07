import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { GalleryColumn as GalleryColumnData } from "../lib/types";
import type { ImageAction } from "../lib/actions";
import { IconBtn } from "./IconBtn";
import { Thumbnail } from "./Thumbnail";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { usePricesStore } from "../stores/pricesStore";
import { perItemPrice, formatCost } from "../lib/falPrices";
import { getImageMetadataCached } from "../lib/metadataCache";
import { getOsDragTarget, subscribeOsDragTarget } from "../lib/osDragDrop";

export type DragState = {
  fromPath: string;
  fromColumnVersion: string;
  /** Stacked-view source shot path (absolute). Only set in stacked view drags. */
  fromShotPath?: string;
  /** Stacked-view source version name (e.g., "v003"). Only set in stacked view drags. */
  fromVersionName?: string;
  overColumnVersion: string | null;
  shiftHeld: boolean;
  /** Ctrl (or Cmd) held — in stacked-view drags, targets the whole stack
   *  instead of just the dragged/selected image. */
  ctrlHeld: boolean;
} | null;

type Props = {
  column: GalleryColumnData;
  width: number;
  destDir: string;
  dragState: DragState;
  collapsed?: boolean;
  onToggleCollapsed: () => void;
  onFolderDelete: () => void;
  onImageAction: (action: ImageAction, imagePath: string) => void;
  onRefresh?: () => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

const COLLAPSED_WIDTH = 28;

export function GalleryColumn({
  column,
  width,
  destDir,
  dragState,
  collapsed,
  onToggleCollapsed,
  onFolderDelete,
  onImageAction,
  onRefresh,
  onDragStart,
}: Props) {
  const targetVersion = useSessionStore((s) => s.targetVersion);
  const setTargetVersion = useSessionStore((s) => s.setTargetVersion);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const shotPath = useSessionStore((s) => s.shotPath);
  const clipMediaPath = useTimelineStore((s) =>
    shotPath ? (s.shotsLatestMedia.get(shotPath)?.clipMediaPath ?? null) : null,
  );
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);

  // Approximate total cost of this column's generations, from cached fal
  // prices (Settings → fetch prices) matched against each image's sidecar
  // metadata (endpoint). SRC/ref columns aren't generations, so skipped
  // entirely. Time/size-billed and unpriced images are silently excluded from
  // the total and surfaced only as an "unpriced" count in the tooltip.
  const prices = usePricesStore((s) => s.prices);
  const [colCost, setColCost] = useState<{
    total: number;
    unknown: number;
  } | null>(null);
  useEffect(() => {
    if (column.isSrc || column.images.length === 0) {
      setColCost(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const metas = await Promise.all(
        column.images.map((img) => getImageMetadataCached(img.path)),
      );
      if (cancelled) return;
      let total = 0;
      let unknown = 0;
      for (const m of metas) {
        const amount = m ? perItemPrice(m.provider, m.endpoint, prices) : null;
        if (amount != null) total += amount;
        else unknown += 1;
      }
      setColCost({ total, unknown });
    })();
    return () => {
      cancelled = true;
    };
  }, [column.isSrc, column.images, prices]);

  // Stable per-column callbacks so memo'd Thumbnails skip re-renders.
  const handleSelect = useCallback(
    (path: string) => onImageAction("select", path),
    [onImageAction],
  );
  const handleToggleStar = useCallback(
    (path: string) => onImageAction("toggle_star", path),
    [onImageAction],
  );
  const handleToggleClipMedia = useCallback(
    (path: string) => {
      if (!shotPath) return;
      const current =
        useTimelineStore.getState().shotsLatestMedia.get(shotPath)
          ?.clipMediaPath ?? null;
      void setShotClipMedia(shotPath, path === current ? null : path);
    },
    [shotPath, setShotClipMedia],
  );
  const osDragHit = useSyncExternalStore(
    subscribeOsDragTarget,
    getOsDragTarget,
  );
  const osDragTarget =
    osDragHit?.kind === "column" && osDragHit.version === column.version;
  const subCols =
    !collapsed && width < 150 ? 3 : !collapsed && width < 300 ? 2 : 1;

  // Stable maxAspect for grid mode — references stay equal between renders.
  const maxAspect = subCols > 1 ? 1 : undefined;
  const gridClass =
    subCols === 3
      ? "grid grid-cols-3 gap-gallery-column-gap content-start"
      : subCols === 2
        ? "grid grid-cols-2 gap-gallery-column-gap content-start"
        : "flex flex-col gap-gallery-column-gap";

  const isTarget = targetVersion === column.version;
  const headerClass = isTarget
    ? "bg-accent text-text"
    : column.isSrc
      ? "bg-surface text-text"
      : "accent-hover text-text";

  const isDropTarget =
    !collapsed &&
    dragState != null &&
    dragState.overColumnVersion === column.version &&
    dragState.fromColumnVersion !== column.version;

  function onHeaderClick() {
    if (collapsed) {
      onToggleCollapsed();
      return;
    }
    if (column.isSrc) {
      onToggleCollapsed();
      return;
    }
    setTargetVersion(column.version);
  }

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width * subCols;

  return (
    <div
      data-column-version={column.version}
      data-column-dest={destDir}
      data-column-is-src={column.isSrc ? "true" : undefined}
      className={`${column.isSrc ? "bg-src-bg" : "bg-surface"} border ${
        isDropTarget || osDragTarget
          ? "outline outline-2 outline-accent border-transparent"
          : "border-border"
      } p-gallery-column flex flex-col gap-gallery-column-gap shrink-0 h-full min-h-0`}
      style={{ width: `${effectiveWidth}px` }}
    >
      {collapsed ? (
        <div
          className={`flex-1 min-h-0 flex flex-col items-center justify-center text-sm cursor-pointer ${headerClass}`}
          onClick={onToggleCollapsed}
          title={`Expand ${column.version}`}
        >
          <button
            className="text-dim hover:text-text leading-none mb-0.5"
            title={`Expand ${column.version}`}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 14 }}
            >
              chevron_left
            </span>
          </button>
          <span className="font-mono" style={{ writingMode: "vertical-rl" }}>
            {column.version}
          </span>
        </div>
      ) : (
        <>
          <div
            className={`flex items-center h-[25px] px-[5px] text-sm shrink-0 ${headerClass}`}
          >
            <button
              className="shrink-0 mr-0.5 text-dim hover:text-text leading-none"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapsed();
              }}
              title="Collapse column"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16 }}
              >
                chevron_right
              </span>
            </button>
            <span
              className="flex-1 truncate cursor-pointer"
              title={column.version}
              onClick={onHeaderClick}
            >
              {column.version}
            </span>
            {!column.isSrc && colCost && colCost.total > 0 && (
              <span
                className="text-[10px] font-mono text-dim shrink-0 mr-1"
                title={
                  colCost.unknown > 0
                    ? `≈ $${formatCost(colCost.total)} total for this column (${colCost.unknown} image${
                        colCost.unknown === 1 ? "" : "s"
                      } unpriced)`
                    : `≈ $${formatCost(colCost.total)} total for this column`
                }
              >
                ≈ ${formatCost(colCost.total)}
              </span>
            )}
            {column.isSrc && onRefresh && (
              <IconBtn
                name="refresh"
                size={18}
                title="Refresh"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefresh();
                }}
              />
            )}
            {!column.isSrc && !column.synthetic && (
              <IconBtn
                name="delete"
                size={18}
                title="Delete version folder"
                onClick={(e) => {
                  e.stopPropagation();
                  onFolderDelete();
                }}
              />
            )}
          </div>
          <div
            className={`flex-1 min-h-0 overflow-y-auto thin-scroll pr-[3px] ${gridClass}`}
          >
            {column.images.map((img) => (
              <Thumbnail
                key={img.path}
                image={img}
                selected={selectedImagePath === img.path}
                columnVersion={column.version}
                isDragSource={dragState?.fromPath === img.path}
                onSelect={handleSelect}
                onToggleStar={handleToggleStar}
                onDragStart={onDragStart}
                clipMediaSelected={img.path === clipMediaPath}
                onToggleClipMedia={
                  shotPath && !column.isSrc ? handleToggleClipMedia : undefined
                }
                maxAspect={maxAspect}
              />
            ))}
            {column.images.length === 0 && (
              <div
                className={`text-xs text-dim text-center py-2${subCols > 1 ? ` col-span-${subCols}` : ""}`}
              >
                {column.isSrc ? "No refs" : "Empty"}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
