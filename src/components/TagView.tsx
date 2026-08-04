import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTagsStore } from "../stores/tagsStore";
import { editTagsAt, selectImagePath } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

export function TagView({ onDragStart }: Props) {
  const taggedGroups = useSessionStore((s) => s.taggedGroups);
  const taggedLoading = useSessionStore((s) => s.taggedLoading);
  const projectPath = useSessionStore((s) => s.projectPath);
  const rescanTagged = useSessionStore((s) => s.rescanTagged);
  const activeFilter = useTagsStore((s) => s.activeFilter);
  const filterMode = useTagsStore((s) => s.filterMode);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);

  useEffect(() => {
    if (projectPath) void rescanTagged();
  }, [projectPath, rescanTagged]);

  if (!projectPath) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Open a project to see tagged media.
      </div>
    );
  }

  if (taggedLoading && taggedGroups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Loading…
      </div>
    );
  }

  if (taggedGroups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        {activeFilter.length > 0
          ? `Nothing tagged ${activeFilter.join(filterMode === "all" ? " + " : " / ")}.`
          : "Nothing tagged in this project yet."}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll bg-surface">
      <div className="flex flex-col gap-gallery-column-gap p-gallery-column">
        {taggedGroups.map((seq) => (
          <div
            key={seq.seqPath}
            className="flex flex-col gap-gallery-column-gap"
          >
            <div
              className="w-full bg-src-bg border border-border px-2 py-1 text-sm font-semibold truncate"
              title={seq.seqPath}
            >
              {seq.seqName}
            </div>
            {seq.shots.map((g) => {
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
                    {g.images.map((img) => (
                      <div key={img.path} className="w-[120px] shrink-0">
                        <Thumbnail
                          image={img}
                          selected={selectedImagePath === img.path}
                          columnVersion={g.shotName}
                          onSelect={selectImagePath}
                          onEditTags={editTagsAt}
                          onDragStart={onDragStart}
                        />
                      </div>
                    ))}
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
