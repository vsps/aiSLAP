import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { GalleryColumn as GalleryColumnData } from "../lib/types";
import type { ImageAction } from "../lib/actions";
import { IconBtn } from "./IconBtn";
import { Thumbnail } from "./Thumbnail";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { basename } from "../lib/paths";
import { classifyMedia } from "../lib/media";
import { cmd } from "../lib/tauri";
import { showMessage } from "../lib/dialog";

export type DragState = {
  fromPath: string;
  fromColumnVersion: string;
  /** Stacked-view source shot path (absolute). Only set in stacked view drags. */
  fromShotPath?: string;
  /** Stacked-view source version name (e.g., "v003"). Only set in stacked view drags. */
  fromVersionName?: string;
  overColumnVersion: string | null;
  shiftHeld: boolean;
  pointerX: number;
  pointerY: number;
} | null;

type Props = {
  column: GalleryColumnData;
  width: number;
  destDir: string;
  dragState: DragState;
  collapsed?: boolean;
  /** When true the column-collapsed state is derived from `targetVersion`,
   *  not the manual toggle. Header clicks should just promote to target. */
  autoCollapse?: boolean;
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
  autoCollapse,
  onToggleCollapsed,
  onFolderDelete,
  onImageAction,
  onRefresh,
  onDragStart,
}: Props) {
  const { targetVersion, setTargetVersion, selectedImagePath, shotPath } =
    useSessionStore();
  const clipMediaPath = useTimelineStore((s) =>
    shotPath ? s.shotsLatestMedia.get(shotPath)?.clipMediaPath ?? null : null,
  );
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);
  const comment = useSessionStore((s) => s.versionComments[column.version] ?? "");
  const setVersionComment = useSessionStore((s) => s.setVersionComment);
  const [editing, setEditing] = useState(false);
  const [osDragTarget, setOsDragTarget] = useState<"src" | "main" | null>(null);
  const [refsCollapsed, setRefsCollapsed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const srcStripRef = useRef<HTMLDivElement>(null);
  const twoCol = !collapsed && width > 220;

  // OS file drag-drop onto any column → copy each file into the column's
  // own folder, then rescan so it appears. SRC uses ref_copy_to_global_src
  // (project-level, overwrite-on-collision); version columns use the
  // generic image_copy_to_dir (error-on-collision so a generated output is
  // never silently replaced by a dropped file). Drops onto the SRC strip
  // of a version column go into the column's SRC/ subfolder.
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
    const ingest = async (paths: string[], toSrc: boolean) => {
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
          } else if (toSrc) {
            const srcDir = `${destDir}/SRC`;
            await cmd.dir_ensure(srcDir);
            await cmd.image_copy_to_dir(p, srcDir);
          } else {
            await cmd.image_copy_to_dir(p, destDir);
          }
          any = true;
        } catch (e) {
          await showMessage(`Failed to add ${basename(p)}: ${e}`, { kind: "error" });
        }
      }
      if (any) await useSessionStore.getState().rescanShot();
    };
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const inside = hitEl(panelRef.current, p.position.x, p.position.y);
          if (inside) {
            const inSrc = hitEl(srcStripRef.current, p.position.x, p.position.y);
            setOsDragTarget(inSrc ? "src" : "main");
          } else {
            setOsDragTarget(null);
          }
        } else if (p.type === "leave") {
          setOsDragTarget(null);
        } else if (p.type === "drop") {
          const inside = hitEl(panelRef.current, p.position.x, p.position.y);
          const inSrc = inside && hitEl(srcStripRef.current, p.position.x, p.position.y);
          setOsDragTarget(null);
          if (inside) await ingest(p.paths, inSrc);
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
    if (autoCollapse) {
      // Auto-collapse: SRC inert; non-target promotes; clicking the active
      // non-SRC column opens the comment editor.
      if (column.isSrc) return;
      if (isTarget) {
        setEditing(true);
        return;
      }
      setTargetVersion(column.version);
      return;
    }
    if (collapsed) {
      onToggleCollapsed();
      return;
    }
    if (column.isSrc) {
      onToggleCollapsed();
      return;
    }
    if (isTarget) {
      // Second click on the active non-SRC column opens the inline comment
      // editor (replaces the prior collapse-on-re-click).
      setEditing(true);
      return;
    }
    setTargetVersion(column.version);
  }

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

  return (
    <div
      ref={panelRef}
      data-column-version={column.version}
      data-column-dest={destDir}
      className={`${column.isSrc ? "bg-src-bg" : "bg-surface"} border ${
        isDropTarget || osDragTarget === "main" ? "outline outline-2 outline-accent border-transparent" : "border-border"
      } p-gallery-column flex flex-col gap-gallery-column-gap shrink-0 h-full min-h-0`}
      style={{ width: `${effectiveWidth}px` }}
    >
      {collapsed ? (
        <div
          className={`flex-1 min-h-0 flex items-center justify-center text-sm cursor-pointer ${headerClass}`}
          onClick={onHeaderClick}
          title={comment ? `${column.version}: ${comment}` : `Expand ${column.version}`}
        >
          <span
            className="font-mono"
            style={{ writingMode: "vertical-rl" }}
          >
            {column.version}{comment ? ` · ${comment}` : ""}
          </span>
        </div>
      ) : (
        <>
          <div
            className={`flex items-center h-[25px] px-[5px] text-sm cursor-pointer shrink-0 ${headerClass}`}
            onClick={onHeaderClick}
          >
            {editing && !column.isSrc ? (
              <VersionCommentInput
                initial={comment}
                onCommit={async (v) => {
                  setEditing(false);
                  try {
                    await setVersionComment(column.version, v);
                  } catch {
                    /* logged in store */
                  }
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <span
                className="flex-1 truncate"
                title={
                  comment ? `${column.version}: ${comment}` : column.version
                }
              >
                {column.version}
                {comment ? `: ${comment}` : ""}
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
                <span className="text-[10px] text-dim/50 font-mono flex-1">refs</span>
                <span className="text-[10px] text-dim/40" style={{ transform: refsCollapsed ? "rotate(-90deg)" : undefined, display: "inline-block" }}>▾</span>
              </div>
              {!refsCollapsed && (
                <div
                  ref={srcStripRef}
                  className={`${osDragTarget === "src" ? "outline outline-2 outline-accent" : ""} ${column.srcImages.length === 0 ? "flex items-center justify-center min-h-[22px]" : "flex flex-wrap gap-[3px] p-[3px]"}`}
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
                        onSelect={() => onImageAction("select", img.path)}
                        onToggleStar={() => onImageAction("toggle_star", img.path)}
                        onDragStart={onDragStart}
                        clipMediaSelected={false}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div className={`flex-1 min-h-0 overflow-y-auto thin-scroll pr-[3px] ${twoCol ? "grid grid-cols-2 gap-gallery-column-gap content-start" : "flex flex-col gap-gallery-column-gap"}`}>
            {column.images.map((img) => (
          <Thumbnail
            key={img.path}
            image={img}
            selected={selectedImagePath === img.path}
            columnVersion={column.version}
            isDragSource={dragState?.fromPath === img.path}
            onSelect={() => onImageAction("select", img.path)}
            onToggleStar={() => onImageAction("toggle_star", img.path)}
            onDragStart={onDragStart}
            clipMediaSelected={img.path === clipMediaPath}
            onToggleClipMedia={
              shotPath && !column.isSrc
                ? () =>
                    void setShotClipMedia(
                      shotPath,
                      img.path === clipMediaPath ? null : img.path,
                    )
                : undefined
            }
          />
        ))}
            {column.images.length === 0 && (
              <div className={`text-xs text-dim text-center py-2${twoCol ? " col-span-2" : ""}`}>
                {column.isSrc ? "No refs" : "Empty"}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Inline editor for a version's short comment. Auto-focuses + selects,
 * commits on Enter and blur (empty value clears), cancels on Escape.
 * Click inside the input does not bubble to the header click handler.
 */
function VersionCommentInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      placeholder="comment…"
      className="flex-1 min-w-0 bg-bg text-text text-sm px-1 py-0 outline-none border border-accent"
      onChange={(e) => setValue(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (committed.current) return;
          committed.current = true;
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (committed.current) return;
        committed.current = true;
        onCommit(value);
      }}
    />
  );
}
