// Guarded tab close. Policy rather than store mechanics — `tabsStore.closeTab`
// is the unconditional operation; this is the thing the UI calls.
//
// Lives here rather than in `TabBar.tsx` so that file exports only components
// and keeps React Fast Refresh working.

import { confirmAction } from "./dialog";
import { inFlightJobs } from "./jobs";
import { useTabsStore, type Tab } from "../stores/tabsStore";

/**
 * Ask to close a tab, guarding the two ways it loses work: jobs still running,
 * and prompt text nobody has generated with yet. A tab's state lives only in
 * memory until the next app-state write and closing drops it either way, so the
 * guard is on content, not on whether it happens to be persisted.
 */
export async function requestCloseTab(tab: Tab): Promise<void> {
  const running = inFlightJobs(tab.stores.generation.getState().jobs).length;
  if (running > 0) {
    const ok = await confirmAction(
      `${running} job${running > 1 ? "s are" : " is"} still running in this tab. Closing it abandons ${
        running > 1 ? "them" : "it"
      } — files already written stay on disk.\n\nClose anyway?`,
      { title: "Close tab", kind: "warning" },
    );
    if (!ok) return;
  } else if (hasPromptText(tab)) {
    const ok = await confirmAction(
      "This tab has prompt text that hasn't been generated with. Closing it discards the chain.\n\nClose anyway?",
      { title: "Close tab", kind: "warning" },
    );
    if (!ok) return;
  }
  useTabsStore.getState().closeTab(tab.id);
}

function hasPromptText(tab: Tab): boolean {
  return tab.stores.generation
    .getState()
    .links.some(
      (l) =>
        l.sequencePrompt.trim().length > 0 ||
        l.shotPrompts.some((p) => p.trim().length > 0),
    );
}
