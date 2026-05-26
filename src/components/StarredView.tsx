import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { performImageAction, type ImageAction } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

export function StarredView({ onDragStart }: Props) {
  const { starredGroups, starredLoading, projectPath, rescanStarred, selectedImagePath } =
    useSessionStore();

  useEffect(() => {
    if (projectPath) void rescanStarred();
  }, [projectPath, rescanStarred]);

  const onAction = (action: ImageAction, path: string) => performImageAction(action, path);

  if (!projectPath) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Open a project to see visible images.
      </div>
    );
  }

  if (starredLoading && starredGroups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Loading…
      </div>
    );
  }

  if (starredGroups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        No visible images in this project yet.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll bg-surface">
      <div className="flex flex-col gap-gallery-column-gap p-gallery-column">
        {starredGroups.map((seq) => (
          <div key={seq.seqPath} className="flex flex-col gap-gallery-column-gap">
            <div className="w-full bg-src-bg border border-border px-2 py-1 text-sm font-semibold truncate" title={seq.seqPath}>
              {seq.seqName}
            </div>
            {seq.shots.map((g) => (
              <div key={g.shotPath} className="flex items-stretch gap-gallery-column-gap pl-4">
                <div
                  className="shrink-0 w-[140px] bg-surface border border-border px-2 py-1 text-sm truncate"
                  title={g.shotPath}
                >
                  {g.shotName}
                </div>
                <div className="flex-1 min-w-0 flex flex-wrap gap-gallery-column-gap">
                  {g.images.map((img) => (
                    <div key={img.path} className="w-[120px] shrink-0">
                      <Thumbnail
                        image={img}
                        selected={selectedImagePath === img.path}
                        columnVersion={g.shotName}
                        onSelect={() => onAction("select", img.path)}
                        onToggleStar={() => onAction("toggle_star", img.path)}
                        onDragStart={onDragStart}
                        dragDisabled
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
