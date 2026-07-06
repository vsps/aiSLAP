import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { GalleryColumn as GalleryColumnData } from "../lib/types";
import type { ImageAction } from "../lib/actions";
import { IconBtn } from "./IconBtn";
import { Thumbnail } from "./Thumbnail";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { usePricesStore } from "../stores/pricesStore";
import { basename } from "../lib/paths";
import { classifyMedia } from "../lib/media";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";
import { formatCost, isPerItemUnit, parseFalPrice } from "../lib/falPrices";
import { getImageMetadataCached } from "../lib/metadataCache";

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
  pointerX: number;
  pointerY: number;
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
        const text =
          m && (m.provider ?? "fal") === "fal" ? prices[m.endpoint] : null;
        const parsed = text ? parseFalPrice(text) : null;
        if (parsed && isPerItemUnit(parsed.unit)) total += parsed.amount;
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
  const [osDragTarget, setOsDragTarget] = useState<"src" | "main" | null>(null);
  const [refsCollapsed, setRefsCollapsed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const subCols =
    !collapsed && width < 150 ? 3 : !collapsed && width < 300 ? 2 : 1;

  // Stable maxAspect for grid mode — references stay equal between renders.
  const maxAspect = subCols > 1 ? 1 : undefined;

  // OS file drag-drop onto a column → copy each file in, then rescan so it
  // appears. The GLOBAL SRC column uses ref_copy_to_global_src (project-level,
  // overwrite-on-collision). A version (generation) column routes EVERY drop
  // into its refs (SRC/) subfolder — dropped files are references, never loose
  // generated outputs, so they never land in the version folder itself.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const hitEl = (el: HTMLElement | null, x: number, y: number): boolean => {
      if (!el) return false;
      const dpr = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      const cx = x / dpr;
      const cy = y / dpr;
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    const ingest = async (paths: string[]) => {
      const shot = useSessionStore.getState().shotPath;
      if (!shot) {
        await showMessage("Open a shot first", { kind: "warning" });
        return;
      }
      const media = paths.filter((p) => classifyMedia(p) !== null);
      if (media.length === 0) return;
      let any = false;
      for (const p of media) {
        try {
          if (column.isSrc) {
            await cmd.ref_copy_to_global_src(shot, p);
          } else {
            const srcDir = `${destDir}/SRC`;
            await cmd.dir_ensure(srcDir);
            await cmd.image_copy_to_dir(p, srcDir);
          }
          any = true;
        } catch (e) {
          await showMessage(`Failed to add ${basename(p)}: ${e}`, {
            kind: "error",
          });
        }
      }
      if (any) await useSessionStore.getState().rescanShot();
    };
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const inside = hitEl(panelRef.current, p.position.x, p.position.y);
          // Version columns highlight their refs strip (drop destination);
          // the GLOBAL SRC column highlights as a whole.
          setOsDragTarget(inside ? (column.isSrc ? "main" : "src") : null);
        } else if (p.type === "leave") {
          setOsDragTarget(null);
        } else if (p.type === "drop") {
          const inside = hitEl(panelRef.current, p.position.x, p.position.y);
          setOsDragTarget(null);
          if (inside) await ingest(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("onDragDropEvent registration failed:", e));
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [column.isSrc, destDir]);

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
      ref={panelRef}
      data-column-version={column.version}
      data-column-dest={destDir}
      className={`${column.isSrc ? "bg-src-bg" : "bg-surface"} border ${
        isDropTarget || osDragTarget != null
          ? "outline outline-2 outline-accent border-transparent"
          : "border-border"
      } p-gallery-column flex flex-col gap-gallery-column-gap shrink-0 h-full min-h-0`}
      style={{ width: `${effectiveWidth}px` }}
    >
      {collapsed ? (
        <div
          className={`flex-1 min-h-0 flex items-center justify-center text-sm cursor-pointer ${headerClass}`}
          onClick={onHeaderClick}
          title={`Expand ${column.version}`}
        >
          <span className="font-mono" style={{ writingMode: "vertical-rl" }}>
            {column.version}
          </span>
        </div>
      ) : (
        <>
          <div
            className={`flex items-center h-[25px] px-[5px] text-sm cursor-pointer shrink-0 ${headerClass}`}
            onClick={onToggleCollapsed}
          >
            <span className="flex-1 truncate" title={column.version}>
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
            {!column.isSrc && (
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
          {!column.isSrc && (
            <div className="shrink-0 border-b border-dim/50">
              <div
                className="flex items-center h-[18px] px-1 cursor-pointer select-none"
                onClick={() => setRefsCollapsed((v) => !v)}
              >
                <span
                  className={`text-[10px] font-mono flex-1 ${
                    refsCollapsed && column.srcImages.length > 0
                      ? "text-accent"
                      : "text-dim/50"
                  }`}
                >
                  refs
                  {refsCollapsed && column.srcImages.length > 0
                    ? ` (${column.srcImages.length})`
                    : ""}
                </span>
                <span
                  className="text-[10px] text-dim/40"
                  style={{
                    transform: refsCollapsed ? "rotate(-90deg)" : undefined,
                    display: "inline-block",
                  }}
                >
                  ▾
                </span>
              </div>
              {!refsCollapsed && (
                <div
                  className={`${osDragTarget === "src" ? "outline outline-2 outline-accent" : ""} ${column.srcImages.length === 0 ? "flex items-center justify-center min-h-[22px]" : `p-[3px] ${subCols === 3 ? "grid grid-cols-3 gap-gallery-column-gap content-start" : subCols === 2 ? "grid grid-cols-2 gap-gallery-column-gap content-start" : "flex flex-col gap-gallery-column-gap"}`}`}
                >
                  {column.srcImages.length === 0 ? (
                    <span className="text-[10px] text-dim/30 border border-dashed border-dim/20 px-2 py-px select-none">
                      drop here
                    </span>
                  ) : (
                    column.srcImages.map((img) => (
                      <Thumbnail
                        key={img.path}
                        image={img}
                        selected={selectedImagePath === img.path}
                        columnVersion={column.version}
                        isDragSource={dragState?.fromPath === img.path}
                        onSelect={handleSelect}
                        onToggleStar={handleToggleStar}
                        onDragStart={onDragStart}
                        clipMediaSelected={false}
                        maxAspect={maxAspect}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div
            className={`flex-1 min-h-0 overflow-y-auto thin-scroll pr-[3px] ${subCols === 3 ? "grid grid-cols-3 gap-gallery-column-gap content-start" : subCols === 2 ? "grid grid-cols-2 gap-gallery-column-gap content-start" : "flex flex-col gap-gallery-column-gap"}`}
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
