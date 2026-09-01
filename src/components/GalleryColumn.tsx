import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GalleryColumn as GalleryColumnData } from "../lib/types";
import { editTagsAt, type ImageAction } from "../lib/actions";
import { FileRow } from "./FileRow";
import { GalleryColumnResizeHandle } from "./GalleryColumnResizeHandle";
import { IconBtn } from "./IconBtn";
import { Thumbnail } from "./Thumbnail";
import { useSessionStore } from "../stores/sessionStore";
import { usePricesStore } from "../stores/pricesStore";
import { perItemPrice, parseDurationSeconds, formatCost } from "../lib/falPrices";
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
  /** Whether this version folder has any files, unaffected by the active
   *  tag/user filter (which can make `column.images` read empty even when
   *  the folder isn't) — gates the delete button so it can't fire on a
   *  folder that only *looks* empty because of the current filter. */
  hasFiles: boolean;
  /** Render filenames instead of thumbnails. */
  listMode?: boolean;
  /** True inside a PRISM project, where aiSLAP never deletes anything. */
  deleteDisabled?: boolean;
  onImageAction: (action: ImageAction, imagePath: string) => void;
  onRefresh?: () => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** DELIVER mode: show a tick box on every tile. */
  selectable?: boolean;
  /** Paths the user has un-ticked. Passed as a Set for O(1) per-tile lookup. */
  excludedSet?: Set<string>;
  onToggleExcluded?: (path: string) => void;
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
  hasFiles,
  listMode,
  deleteDisabled,
  onImageAction,
  onRefresh,
  onDragStart,
  selectable,
  excludedSet,
  onToggleExcluded,
}: Props) {
  const targetVersion = useSessionStore((s) => s.targetVersion);
  const setTargetVersion = useSessionStore((s) => s.setTargetVersion);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);

  // Approximate total cost of this column's generations, from cached fal
  // prices (Settings → fetch prices) matched against each image's sidecar
  // metadata (endpoint). SRC/ref columns aren't generations, so skipped
  // entirely. Time/size-billed and unpriced images are silently excluded from
  // the total and surfaced only as an "unpriced" count in the tooltip.
  const prices = usePricesStore((s) => s.prices);
  const priceOverrides = usePricesStore((s) => s.overrides);
  const [colCost, setColCost] = useState<{
    total: number;
    unknown: number;
  } | null>(null);
  // `column.images` gets a fresh identity on every shot rescan — i.e. after
  // every generation iteration — even when the same files came back. Keying
  // the effect on the paths themselves means an unchanged rescan doesn't
  // re-enter this at all: no IPC round trip per image, no extra render.
  const imagePathsKey = useMemo(
    () => column.images.map((i) => i.path).join("\u0000"),
    [column.images],
  );
  const imagesRef = useRef(column.images);
  imagesRef.current = column.images;

  useEffect(() => {
    const images = imagesRef.current;
    if (column.isSrc || images.length === 0) {
      setColCost(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const metas = await Promise.all(
        images.map((img) => getImageMetadataCached(img.path)),
      );
      if (cancelled) return;
      let total = 0;
      let unknown = 0;
      for (let i = 0; i < metas.length; i++) {
        const m = metas[i];
        // Trust the cost actually billed at generation time (stored costUsd —
        // fal's authoritative per-job estimate when available, else the local
        // per-item computation made with prices as of that generation) over a
        // fresh recompute: re-deriving from today's cached prices would drift
        // from the real historical cost whenever prices change, and silently
        // misses area-billed models (no megapixels available here to price
        // them). Same priority as the Settings -> Costs project scan.
        const amount =
          typeof m?.costUsd === "number" && Number.isFinite(m.costUsd)
            ? m.costUsd
            : m
              ? perItemPrice(m.provider, m.endpoint, prices, priceOverrides, {
                  isVideo: images[i].isVideo,
                  durationSec: parseDurationSeconds(m.settings?.duration),
                  resolution:
                    typeof m.settings?.resolution === "string"
                      ? m.settings.resolution
                      : null,
                })
              : null;
        if (amount != null) total += amount;
        else unknown += 1;
      }
      // Bail when the numbers didn't move, so a recompute that confirms the
      // status quo doesn't cost a render.
      setColCost((prev) =>
        prev && prev.total === total && prev.unknown === unknown
          ? prev
          : { total, unknown },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [column.isSrc, imagePathsKey, prices, priceOverrides]);

  // Stable per-column callbacks so memo'd Thumbnails skip re-renders.
  const handleSelect = useCallback(
    (path: string) => onImageAction("select", path),
    [onImageAction],
  );
  const handleEditTags = useCallback(
    (path: string, anchor?: DOMRect) => editTagsAt(path, anchor),
    [],
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
  // Irrelevant in list mode, which renders no images.
  const maxAspect = !listMode && subCols > 1 ? 1 : undefined;
  // List mode keeps `subCols` driving the column's *width* (so a narrow tile
  // setting still yields a readable ~240px column) but always stacks its rows.
  const gridClass = listMode
    ? "flex flex-col"
    : subCols === 3
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
      } relative p-gallery-column flex flex-col gap-gallery-column-gap shrink-0 h-full min-h-0`}
      style={{ width: `${effectiveWidth}px` }}
    >
      {!collapsed && (
        <GalleryColumnResizeHandle
          version={column.version}
          width={width}
          subCols={subCols}
        />
      )}
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
                title={
                  deleteDisabled
                    ? "PRISM projects: aiSLAP never deletes"
                    : hasFiles
                      ? "Empty this version folder before deleting it"
                      : "Delete version folder"
                }
                disabled={hasFiles || deleteDisabled}
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
            {column.images.map((img) =>
              listMode ? (
                <FileRow
                  key={img.path}
                  image={img}
                  selected={selectedImagePath === img.path}
                  columnVersion={column.version}
                  isDragSource={dragState?.fromPath === img.path}
                  onSelect={handleSelect}
                  onDragStart={onDragStart}
                />
              ) : (
                <Thumbnail
                  key={img.path}
                  image={img}
                  selected={selectedImagePath === img.path}
                  columnVersion={column.version}
                  isDragSource={dragState?.fromPath === img.path}
                  onSelect={handleSelect}
                  onEditTags={handleEditTags}
                  onDragStart={onDragStart}
                  maxAspect={maxAspect}
                  checkable={selectable}
                  checked={selectable && !excludedSet?.has(img.path)}
                  onToggleChecked={onToggleExcluded}
                />
              ),
            )}
            {column.images.length === 0 && (
              <div
                className={`text-xs text-dim text-center py-2${!listMode && subCols > 1 ? ` col-span-${subCols}` : ""}`}
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
