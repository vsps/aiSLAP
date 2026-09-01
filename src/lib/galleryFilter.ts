import { useMemo } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { matchesFilter, tagsEqual, useTagsStore } from "../stores/tagsStore";
import type {
  GalleryColumn as GalleryColumnData,
  SeqTaggedGroup,
} from "./types";

/**
 * What the gallery is actually showing, derived once and shared.
 *
 * The columns view filters client-side; the tag view sends the tag filter to
 * `project_tag_scan` and narrows the result by user client-side. DELIVER's
 * export bar has to agree with whichever surface is on screen exactly — "export
 * what's listed" is a promise about the pixels — so the two derivations live
 * here rather than inside the components that render them.
 *
 * Note the empty-filter asymmetry between the two surfaces, which is
 * deliberate and predates this module: with no tags selected the columns view
 * lists *everything*, while `project_tag_scan` returns only media that carries
 * at least one tag. `useVisiblePaths` reports whichever the active view is
 * showing, so the export set follows the screen rather than papering over it.
 */

/** The loaded columns narrowed to the active tag + user filter. Keyboard nav
 *  walks this too, so arrows can't land on a thumbnail the filter has hidden. */
export function useFilteredColumns(
  columns: GalleryColumnData[],
): GalleryColumnData[] {
  const activeFilter = useTagsStore((s) => s.activeFilter);
  const filterMode = useTagsStore((s) => s.filterMode);
  const activeUserFilter = useTagsStore((s) => s.activeUserFilter);

  return useMemo(
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
}

/** The server-filtered tagged groups, narrowed by the user filter and with
 *  emptied shots/sequences dropped so no bare headers are left behind. */
export function useVisibleTaggedGroups(
  taggedGroups: SeqTaggedGroup[],
): SeqTaggedGroup[] {
  const activeUserFilter = useTagsStore((s) => s.activeUserFilter);

  return useMemo(() => {
    if (!activeUserFilter) return taggedGroups;
    return taggedGroups
      .map((seq) => ({
        ...seq,
        shots: seq.shots
          .map((sh) => ({
            ...sh,
            images: sh.images.filter(
              (i) => i.generatedBy && tagsEqual(i.generatedBy, activeUserFilter),
            ),
          }))
          .filter((sh) => sh.images.length > 0),
      }))
      .filter((seq) => seq.shots.length > 0);
  }, [taggedGroups, activeUserFilter]);
}

/**
 * Absolute paths of the media on screen right now, in display order.
 *
 * Pending placeholders are excluded: they are skeleton tiles for in-flight
 * generations with no file on disk behind them, so they can be listed but never
 * exported. Stacked view returns nothing — it draws one tile per *stack* rather
 * than per image and applies no tag filter, so there is no "listed set" for it
 * to mean. Trace view likewise: it is an ancestry graph, not a list.
 */
export function useVisiblePaths(): string[] {
  const viewMode = useSessionStore((s) => s.viewMode);
  const traceActive = useSessionStore((s) => s.traceActive);
  const columns = useSessionStore((s) => s.columns);
  const taggedGroups = useSessionStore((s) => s.taggedGroups);

  const filtered = useFilteredColumns(columns);
  const visibleGroups = useVisibleTaggedGroups(taggedGroups);

  return useMemo(() => {
    if (traceActive) return [];
    if (viewMode === "tagged") {
      return visibleGroups.flatMap((seq) =>
        seq.shots.flatMap((sh) =>
          sh.images.filter((i) => !i.pending).map((i) => i.path),
        ),
      );
    }
    if (viewMode === "stacked") return [];
    return filtered.flatMap((c) =>
      c.images.filter((i) => !i.pending).map((i) => i.path),
    );
  }, [traceActive, viewMode, visibleGroups, filtered]);
}

/** Paths that would be exported: everything visible the user hasn't un-ticked. */
export function useExportPaths(): string[] {
  const visible = useVisiblePaths();
  const excluded = useSessionStore((s) => s.deliverExcluded);

  return useMemo(() => {
    if (excluded.length === 0) return visible;
    const drop = new Set(excluded);
    return visible.filter((p) => !drop.has(p));
  }, [visible, excluded]);
}
