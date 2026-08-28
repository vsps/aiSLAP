// The tab list itself: which sessions exist, which one is in front.
//
// App-global (there is one tab bar), so this is a plain singleton — it is the
// one store that must NOT be per-tab. It owns the `TabStores` bundles and is
// the only caller of `setActiveTabStores`, which is what makes every proxy in
// `tabScoped.ts` point somewhere.

import { create } from "zustand";
import { createTabStores, type TabStores } from "./tabStores";
import { setActiveTabStores } from "./tabScoped";

export type Tab = {
  id: string;
  stores: TabStores;
};

type State = {
  tabs: Tab[];
  activeId: string;
};

type Actions = {
  /** Open a tab seeded from the active one's project + sequence, with no shot
   *  selected and a fresh chain, then switch to it. Resolves once the seed
   *  navigation has settled (or immediately, if there is nothing to seed). */
  newTab: () => Promise<string>;
  /** Open a tab holding a full copy of the active one's project/sequence/shot
   *  and chain. */
  duplicateTab: () => Promise<string>;
  /** Close a tab. Refuses to close the last one — the app always has a
   *  session. Returns false if it declined. */
  closeTab: (id: string) => boolean;
  setActive: (id: string) => void;
  moveTab: (fromIdx: number, toIdx: number) => void;
  /** Replace the whole list, for the boot restore path. */
  setTabs: (tabs: Tab[], activeId: string) => void;
};

/** A fresh tab with empty stores. Exported for the boot restore path, which
 *  needs to build N of them before handing the whole set over via `setTabs`. */
export function createTab(): Tab {
  return { id: crypto.randomUUID(), stores: createTabStores() };
}

const makeTab = createTab;

const firstTab = makeTab();
setActiveTabStores(firstTab.stores);

export const useTabsStore = create<State & Actions>((set, get) => ({
  tabs: [firstTab],
  activeId: firstTab.id,

  async newTab() {
    const from = activeStores();
    const seed = from.session.getState();
    const projectPath = seed.projectPath;
    const sequencePath = seed.sequencePath;
    const entityType = seed.entityType;
    const prism = !!seed.prism;

    const tab = makeTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    setActiveTabStores(tab.stores);

    if (!projectPath) return tab.id;
    const session = tab.stores.session.getState();
    try {
      // Match the tree first: setProject lists sequences from whichever PRISM
      // tree is active, so setting it afterwards would re-list and clear.
      if (prism) await session.setEntityType(entityType);
      await session.setProject(projectPath);
      if (sequencePath) {
        // No shot: the point of a new tab is to pick a different one, and
        // opening the same shot the other tab holds invites two tabs writing
        // into one version dir before the user has asked for that.
        await tab.stores.session
          .getState()
          .setSequence(sequencePath, { openLastShot: false });
      }
    } catch (e) {
      console.warn("[tabs] seeding new tab failed:", e);
    }
    return tab.id;
  },

  async duplicateTab() {
    const from = activeStores();
    const seed = from.session.getState();
    const {
      projectPath,
      sequencePath,
      shotPath,
      entityType,
      prism,
      collapsedVersions,
    } = seed;
    const chain = from.generation.getState();
    const links = chain.links;
    const expandedIdx = chain.expandedIdx;
    const iterations = chain.iterations;

    const tab = makeTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    setActiveTabStores(tab.stores);

    // Carry the chain across before the (slow, filesystem-bound) navigation so
    // the work surface is already right when the gallery finishes loading.
    // Fresh link ids: the copy is its own chain from here on, and two tabs
    // holding links that claim the same identity is a trap waiting for the
    // first thing that keys on it.
    tab.stores.generation
      .getState()
      .setChain(
        links.map((l) => ({ ...l, id: crypto.randomUUID() })),
        expandedIdx,
      );
    tab.stores.generation.getState().setIterations(iterations);

    if (!projectPath) return tab.id;
    try {
      const session = tab.stores.session.getState();
      if (prism) await session.setEntityType(entityType);
      await session.setProject(projectPath);
      if (sequencePath) {
        await tab.stores.session
          .getState()
          .setSequence(sequencePath, { openLastShot: false });
        if (shotPath) {
          await tab.stores.session.getState().setShot(shotPath);
          // Inherit the collapse set: the duplicate opens the same shot, and
          // expanding everything would re-read exactly the thumbnails the
          // original tab has already folded away.
          tab.stores.session
            .getState()
            .setCollapsedVersions(collapsedVersions);
        }
      }
    } catch (e) {
      console.warn("[tabs] duplicating tab failed:", e);
    }
    return tab.id;
  },

  closeTab(id) {
    const { tabs, activeId } = get();
    if (tabs.length <= 1) return false;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const next = tabs.filter((t) => t.id !== id);
    // Closing the front tab hands focus to its right-hand neighbour, falling
    // back to the left when it was last — the usual editor behaviour.
    const nextActive =
      activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? next[0].id) : activeId;
    set({ tabs: next, activeId: nextActive });
    setActiveTabStores(next.find((t) => t.id === nextActive)?.stores ?? null);
    return true;
  },

  setActive(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || get().activeId === id) return;
    set({ activeId: id });
    setActiveTabStores(tab.stores);
    // Coming to a tab is seeing what arrived in it while you were away.
    tab.stores.generation.getState().markOutputsSeen();
  },

  moveTab(fromIdx, toIdx) {
    set((s) => {
      if (
        fromIdx === toIdx ||
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= s.tabs.length ||
        toIdx >= s.tabs.length
      ) {
        return {};
      }
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      return { tabs };
    });
  },

  setTabs(tabs, activeId) {
    if (tabs.length === 0) return;
    const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
    set({ tabs, activeId: active.id });
    setActiveTabStores(active.stores);
    active.stores.generation.getState().markOutputsSeen();
  },
}));

// ---- Imperative accessors --------------------------------------------------
// For the async paths that must not go through a proxy: a job writing progress
// into the tab that started it, recovery rescanning whichever tabs happen to be
// looking at the shot it just wrote into.

/** The front tab's bundle. */
export function activeStores(): TabStores {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  return tab.stores;
}

/** A specific tab's bundle, or null if it has since been closed. */
export function storesFor(tabId: string): TabStores | null {
  return useTabsStore.getState().tabs.find((t) => t.id === tabId)?.stores ?? null;
}

/** The id of the front tab — stamp this onto work that will outlive a switch. */
export function activeTabId(): string {
  return useTabsStore.getState().activeId;
}

/** Every open tab. Used to fan a filesystem change out to all the tabs
 *  displaying it, rather than only the one in front. */
export function allTabs(): Tab[] {
  return useTabsStore.getState().tabs;
}
