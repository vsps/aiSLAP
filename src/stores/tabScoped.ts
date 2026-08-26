// The tab indirection layer.
//
// Every session-scoped store exists once per tab (see `tabStores.ts`), but the
// ~400 call sites that read them were written against module singletons and all
// mean the same thing: "the tab the user is looking at". Rather than thread a
// tab handle through all of them, each store exports a *proxy* built here that
// forwards to the active tab's real instance.
//
// The proxy is a full zustand store API plus the callable hook form, so
// `useSessionStore((s) => s.shotPath)`, `useSessionStore.getState()` and
// `useSessionStore.setState(...)` all keep working unchanged.
//
// `TabStores` is imported for its type only, so there is no runtime cycle:
// `tabStores.ts` imports the store factories, the store modules import this,
// and this imports nothing at runtime.
//
// The one thing this layer cannot do is serve a *background* tab, because it
// only ever points at one bundle. Two consequences, both load-bearing:
//   1. Only the active tab's React tree may be mounted (App keys the panels on
//      the active tab id). A hidden tab's components would read the wrong tab.
//   2. Async work that outlives a tab switch — a running job, orphan recovery —
//      must hold its own bundle captured at start, never reach through here.
//      See `JobSpec.tabId` in `generation/runner.ts`.

import { useStore, type StoreApi, type UseBoundStore } from "zustand";
import type { TabStores } from "./tabStores";

type Listener<T> = (state: T, prev: T) => void;

let current: TabStores | null = null;
const rebinders: (() => void)[] = [];

/**
 * Point every proxy at `next` and wake all subscribers.
 *
 * Called by `tabsStore` on tab switch. Waking is what makes a switch repaint:
 * `useSyncExternalStore` re-reads `getState()` from inside the listener, so the
 * whole subtree renders against the new tab without any component knowing tabs
 * exist. Non-React subscribers are handed `(state, state)`, so a change-gated
 * subscription sees no spurious diff.
 */
export function setActiveTabStores(next: TabStores | null): void {
  if (current === next) return;
  current = next;
  for (const rebind of rebinders) rebind();
}

/** The active bundle, for an imperative caller that needs a sibling store
 *  directly rather than through a proxy. Throws before the first tab exists. */
export function activeTabStores(): TabStores {
  if (!current) throw new Error("tab stores read before any tab existed");
  return current;
}

/**
 * Build the module-singleton facade for one slot. The returned value is
 * interchangeable with what `create()` gives you, so a store module can swap
 * `export const useFooStore = create(...)` for
 * `export const useFooStore = tabScoped((t) => t.foo)` and leave every consumer
 * untouched.
 */
export function tabScoped<T>(
  pick: (t: TabStores) => StoreApi<T>,
): UseBoundStore<StoreApi<T>> {
  const listeners = new Set<Listener<T>>();
  let bound: StoreApi<T> | null = null;
  let unsub: (() => void) | null = null;

  const emit = (state: T, prev: T) => {
    // Copy first: a listener that unsubscribes itself — React does, when a
    // component unmounts during the switch — would otherwise mutate the set
    // mid-iteration.
    for (const l of [...listeners]) l(state, prev);
  };

  const rebind = () => {
    const next = current ? pick(current) : null;
    if (next === bound) return;
    unsub?.();
    unsub = null;
    bound = next;
    if (next) {
      unsub = next.subscribe(emit);
      const state = next.getState();
      emit(state, state);
    }
  };
  rebinders.push(rebind);
  rebind();

  const target = (): StoreApi<T> => {
    if (!bound) throw new Error("tab store read before any tab existed");
    return bound;
  };

  const api: StoreApi<T> = {
    getState: () => target().getState(),
    getInitialState: () => target().getInitialState(),
    setState: (partial, replace) => target().setState(partial, replace as never),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  // Identity default so the no-selector call form keeps working: passing
  // `undefined` straight through to zustand's overloaded `useStore` would not.
  const identity = (s: T) => s as unknown;
  const hook = ((selector: (s: T) => unknown = identity) =>
    useStore(api, selector)) as UseBoundStore<StoreApi<T>>;

  return Object.assign(hook, api);
}
