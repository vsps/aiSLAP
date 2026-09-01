import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTagsStore } from "../stores/tagsStore";
import { useVisibleTaggedGroups } from "../lib/galleryFilter";
import { editTagsAt, selectImagePath } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
  /** DELIVER mode: show a tick box on every tile. */
  selectable?: boolean;
  excludedSet?: Set<string>;
  onToggleExcluded?: (path: string) => void;
};

export function TagView({
  onDragStart,
  selectable,
  excludedSet,
  onToggleExcluded,
}: Props) {
  const taggedGroups = useSessionStore((s) => s.taggedGroups);
  const taggedLoading = useSessionStore((s) => s.taggedLoading);
  const projectPath = useSessionStore((s) => s.projectPath);
  const rescanTagged = useSessionStore((s) => s.rescanTagged);
  const activeFilter = useTagsStore((s) => s.activeFilter);
  const filterMode = useTagsStore((s) => s.filterMode);
  const activeUserFilter = useTagsStore((s) => s.activeUserFilter);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);

  useEffect(() => {
    if (projectPath) void rescanTagged();
  }, [projectPath, rescanTagged]);

  // The tag filter drives the server query above; the user filter narrows
  // client-side on top of it. Shared with DELIVER's export bar.
  const visibleGroups = useVisibleTaggedGroups(taggedGroups);

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

  if (visibleGroups.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        {activeUserFilter
          ? `Nothing tagged by "${activeUserFilter}".`
          : activeFilter.length > 0
            ? `Nothing tagged ${activeFilter.join(filterMode === "all" ? " + " : " / ")}.`
            : "Nothing tagged in this project yet."}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll bg-surface">
      <div className="flex flex-col gap-gallery-column-gap p-gallery-column">
        {visibleGroups.map((seq) => (
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
                          checkable={selectable}
                          checked={selectable && !excludedSet?.has(img.path)}
                          onToggleChecked={onToggleExcluded}
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
