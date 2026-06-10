import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { selectImagePath, toggleStarPath } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

export function StarredView({ onDragStart }: Props) {
  const starredGroups = useSessionStore((s) => s.starredGroups);
  const starredLoading = useSessionStore((s) => s.starredLoading);
  const projectPath = useSessionStore((s) => s.projectPath);
  const rescanStarred = useSessionStore((s) => s.rescanStarred);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const shotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);

  useEffect(() => {
    if (projectPath) void rescanStarred();
  }, [projectPath, rescanStarred]);

  if (!projectPath) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Open a project to see favorites.
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
        No favorites in this project yet.
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
            {seq.shots.map((g) => {
              const slm = shotsLatestMedia.get(g.shotPath);
              const knownShot = !!slm;
              return (
                <div
                  key={g.shotPath}
                  data-shot-row={g.shotPath}
                  className="flex items-stretch gap-gallery-column-gap pl-4"
                >
                  <div
                    className="shrink-0 w-[140px] bg-surface border border-border px-2 py-1 text-sm truncate"
                    title={g.shotPath}
                  >
                    {g.shotName}
                  </div>
                  <div className="flex-1 min-w-0 flex flex-wrap gap-gallery-column-gap">
                    {g.images.map((img) => {
                      const clipSelected = knownShot && slm?.clipMediaPath === img.path;
                      return (
                        <div key={img.path} className="w-[120px] shrink-0">
                          <Thumbnail
                            image={img}
                            selected={selectedImagePath === img.path}
                            columnVersion={g.shotName}
                            onSelect={selectImagePath}
                            onToggleStar={toggleStarPath}
                            onDragStart={onDragStart}
                            clipMediaSelected={clipSelected}
                            onToggleClipMedia={
                              knownShot
                                ? () =>
                                    void setShotClipMedia(
                                      g.shotPath,
                                      clipSelected ? null : img.path,
                                    )
                                : undefined
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
