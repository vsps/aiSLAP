import { DeliverExportBar } from "../DeliverExportBar";
import { Gallery } from "../Gallery";
import { LatestImageColumn } from "../LatestImageColumn";
import { ResizeBar } from "../ResizeBar";
import { TagManager } from "../TagManager";
import { Timeline } from "../Timeline";
import { useLayoutStore } from "../../stores/layoutStore";
import { useTabsStore } from "../../stores/tabsStore";

/**
 * Editing and export. Preview on top, the timeline edit strip beneath it
 * (seeded to a quarter of the window height), and the gallery filling the rest.
 *
 * Every component here is also used on GENERATE. That is safe because modes are
 * mutually exclusive — only one instance of `Gallery` is ever mounted, so its
 * window-level keydown handlers, its drag-commit handlers and the five modals it
 * owns cannot double up.
 */
export function DeliverMode() {
  const activeTabId = useTabsStore((s) => s.activeId);
  const previewHeight = useLayoutStore((s) => s.panelSizes.deliverPreviewHeight);
  const setPreviewHeight = useLayoutStore((s) => s.setDeliverPreviewHeight);
  const editHeight = useLayoutStore((s) => s.panelSizes.deliverEditHeight);
  const setEditHeight = useLayoutStore((s) => s.setDeliverEditHeight);

  return (
    <>
      {/* LatestImageColumn is `flex-1 min-w-0 … shrink`, sized for a row of
          workbench columns. Give it a height-bounded flex row to sit in. */}
      <div
        className="shrink-0 flex flex-row min-h-0"
        style={{ height: `${previewHeight}px` }}
      >
        <LatestImageColumn key={`preview-${activeTabId}`} />
      </div>

      <ResizeBar
        orientation="horizontal"
        value={previewHeight}
        onChange={setPreviewHeight}
        grow="down"
      />

      {/* Timeline sizes itself from `deliverEditHeight`; the bar below drives
          that same value. */}
      <Timeline key={`timeline-${activeTabId}`} />

      <ResizeBar
        orientation="horizontal"
        value={editHeight}
        onChange={setEditHeight}
        grow="down"
      />

      {/* Gallery on the left, tag vocabulary on the right: the filter that
          decides the export set is edited in one pane and read in the other,
          so both need to be visible at once. */}
      <div className="flex-1 flex min-h-0 gap-prompt-surface">
        <div className="flex-1 min-w-0 flex flex-col min-h-0 gap-prompt-surface">
          <Gallery key={`gallery-${activeTabId}`} selectable />
          <DeliverExportBar />
        </div>
        <div className="shrink-0 w-[300px] overflow-y-auto thin-scroll bg-surface border border-border p-2">
          <TagManager />
        </div>
      </div>
    </>
  );
}
