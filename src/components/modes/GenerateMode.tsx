import { Workbench } from "../Workbench";
import { Gallery } from "../Gallery";
import { LogWindow } from "../LogWindow";
import { QueueChecklist } from "../QueueChecklist";
import { ResizeBar } from "../ResizeBar";
import { useLayoutStore } from "../../stores/layoutStore";
import { useTabsStore } from "../../stores/tabsStore";

/**
 * The chain editor and its output: prompt columns, preview, run, gallery, and
 * the job queue + log. This is the app as it stood before modes existed, minus
 * the timeline strip, which now lives on DELIVER.
 */
export function GenerateMode() {
  const activeTabId = useTabsStore((s) => s.activeId);
  const galleryHeight = useLayoutStore((s) => s.panelSizes.galleryHeight);
  const setGalleryHeight = useLayoutStore((s) => s.setGalleryHeight);
  const logHeight = useLayoutStore((s) => s.panelSizes.logHeight);
  const setLogHeight = useLayoutStore((s) => s.setLogHeight);
  const thumbColWidth = useLayoutStore((s) => s.panelSizes.thumbColWidth);
  const setThumbColWidth = useLayoutStore((s) => s.setThumbColWidth);
  const queueWidth = useLayoutStore((s) => s.panelSizes.queueWidth);
  const setQueueWidth = useLayoutStore((s) => s.setQueueWidth);

  return (
    <>
      <Workbench key={`bench-${activeTabId}`} />

      <ResizeBar
        orientation="horizontal"
        value={galleryHeight}
        onChange={setGalleryHeight}
        grow="up"
      />

      <div
        className="shrink-0 flex min-h-0"
        style={{ height: `${galleryHeight}px` }}
      >
        <Gallery key={`gallery-${activeTabId}`} />
      </div>

      <ResizeBar
        orientation="horizontal"
        value={logHeight}
        onChange={setLogHeight}
        grow="up"
      />

      <input
        type="range"
        min={80}
        max={500}
        value={thumbColWidth}
        onChange={(e) => setThumbColWidth(Number(e.target.value))}
        title={`Thumbnail size: ${thumbColWidth}px`}
        className="accent-white w-full shrink-0"
        style={{ height: 4, padding: 0, margin: 0, cursor: "ew-resize" }}
      />

      <div
        className="shrink-0 flex flex-row min-h-0"
        style={{ height: `${logHeight}px` }}
      >
        <QueueChecklist
          key={`queue-${activeTabId}`}
          height={logHeight}
          className="shrink-0"
          style={{ width: `${queueWidth}px` }}
        />
        <ResizeBar
          orientation="vertical"
          value={queueWidth}
          onChange={setQueueWidth}
          grow="right"
        />
        <LogWindow height={logHeight} className="flex-1 min-w-0" />
      </div>
    </>
  );
}
