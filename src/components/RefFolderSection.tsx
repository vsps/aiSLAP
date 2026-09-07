import { useCallback, useEffect } from "react";
import type React from "react";
import { cmd } from "../lib/tauri";
import { basename } from "../lib/paths";
import { editTagsAt, type ImageAction } from "../lib/actions";
import { FileRow } from "./FileRow";
import { Thumbnail } from "./Thumbnail";
import { pushLog } from "../stores/logStore";
import { refFolderOpenDefault, useSessionStore } from "../stores/sessionStore";
import type { DragState } from "./GalleryColumn";

type Props = {
  path: string;
  /** Nesting level, for the header indent. */
  depth: number;
  listMode: boolean;
  gridClass: string;
  maxAspect?: number;
  selectedImagePath: string | null;
  columnVersion: string;
  dragState: DragState;
  onImageAction: (action: ImageAction, path: string) => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

/**
 * One subfolder of a reference column, rendered as a collapsible section.
 *
 * A reference column's directory is a *browsing root*, not a bucket: under PRISM
 * it is the pipeline's `04_Resources`, which real projects organise into
 * `clouds/`, `Libraries/`, `Textures/` and so on. Those folders show up here.
 *
 * **A section reads its own contents, and only once opened.** That is the whole
 * design: `04_Resources/Libraries/PolyHaven` can be an enormous texture library
 * on a network share, and scanning it up front — which is what a recursive
 * column scan would do — would stall every shot open in the project. Nesting is
 * this component rendering itself for each subfolder the scan reports back, so
 * the backend never recurses at all.
 *
 * Sections are deliberately **not** drop targets. Both drag hit-testers resolve
 * with `closest("[data-column-version]")`, so stamping that marker here would
 * make a section shadow its own column — and `version` is the React key, the
 * persisted width key and the collapse key besides, none of which wants a
 * per-section value. Drops keep landing in the column's write directory.
 */
export function RefFolderSection({
  path,
  depth,
  listMode,
  gridClass,
  maxAspect,
  selectedImagePath,
  columnVersion,
  dragState,
  onImageAction,
  onDragStart,
}: Props) {
  const open = useSessionStore(
    (s) => s.refFolderOpen[path] ?? refFolderOpenDefault(path),
  );
  const toggle = useSessionStore((s) => s.toggleRefFolder);
  const children = useSessionStore((s) => s.refFolderChildren[path]);
  const setChildren = useSessionStore((s) => s.setRefFolderChildren);
  const columnsNonce = useSessionStore((s) => s.columnsNonce);

  // Watches `columnsNonce` as well as `open`, so a reference copied into this
  // folder shows up: a rescan replaces the column list wholesale, but a
  // section's contents are fetched separately and would otherwise sit stale.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void cmd
      .dir_children_scan(path)
      .then((next) => {
        if (!cancelled) setChildren(path, next);
      })
      .catch((e) => pushLog("ERROR", `Could not read ${path}: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [path, open, columnsNonce, setChildren]);

  const handleSelect = useCallback(
    (p: string) => onImageAction("select", p),
    [onImageAction],
  );

  const images = children?.images ?? [];

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => toggle(path)}
        aria-expanded={open}
        title={path}
        className="flex items-center gap-0.5 h-[20px] px-[3px] text-xs text-dim hover:text-text cursor-pointer shrink-0"
        style={{ paddingLeft: `${3 + depth * 10}px` }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span className="truncate">{basename(path)}</span>
        {open && images.length > 0 && (
          <span className="shrink-0">({images.length})</span>
        )}
      </button>

      {open && (
        <>
          <div className={gridClass}>
            {images.map((img) =>
              listMode ? (
                <FileRow
                  key={img.path}
                  image={img}
                  selected={selectedImagePath === img.path}
                  columnVersion={columnVersion}
                  isDragSource={dragState?.fromPath === img.path}
                  onSelect={handleSelect}
                  onDragStart={onDragStart}
                />
              ) : (
                <Thumbnail
                  key={img.path}
                  image={img}
                  selected={selectedImagePath === img.path}
                  columnVersion={columnVersion}
                  isDragSource={dragState?.fromPath === img.path}
                  onSelect={handleSelect}
                  onEditTags={editTagsAt}
                  onDragStart={onDragStart}
                  maxAspect={maxAspect}
                  // Never tickable: DELIVER exports what `useVisiblePaths`
                  // reports, and that walks the flat column lists only. A tick
                  // box here would promise an export that never happens.
                  checkable={false}
                />
              ),
            )}
          </div>
          {(children?.subdirs ?? []).map((sub) => (
            <RefFolderSection
              key={sub}
              path={sub}
              depth={depth + 1}
              listMode={listMode}
              gridClass={gridClass}
              maxAspect={maxAspect}
              selectedImagePath={selectedImagePath}
              columnVersion={columnVersion}
              dragState={dragState}
              onImageAction={onImageAction}
              onDragStart={onDragStart}
            />
          ))}
        </>
      )}
    </div>
  );
}
