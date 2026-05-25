import type { GalleryColumn as GalleryColumnData } from "../lib/types";
import type { ImageAction } from "../lib/actions";
import { IconBtn } from "./IconBtn";
import { Thumbnail } from "./Thumbnail";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { basename } from "../lib/paths";

export type DragState = {
  fromPath: string;
  fromColumnVersion: string;
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
  onFolderDelete: () => void;
  onImageAction: (action: ImageAction, imagePath: string) => void;
  onRefresh?: () => void;
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

export function GalleryColumn({
  column,
  width,
  destDir,
  dragState,
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
  const twoCol = width > 220;

  const isTarget = targetVersion === column.version;
  const headerClass = isTarget
    ? "bg-accent text-text"
    : column.isSrc
    ? "bg-surface text-text"
    : "accent-hover text-text";

  const isDropTarget =
    dragState != null &&
    dragState.overColumnVersion === column.version &&
    dragState.fromColumnVersion !== column.version;

  return (
    <div
      data-column-version={column.version}
      data-column-dest={destDir}
      className={`${column.isSrc ? "bg-src-bg" : "bg-surface"} border ${
        isDropTarget ? "outline outline-2 outline-accent border-transparent" : "border-border"
      } p-gallery-column flex flex-col gap-gallery-column-gap shrink-0 h-full min-h-0`}
      style={{ width: `${width}px` }}
    >
      <div
        className={`flex items-center h-[25px] px-[5px] text-sm cursor-pointer shrink-0 ${headerClass}`}
        onClick={() => !column.isSrc && setTargetVersion(column.version)}
      >
        <span className="flex-1 truncate">{column.version}</span>
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
      <div className={`flex-1 min-h-0 overflow-y-auto thin-scroll pr-[3px] ${twoCol ? "grid grid-cols-2 gap-gallery-column-gap content-start" : "flex flex-col gap-gallery-column-gap"}`}>
        {column.images.map((img) => (
          <Thumbnail
            key={img.path}
            image={img}
            selected={selectedImagePath === img.path}
            columnVersion={column.version}
            isDragSource={dragState?.fromPath === img.path}
            onSelect={() => onImageAction("select", img.path)}
            onZoom={() => onImageAction("zoom", img.path)}
            onAddToRefs={() => onImageAction("add_to_refs", img.path)}
            onCopySettings={() => onImageAction("copy_settings", img.path)}
            onEdit={() => onImageAction("edit", img.path)}
            onCrop={() => onImageAction("crop", img.path)}
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
      {/* small footer showing column file path */}
      <div className="text-[10px] text-dim font-mono truncate" title={column.id}>
        {basename(column.id)}
      </div>
    </div>
  );
}
