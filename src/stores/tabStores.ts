// One tab's worth of session state: the five stores that make a tab a
// self-contained working session, built as a mutually-aware bundle.
//
// The bundle exists so a store's cross-store reaches land on *its own tab's*
// siblings rather than on whatever tab is in front. `sessionStore.setProject`
// resetting the timeline and loading the script is the motivating case: during
// boot restore, or a rename in a background tab, "the active tab" is the wrong
// answer.
//
// Everything not listed here is app-global and stays a plain `create()`
// singleton: the model registry, fal prices, chain presets, the log ring, the
// updater, and layout/panel sizes (one window, one layout).

import type { StoreApi } from "zustand";
import {
  createGenerationStore,
  type GenerationState,
} from "./generationStore";
import { createScriptStore, type ScriptState } from "./scriptStore";
import { createSessionStore, type SessionState } from "./sessionStore";
import { createTagsStore, type TagsState } from "./tagsStore";
import { createTimelineStore, type TimelineState } from "./timelineStore";

export type TabStores = {
  session: StoreApi<SessionState>;
  generation: StoreApi<GenerationState>;
  timeline: StoreApi<TimelineState>;
  script: StoreApi<ScriptState>;
  tags: StoreApi<TagsState>;
};

/**
 * Build a fresh, empty bundle.
 *
 * The two-phase fill is deliberate: `createSessionStore` and `createTagsStore`
 * need a reference to the bundle they live in, and each other. They only ever
 * read their siblings from inside an action — never during construction — so
 * handing them the object before it is fully populated is safe, and it is the
 * only way to close the cycle without a lazy-init flag.
 */
export function createTabStores(): TabStores {
  const tab = {} as TabStores;
  tab.timeline = createTimelineStore();
  tab.script = createScriptStore();
  tab.generation = createGenerationStore();
  tab.session = createSessionStore(tab);
  tab.tags = createTagsStore(tab);
  return tab;
}
