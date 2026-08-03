import { create } from "zustand";
import type { GalleryColumn, TagDef, TagFilterMode } from "../lib/types";
import { cmd } from "../lib/tauri";
import { invalidateImageMetadata } from "../lib/metadataCache";
import { useSessionStore } from "./sessionStore";

type State = {
  /** The open project's vocabulary, in display order (project.json tagDefs). */
  defs: TagDef[];
  /** Tag names currently narrowing the gallery. Empty = no filtering. */
  activeFilter: string[];
  filterMode: TagFilterMode;
};

type Actions = {
  loadDefs: (projectPath: string | null) => Promise<void>;
  setImageTags: (path: string, tags: string[]) => Promise<void>;
  toggleImageTag: (path: string, tag: string) => Promise<void>;
  renameTag: (oldName: string, newName: string) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
  setDefs: (defs: TagDef[]) => Promise<void>;
  setColor: (name: string, color: string) => Promise<void>;
  toggleFilter: (tag: string) => void;
  setFilterMode: (mode: TagFilterMode) => void;
  clearFilter: () => void;
};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Fallback color for a tag an image carries that the vocabulary hasn't
 *  caught up with (a sidecar edited outside the app, say). */
export const UNKNOWN_TAG_COLOR = "var(--color-dim)";

export function tagColor(defs: TagDef[], name: string): string {
  return defs.find((d) => eq(d.name, name))?.color || UNKNOWN_TAG_COLOR;
}

/** Does an image's tag list satisfy the active filter? */
export function matchesFilter(
  tags: string[] | undefined,
  filter: string[],
  mode: TagFilterMode,
): boolean {
  if (filter.length === 0) return true;
  const has = (w: string) => (tags ?? []).some((t) => eq(t, w));
  return mode === "all" ? filter.every(has) : filter.some(has);
}

/** Patch one image's tags into the loaded columns in place. Beats a full
 *  rescanShot (a whole-directory disk walk) for what is a one-field edit —
 *  and keeps the thumbnail from flickering on every tag click. */
function patchColumns(path: string, tags: string[]): void {
  const session = useSessionStore.getState();
  let hit = false;
  const columns: GalleryColumn[] = session.columns.map((col) => {
    if (!col.images.some((i) => i.path === path)) return col;
    hit = true;
    return {
      ...col,
      images: col.images.map((i) => (i.path === path ? { ...i, tags } : i)),
    };
  });
  if (hit) useSessionStore.setState({ columns });
}

export const useTagsStore = create<State & Actions>((set, get) => ({
  defs: [],
  activeFilter: [],
  filterMode: "any",

  async loadDefs(projectPath) {
    if (!projectPath) {
      set({ defs: [], activeFilter: [] });
      return;
    }
    try {
      set({ defs: await cmd.project_tag_defs_get(projectPath) });
    } catch {
      set({ defs: [] });
    }
    // Drop filter entries the new project doesn't know about.
    const names = get().defs;
    set((s) => ({
      activeFilter: s.activeFilter.filter((t) =>
        names.some((d) => eq(d.name, t)),
      ),
    }));
  },

  async setImageTags(path, tags) {
    const applied = await cmd.image_tags_set(path, tags);
    // Tags live in the sidecar now, so anything holding a cached copy of it
    // (hover tooltip, cost totals) has to re-read.
    invalidateImageMetadata(path);
    patchColumns(path, applied);
    const { projectPath, viewMode, rescanTagged } = useSessionStore.getState();
    // A new tag may have been minted server-side — pull the vocabulary back.
    await get().loadDefs(projectPath);
    if (viewMode === "tagged") void rescanTagged();
  },

  async toggleImageTag(path, tag) {
    const session = useSessionStore.getState();
    const current =
      session.columns.flatMap((c) => c.images).find((i) => i.path === path)
        ?.tags ??
      session.taggedGroups
        .flatMap((s) => s.shots)
        .flatMap((s) => s.images)
        .find((i) => i.path === path)?.tags ??
      // Not in any loaded view (zoom modal on an image from elsewhere) —
      // read the sidecar rather than guessing "untagged" and wiping it.
      (await cmd.image_metadata_read(path).catch(() => null))?.tags ??
      [];
    const next = current.some((t) => eq(t, tag))
      ? current.filter((t) => !eq(t, tag))
      : [...current, tag];
    await get().setImageTags(path, next);
  },

  async renameTag(oldName, newName) {
    const { projectPath } = useSessionStore.getState();
    if (!projectPath) return;
    set({ defs: await cmd.project_tag_rename(projectPath, oldName, newName) });
    set((s) => ({
      activeFilter: s.activeFilter.map((t) => (eq(t, oldName) ? newName : t)),
    }));
    await refreshViews();
  },

  async deleteTag(name) {
    const { projectPath } = useSessionStore.getState();
    if (!projectPath) return;
    set({ defs: await cmd.project_tag_delete(projectPath, name) });
    set((s) => ({ activeFilter: s.activeFilter.filter((t) => !eq(t, name)) }));
    await refreshViews();
  },

  async setDefs(defs) {
    const { projectPath } = useSessionStore.getState();
    if (!projectPath) return;
    set({ defs });
    set({ defs: await cmd.project_tag_defs_set(projectPath, defs) });
  },

  async setColor(name, color) {
    await get().setDefs(
      get().defs.map((d) => (eq(d.name, name) ? { ...d, color } : d)),
    );
  },

  toggleFilter(tag) {
    set((s) => ({
      activeFilter: s.activeFilter.some((t) => eq(t, tag))
        ? s.activeFilter.filter((t) => !eq(t, tag))
        : [...s.activeFilter, tag],
    }));
    void afterFilterChange();
  },

  setFilterMode(mode) {
    set({ filterMode: mode });
    void afterFilterChange();
  },

  clearFilter() {
    set({ activeFilter: [] });
    void afterFilterChange();
  },
}));

/** The tag view is server-filtered, so a filter change has to re-query it.
 *  The columns view filters client-side and needs nothing. */
async function afterFilterChange(): Promise<void> {
  const session = useSessionStore.getState();
  if (session.viewMode === "tagged") await session.rescanTagged();
}

/** A vocabulary-wide edit rewrites sidecars across the project — reload
 *  whichever views are showing. */
async function refreshViews(): Promise<void> {
  const session = useSessionStore.getState();
  if (session.shotPath) await session.rescanShot();
  if (session.viewMode === "tagged") await session.rescanTagged();
}
