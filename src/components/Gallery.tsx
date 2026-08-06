import React, {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GalleryColumn, type DragState } from "./GalleryColumn";
import { ImageInfoModal } from "./ImageInfoModal";
import { ImageZoomModal } from "./ImageZoomModal";
import { LazyBoundary } from "./LazyBoundary";
import { ModelZoomFallback } from "./ModelZoomFallback";
import { RenameImageModal } from "./RenameImageModal";
import { StackedView } from "./StackedView";
import { TagEditorPopup } from "./TagEditorPopup";
import { TagFilterBar } from "./TagFilterBar";
import { TagView } from "./TagView";
import { TraceView } from "./TraceView";
import { Icon } from "../lib/icon";
import { selectImageByPath, useSessionStore } from "../stores/sessionStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useGenerationStore } from "../stores/generationStore";
import { matchesFilter, useTagsStore } from "../stores/tagsStore";
import { addImageToRefs, performImageAction } from "../lib/actions";
import { cmd } from "../lib/tauri";
import { basename } from "../lib/paths";
import { confirmAction, showMessage } from "../lib/dialog";
import { isFilenameExists } from "../lib/errors";
import { fileSrc } from "../lib/assets";
import { syntheticImage } from "../lib/media";
import type {
  GalleryColumn as GalleryColumnData,
  GalleryImage,
} from "../lib/types";

/**
 * The 3D viewer is the *only* importer of three / @react-three/fiber /
 * @react-three/drei in the app, and it opens solely when a user zooms a `.glb`.
 * Statically importing it put the whole three.js stack — the large majority of
 * the bundle — on the startup path for every launch. Loading it on demand keeps
 * it out of the entry chunk.
 *
 * `.then` re-map because ModelZoomModal is a named export, not a default one.
 */
const ModelZoomModal = lazy(() =>
  import("./ModelZoomModal").then((m) => ({ default: m.ModelZoomModal })),
);

export function Gallery() {
  const columns = useSessionStore((s) => s.columns);
  const shotPath = useSessionStore((s) => s.shotPath);
  const pendingOutputs = useGenerationStore((s) => s.pendingOutputs);
  const activeFilter = useTagsStore((s) => s.activeFilter);
  const filterMode = useTagsStore((s) => s.filterMode);
  const activeUserFilter = useTagsStore((s) => s.activeUserFilter);

  // What the gallery actually shows: the loaded columns narrowed to the
  // active tag + user filter. Keyboard nav walks this too, so arrows can't
  // land on a thumbnail the filter has hidden.
  const filtered = useMemo<GalleryColumnData[]>(
    () =>
      activeFilter.length === 0 && !activeUserFilter
        ? columns
        : columns.map((c) => ({
            ...c,
            images: c.images.filter((i) =>
              matchesFilter(
                i.tags,
                activeFilter,
                filterMode,
                i.generatedBy,
                activeUserFilter,
              ),
            ),
          })),
    [columns, activeFilter, filterMode, activeUserFilter],
  );

  // Merge pending-output placeholders in so the gallery shows skeleton tiles
  // for in-flight generations without touching the filesystem. Added after
  // filtering — an in-flight tile has no tags yet, and hiding it would read
  // as the generation having failed.
  const columnsWithPlaceholders = useMemo<GalleryColumnData[]>(() => {
    if (Object.keys(pendingOutputs).length === 0) return filtered;
    const result = filtered.map((c) => ({ ...c, images: [...c.images] }));
    for (const [key, count] of Object.entries(pendingOutputs)) {
      const [pShot, pVersion] = key.split("|");
      if (pShot !== shotPath) continue;
      let col = result.find((c) => c.version === pVersion);
      if (!col) {
        // Version dir doesn't exist on disk yet — create a synthetic column.
        col = {
          id: pVersion,
          version: pVersion,
          isSrc: false,
          images: [],
          srcImages: [],
          synthetic: true,
        };
        result.push(col);
      }
      const existing = col.images.filter((i) => i.pending).length;
      const needed = count - existing;
      for (let i = 0; i < needed; i++) {
        const placeholder: GalleryImage = {
          filename: `pending_${i}`,
          path: `pending://${pShot}/${pVersion}/${i}`,
          metadataPath: "",
          isVideo: false,
          pending: true,
        };
        col.images.push(placeholder);
      }
    }
    return result;
  }, [filtered, pendingOutputs, shotPath]);

  const traceActive = useSessionStore((s) => s.traceActive);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const thumbColWidth = useLayoutStore((s) => s.panelSizes.thumbColWidth);
  const zoomImagePath = useSessionStore((s) => s.zoomImagePath);
  const setZoomImage = useSessionStore((s) => s.setZoomImage);
  const renameImagePath = useSessionStore((s) => s.renameImagePath);
  const setRenameImage = useSessionStore((s) => s.setRenameImage);
  const infoImagePath = useSessionStore((s) => s.infoImagePath);
  const setInfoImage = useSessionStore((s) => s.setInfoImage);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const viewMode = useSessionStore((s) => s.viewMode);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const setImageDrag = useSessionStore((s) => s.setImageDrag);
  const setCompareSlot = useSessionStore((s) => s.setCompareSlot);
  const setSelectedImage = useSessionStore((s) => s.setSelectedImage);
  const rescanShot = useSessionStore((s) => s.rescanShot);
  const rescanSequenceStacks = useSessionStore((s) => s.rescanSequenceStacks);
  const createNextVersion = useSessionStore((s) => s.createNextVersion);
  const thumbnailsEnabled = useSessionStore((s) => s.thumbnailsEnabled);
  const enableThumbnails = useSessionStore((s) => s.enableThumbnails);

  // Two optional lookups, previously paid for by flattening every column's
  // images on every render — including every render a drag produced.
  const imageByPath = useSessionStore(selectImageByPath);
  const zoomImage = zoomImagePath
    ? (imageByPath.get(zoomImagePath) ?? syntheticImage(zoomImagePath))
    : null;
  const renameImage = renameImagePath
    ? (imageByPath.get(renameImagePath) ?? syntheticImage(renameImagePath))
    : null;

  // Stable reference — performImageAction is module-level, so memo'd
  // Thumbnails downstream keep referentially-equal callbacks.
  const onImageAction = performImageAction;

  const [dragState, setDragState] = useState<DragState>(null);
  // Raw pointer position during a drag lives outside React state — the ghost
  // element mutates its own style directly so per-pixel pointermove doesn't
  // re-render every column (only overColumnVersion/modifier changes do).
  const pointerRef = useRef({ x: 0, y: 0 });
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const setGhostPos = useCallback((x: number, y: number) => {
    pointerRef.current = { x, y };
    const el = ghostRef.current;
    if (el) {
      el.style.left = `${x + 12}px`;
      el.style.top = `${y + 12}px`;
    }
  }, []);

  // Per-column collapse state. Ephemeral — reset whenever the shot changes.
  const [collapsedVersions, setCollapsedVersions] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setCollapsedVersions(new Set());
  }, [shotPath]);
  const toggleCollapsed = (version: string) => {
    setCollapsedVersions((s) => {
      const next = new Set(s);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };
  // Toolbar bulk toggle: collapse every column, or clear all individual
  // collapse state back to fully expanded.
  const allCollapsed =
    columns.length > 0 &&
    columns.every((c) => collapsedVersions.has(c.version));
  const toggleAllCollapsed = () => {
    setCollapsedVersions(
      allCollapsed ? new Set() : new Set(columns.map((c) => c.version)),
    );
  };

  const destDirFor = useCallback(
    (col: { isSrc: boolean; id: string; version: string }): string => {
      // SRC columns store full path in `id`; version columns store the bare name.
      if (col.isSrc) return col.id;
      return shotPath ? `${shotPath}/${col.version}` : col.id;
    },
    [shotPath],
  );

  const onDragStart = useCallback(
    (payload: {
      fromPath: string;
      fromColumnVersion: string;
      fromShotPath?: string;
      fromVersionName?: string;
      pointerEvent: React.PointerEvent;
    }) => {
      setGhostPos(payload.pointerEvent.clientX, payload.pointerEvent.clientY);
      setDragState({
        fromPath: payload.fromPath,
        fromColumnVersion: payload.fromColumnVersion,
        fromShotPath: payload.fromShotPath,
        fromVersionName: payload.fromVersionName,
        overColumnVersion: null,
        shiftHeld: payload.pointerEvent.shiftKey,
        ctrlHeld: payload.pointerEvent.ctrlKey || payload.pointerEvent.metaKey,
      });
      setImageDrag({ fromPath: payload.fromPath });
    },
    [setImageDrag, setGhostPos],
  );

  // Global drag handlers — installed only while dragging.
  useEffect(() => {
    if (!dragState) return;
    const prevCursor = document.body.style.cursor;

    function findColumnAt(
      x: number,
      y: number,
    ): {
      version: string;
      destDir: string;
    } | null {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const col = (el as HTMLElement).closest<HTMLElement>(
        "[data-column-version]",
      );
      if (!col) return null;
      const version = col.dataset.columnVersion ?? "";
      const destDir = col.dataset.columnDest ?? "";
      if (!version || !destDir) return null;
      return { version, destDir };
    }

    function isOverRefPanel(x: number, y: number): boolean {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      return !!(el as HTMLElement).closest("[data-ref-drop]");
    }

    function findCompareSlotAt(x: number, y: number): "a" | "b" | null {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const slot = (el as HTMLElement).closest<HTMLElement>(
        "[data-compare-drop]",
      );
      const drop = slot?.dataset.compareDrop;
      return drop === "a" || drop === "b" ? drop : null;
    }

    function findStackedTargetAt(
      x: number,
      y: number,
    ):
      | { kind: "cell"; shotPath: string; version: string }
      | { kind: "row"; shotPath: string }
      | { kind: "global"; destDir: string }
      | null {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const cell = (el as HTMLElement).closest<HTMLElement>(
        "[data-version-cell-shot][data-version-cell-version]",
      );
      if (cell) {
        const shot = cell.dataset.versionCellShot ?? "";
        const version = cell.dataset.versionCellVersion ?? "";
        if (shot && version) return { kind: "cell", shotPath: shot, version };
      }
      const row = (el as HTMLElement).closest<HTMLElement>("[data-shot-row]");
      if (row) {
        const shot = row.dataset.shotRow ?? "";
        if (shot) return { kind: "row", shotPath: shot };
      }
      const globalSrc = (el as HTMLElement).closest<HTMLElement>(
        "[data-stacked-global-src]",
      );
      if (globalSrc) {
        const destDir = globalSrc.dataset.stackedGlobalSrc ?? "";
        if (destDir) return { kind: "global", destDir };
      }
      return null;
    }

    // Returning `prev` unchanged is what makes the comment above `pointerRef`
    // true. Pointer *position* was already kept out of state, but rebuilding
    // the drag state object on every sample re-introduced the exact problem:
    // a fresh object is never referentially equal, so React re-rendered
    // Gallery and every GalleryColumn at pointer-sample rate (>120Hz) even
    // while nothing the columns actually read had changed.
    const setDragFlags = (
      overColumnVersion: string | null,
      shiftHeld: boolean,
      ctrlHeld: boolean,
    ) =>
      setDragState((prev) => {
        if (!prev) return prev;
        if (
          prev.overColumnVersion === overColumnVersion &&
          prev.shiftHeld === shiftHeld &&
          prev.ctrlHeld === ctrlHeld
        ) {
          return prev;
        }
        return { ...prev, overColumnVersion, shiftHeld, ctrlHeld };
      });

    const onMove = (e: PointerEvent) => {
      setGhostPos(e.clientX, e.clientY);
      const hit = findColumnAt(e.clientX, e.clientY);
      setDragFlags(
        hit?.version ?? null,
        e.shiftKey,
        e.ctrlKey || e.metaKey,
      );
    };

    // Held modifiers auto-repeat, so keydown fires continuously — the same
    // bail matters here, not just on pointermove.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDragState(null);
        setImageDrag(null);
        return;
      }
      if (e.key === "Shift" || e.key === "Control" || e.key === "Meta") {
        setDragState((prev) => {
          if (!prev) return prev;
          const shiftHeld = prev.shiftHeld || e.key === "Shift";
          const ctrlHeld =
            prev.ctrlHeld || e.key === "Control" || e.key === "Meta";
          if (prev.shiftHeld === shiftHeld && prev.ctrlHeld === ctrlHeld) {
            return prev;
          }
          return { ...prev, shiftHeld, ctrlHeld };
        });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Meta") {
        setDragState((prev) => {
          if (!prev) return prev;
          const shiftHeld = e.key === "Shift" ? false : prev.shiftHeld;
          const ctrlHeld =
            e.key === "Control" || e.key === "Meta" ? false : prev.ctrlHeld;
          if (prev.shiftHeld === shiftHeld && prev.ctrlHeld === ctrlHeld) {
            return prev;
          }
          return { ...prev, shiftHeld, ctrlHeld };
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      const current = dragState;
      const hitRef = isOverRefPanel(e.clientX, e.clientY);
      const hitCompareSlot = findCompareSlotAt(e.clientX, e.clientY);
      // Stacked-style targets are picked up from any view that stamps the
      // markers — stacked view stamps both cell+row; favorite/trace stamp
      // row only. Columns view stamps neither, so this stays null there.
      const hitStacked = findStackedTargetAt(e.clientX, e.clientY);
      const hitCol = !hitStacked ? findColumnAt(e.clientX, e.clientY) : null;
      setDragState(null);
      setImageDrag(null);
      if (!current) return;
      if (hitRef) {
        void commitRefDrop(current.fromPath);
        return;
      }
      if (hitCompareSlot) {
        setCompareSlot(hitCompareSlot, current.fromPath);
        return;
      }
      if (hitStacked) {
        if (hitStacked.kind === "global") {
          if (current.fromColumnVersion !== "GLOBAL SRC") {
            void commitGlobalSrcDrop(
              current.fromPath,
              hitStacked.destDir,
              e.shiftKey,
            );
          }
        } else {
          void commitStackedDrop(
            current,
            hitStacked,
            e.shiftKey,
            e.ctrlKey || e.metaKey,
          );
        }
        return;
      }
      if (!hitCol) return;
      if (hitCol.version === current.fromColumnVersion) return;
      const copy = e.shiftKey;
      void commitDrop(current.fromPath, hitCol.destDir, copy);
    };

    const onCancel = () => {
      setDragState(null);
      setImageDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.body.style.cursor = prevCursor;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState != null]);

  // Update body cursor live as shift state changes.
  useEffect(() => {
    if (!dragState) return;
    document.body.style.cursor = dragState.shiftHeld ? "copy" : "grabbing";
  }, [dragState?.shiftHeld, dragState != null]);

  async function commitDrop(fromPath: string, destDir: string, copy: boolean) {
    try {
      const fn = copy ? cmd.image_copy_to_dir : cmd.image_move_to_dir;
      const newPath = await fn(fromPath, destDir);
      await rescanShot();
      setSelectedImage(newPath);
    } catch (e) {
      if (isFilenameExists(e)) {
        await showMessage(
          `Skipped: ${basename(fromPath)} already exists at destination`,
          { kind: "warning" },
        );
      } else {
        await showMessage(String(e), { kind: "error" });
      }
    }
  }

  async function commitRefDrop(fromPath: string) {
    try {
      await addImageToRefs(fromPath);
      await rescanShot();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function commitGlobalSrcDrop(
    fromPath: string,
    destDir: string,
    copy: boolean,
  ) {
    try {
      const fn = copy ? cmd.image_copy_to_dir : cmd.image_move_to_dir;
      await fn(fromPath, destDir);
      await rescanSequenceStacks();
      await rescanShot();
    } catch (e) {
      if (isFilenameExists(e)) {
        await showMessage(
          `Skipped: ${basename(fromPath)} already exists at destination`,
          { kind: "warning" },
        );
      } else {
        await showMessage(String(e), { kind: "error" });
      }
    }
  }

  async function commitStackedDrop(
    current: NonNullable<DragState>,
    target:
      | { kind: "cell"; shotPath: string; version: string }
      | { kind: "row"; shotPath: string },
    shift: boolean,
    ctrl: boolean,
  ) {
    const fromShot = current.fromShotPath;
    const fromVersion = current.fromVersionName;
    // Stacked-view drag/drop modifiers:
    //   drag             move the single (dragged/selected) image
    //   shift+drag       copy the single image
    //   ctrl+drag        move the whole stack
    //   shift+ctrl+drag  copy the whole stack
    // Whole-stack semantics only apply when the source knows its version slot
    // (i.e. it came from a stacked-view drag) — favorite/trace sources are
    // single images, so ctrl has no special meaning there.
    const copy = shift;
    const stackWhole = ctrl && !!fromShot && !!fromVersion;

    const sameCell =
      target.kind === "cell" &&
      target.shotPath === fromShot &&
      target.version === fromVersion;
    if (sameCell) return;

    try {
      if (stackWhole) {
        const dstVersion = target.kind === "cell" ? target.version : null;
        await cmd.version_stack_move(
          fromShot!,
          fromVersion!,
          target.shotPath,
          dstVersion,
          copy,
        );
      } else {
        // Single-file move/copy (the current select / dragged thumb).
        let destDir: string;
        if (target.kind === "cell") {
          destDir = `${target.shotPath}/${target.version}`;
        } else {
          // Allocate the next version on the destination shot.
          const next = await cmd.version_create_next(target.shotPath);
          destDir = `${target.shotPath}/${next}`;
        }
        const fn = copy ? cmd.image_copy_to_dir : cmd.image_move_to_dir;
        await fn(current.fromPath, destDir);
      }
      await rescanSequenceStacks();
      await rescanShot();
    } catch (e) {
      if (isFilenameExists(e)) {
        await showMessage(
          `Skipped: ${basename(current.fromPath)} already exists at destination`,
          { kind: "warning" },
        );
      } else {
        await showMessage(String(e), { kind: "error" });
      }
    }
  }

  // Grid keyboard nav. Arrow keys traverse the 2D gallery (columns × images).
  // Left/Right across columns keeping the row index; Up/Down within a column.
  // Skipped while typing in inputs or while the zoom modal owns arrows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight" &&
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown"
      )
        return;
      if (zoomImagePath) return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tgt?.isContentEditable)
        return;
      if (filtered.every((c) => c.images.length === 0)) return;

      e.preventDefault();
      const selected = useSessionStore.getState().selectedImagePath;
      let colIdx = selected
        ? filtered.findIndex((c) => c.images.some((i) => i.path === selected))
        : -1;
      let rowIdx = -1;
      if (colIdx >= 0 && selected) {
        rowIdx = filtered[colIdx].images.findIndex((i) => i.path === selected);
      }

      // No current selection → first image of first non-empty column.
      if (colIdx < 0 || rowIdx < 0) {
        const firstCol = filtered.findIndex((c) => c.images.length > 0);
        if (firstCol < 0) return;
        setSelectedImage(filtered[firstCol].images[0].path);
        return;
      }

      if (e.key === "ArrowUp") {
        if (rowIdx > 0) rowIdx -= 1;
      } else if (e.key === "ArrowDown") {
        if (rowIdx < filtered[colIdx].images.length - 1) rowIdx += 1;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        // Walk to the next non-empty column in the chosen direction.
        let nc = colIdx + dir;
        while (
          nc >= 0 &&
          nc < filtered.length &&
          filtered[nc].images.length === 0
        )
          nc += dir;
        if (nc < 0 || nc >= filtered.length) return;
        colIdx = nc;
        rowIdx = Math.min(rowIdx, filtered[colIdx].images.length - 1);
      }

      const next = filtered[colIdx].images[rowIdx];
      if (next) setSelectedImage(next.path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, zoomImagePath, setSelectedImage]);

  async function onFolderDelete(version: string) {
    const col = columns.find((c) => c.version === version);
    if (!col || col.isSrc) return;
    if (!shotPath) return;
    const ok = await confirmAction(
      `Delete version folder ${version} and all its images?`,
      {
        title: "Delete column",
        kind: "warning",
      },
    );
    if (!ok) return;
    try {
      await cmd.column_delete(`${shotPath}/${version}`);
      await rescanShot();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function onAddNewVersion() {
    try {
      await createNextVersion();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  const splitButtons = (
    <div className="flex flex-col shrink-0 self-stretch overflow-hidden">
      {viewMode === "columns" && shotPath && (
        <button
          className="accent-hover px-3 py-2 flex items-center justify-center"
          title="Add new version"
          onClick={onAddNewVersion}
        >
          <Icon name="add" size={22} />
        </button>
      )}
      {sequencePath && (
        <button
          className={`${
            viewMode === "tagged" ? "bg-accent" : "accent-hover"
          } px-3 py-2 flex items-center justify-center`}
          title={viewMode === "tagged" ? "Back to versions" : "Tagged media"}
          onClick={() =>
            setViewMode(viewMode === "tagged" ? "columns" : "tagged")
          }
        >
          <Icon name="sell" size={22} fill={viewMode === "tagged"} />
        </button>
      )}
      {sequencePath && (
        <button
          className={`${
            viewMode === "stacked" ? "bg-accent" : "accent-hover"
          } px-3 py-2 flex items-center justify-center`}
          title={viewMode === "stacked" ? "Back to versions" : "Stacked view"}
          onClick={() =>
            setViewMode(viewMode === "stacked" ? "columns" : "stacked")
          }
        >
          <Icon name="view_module" size={22} fill={viewMode === "stacked"} />
        </button>
      )}
      {viewMode === "columns" && shotPath && (
        <button
          className={`${allCollapsed ? "bg-accent" : "accent-hover"} px-3 py-2 flex items-center justify-center`}
          title={allCollapsed ? "Expand all columns" : "Collapse all columns"}
          onClick={toggleAllCollapsed}
        >
          <Icon
            name="unfold_less"
            size={22}
            fill={allCollapsed}
            className="rotate-90"
          />
        </button>
      )}
      {selectedImagePath && (
        <button
          className={`${traceActive ? "bg-accent" : "accent-hover"} px-3 py-2 flex items-center justify-center`}
          title={traceActive ? "Exit trace" : "Trace origins"}
          onClick={() => onImageAction("trace", selectedImagePath)}
        >
          <Icon name="conversion_path" size={22} fill={!!traceActive} />
        </button>
      )}
      {selectedImagePath && (
        <button
          className="accent-hover px-3 py-2 flex items-center justify-center"
          title="Delete selected"
          onClick={() => onImageAction("delete", selectedImagePath)}
        >
          <Icon name="delete" size={22} />
        </button>
      )}
      {shotPath && (
        <button
          className="accent-hover px-3 py-2 flex items-center justify-center"
          title="Rescan shot from disk"
          onClick={() => void rescanShot()}
        >
          <Icon name="refresh" size={22} />
        </button>
      )}
    </div>
  );

  // Nothing reads from disk until the user opts in — avoids flooding a
  // slow/network project dir with thumbnail reads the moment the app starts.
  if (!thumbnailsEnabled) {
    return (
      <div
        className="flex flex-1 min-h-0 min-w-0 items-center justify-center bg-gallery-surface text-dim text-sm cursor-pointer select-none hover:text-text transition-colors"
        onClick={enableThumbnails}
        title="Load thumbnails"
      >
        Click to load thumbnails
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-gallery-surface">
      {!traceActive && <TagFilterBar />}
      <div className="flex flex-1 min-h-0 min-w-0 gap-gallery-surface">
        {traceActive ? (
          <>
            {splitButtons}
            <TraceView onDragStart={onDragStart} />
          </>
        ) : viewMode === "tagged" ? (
          <>
            {splitButtons}
            <TagView onDragStart={onDragStart} />
          </>
        ) : viewMode === "stacked" ? (
          <>
            {splitButtons}
            <StackedView onDragStart={onDragStart} />
          </>
        ) : (
          <>
            {splitButtons}
            <div className="flex flex-1 min-w-0 overflow-x-auto overflow-y-hidden thin-scroll min-h-0">
              {columnsWithPlaceholders.length === 0 ? (
                <div className="text-sm text-dim p-4">
                  Open a shot to see its versions.
                </div>
              ) : (
                <>
                  {columnsWithPlaceholders.map((c) => (
                    <GalleryColumn
                      key={c.version}
                      column={c}
                      width={thumbColWidth}
                      destDir={destDirFor(c)}
                      dragState={dragState}
                      collapsed={collapsedVersions.has(c.version)}
                      onToggleCollapsed={() => toggleCollapsed(c.version)}
                      onFolderDelete={() => onFolderDelete(c.version)}
                      onImageAction={onImageAction}
                      onRefresh={c.isSrc ? () => rescanShot() : undefined}
                      onDragStart={onDragStart}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {dragState &&
        (() => {
          const isStack =
            !!dragState.fromShotPath && !!dragState.fromVersionName;
          const stackWhole = isStack && dragState.ctrlHeld;
          const label = [
            dragState.shiftHeld ? "COPY" : "MOVE",
            stackWhole ? "STACK" : null,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              ref={ghostRef}
              className="fixed pointer-events-none z-50 flex items-center gap-2"
              style={{
                left: pointerRef.current.x + 12,
                top: pointerRef.current.y + 12,
              }}
            >
              <img
                src={fileSrc(dragState.fromPath)}
                alt=""
                draggable={false}
                className="w-16 h-16 object-cover border border-accent shadow-lg bg-bg"
              />
              <span
                className={`text-[10px] font-mono px-1 py-[1px] ${
                  dragState.shiftHeld
                    ? "bg-accent text-text"
                    : "bg-panel text-text"
                }`}
              >
                {label}
              </span>
            </div>
          );
        })()}

      {zoomImage &&
        (zoomImage.isModel3d ? (
          <LazyBoundary
            fallback={
              <ModelZoomFallback
                filename={zoomImage.filename}
                onClose={() => setZoomImage(null)}
              />
            }
            onError={(retry) => (
              <ModelZoomFallback
                filename={zoomImage.filename}
                onClose={() => setZoomImage(null)}
                error="The 3D viewer bundle could not be fetched. Reinstalling the app usually fixes this."
                onRetry={retry}
              />
            )}
          >
            <ModelZoomModal
              image={zoomImage}
              onClose={() => setZoomImage(null)}
              onDelete={async () => onImageAction("delete", zoomImage.path)}
            />
          </LazyBoundary>
        ) : (
          <ImageZoomModal
            image={zoomImage}
            onClose={() => setZoomImage(null)}
            onAddToRefs={async () =>
              onImageAction("add_to_refs", zoomImage.path)
            }
            onCopySettings={async () =>
              onImageAction("copy_settings", zoomImage.path)
            }
            onTrace={async () => onImageAction("trace", zoomImage.path)}
            onDelete={async () => onImageAction("delete", zoomImage.path)}
          />
        ))}

      {renameImage && (
        <RenameImageModal
          image={renameImage}
          onClose={() => setRenameImage(null)}
        />
      )}

      {infoImagePath && (
        <ImageInfoModal
          path={infoImagePath}
          onClose={() => setInfoImage(null)}
        />
      )}

      {/* Last so it paints above the zoom modal, which can also open it. */}
      <TagEditorPopup />
    </div>
  );
}
