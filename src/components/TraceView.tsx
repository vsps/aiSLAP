import { useMemo } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { performImageAction, type ImageAction } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";
import type { GalleryImage } from "../lib/types";
import { basename } from "../lib/paths";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "avi"]);

function makeImage(path: string): GalleryImage {
  const filename = basename(path);
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return {
    filename,
    path,
    metadataPath: "",
    isVideo: VIDEO_EXTS.has(ext),
  };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.substring(0, i) : path;
}

function labelFor(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2
    ? `${parts[parts.length - 2]} / ${parts[parts.length - 1]}`
    : parts[parts.length - 1] ?? dir;
}

export function TraceView({ onDragStart }: Props) {
  const { traceActive, selectedImagePath } = useSessionStore();

  const groups = useMemo(() => {
    if (!traceActive) return [];
    const map = new Map<string, string[]>();
    for (const p of traceActive.traceSet) {
      const dir = dirOf(p);
      if (!map.has(dir)) map.set(dir, []);
      map.get(dir)!.push(p);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, paths]) => ({ dir, label: labelFor(dir), paths: paths.sort() }));
  }, [traceActive]);

  const onAction = (action: ImageAction, path: string) => performImageAction(action, path);

  if (!traceActive || groups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        No traced images.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll bg-surface">
      <div className="flex flex-col gap-gallery-column-gap p-gallery-column">
        {groups.map((g) => (
          <div key={g.dir} className="flex items-stretch gap-gallery-column-gap">
            <div
              className="shrink-0 w-[140px] bg-src-bg border border-border px-2 py-1 text-sm truncate"
              title={g.dir}
            >
              {g.label}
            </div>
            <div className="flex-1 min-w-0 flex flex-wrap gap-gallery-column-gap">
              {g.paths.map((p) => {
                const img = makeImage(p);
                return (
                  <div key={p} className="w-[120px] shrink-0">
                    <Thumbnail
                      image={img}
                      selected={selectedImagePath === p}
                      columnVersion={g.label}
                      onSelect={() => onAction("select", p)}
                      onZoom={() => onAction("zoom", p)}
                      onAddToRefs={() => onAction("add_to_refs", p)}
                      onReplaceRef={() => onAction("replace_ref", p)}
                      onCopySettings={() => onAction("copy_settings", p)}
                      onEdit={() => onAction("edit", p)}
                      onCrop={() => onAction("crop", p)}
                      onToggleStar={() => onAction("toggle_star", p)}
                      onDragStart={onDragStart}
                      dragDisabled
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
