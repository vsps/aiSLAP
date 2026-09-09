import { useEffect, useState } from "react";
import { Gallery } from "../Gallery";
import { ResizeBar } from "../ResizeBar";
import { useLayoutStore } from "../../stores/layoutStore";
import { useScriptStore } from "../../stores/scriptStore";
import { useTabsStore } from "../../stores/tabsStore";
import { ScriptPanel } from "../context/ScriptPanel";
import { ShotTreeNav } from "../context/ShotTreeNav";
import { ShotDetailPanel } from "../context/ShotDetailPanel";
import { BriefAnalysisBar } from "../context/BriefAnalysisBar";

/**
 * Script → shot tree → per-shot storyboard/references → this project's
 * gallery, all on one surface. The script buffer lives here (not inside
 * `ScriptPanel`) so brief-analysis, which derives a whole new script, can
 * write into the exact same buffer the editor shows.
 */
export function ContextMode() {
  const activeTabId = useTabsStore((s) => s.activeId);
  const scriptRaw = useScriptStore((s) => s.raw);
  const [script, setScript] = useState(scriptRaw);
  const galleryHeight = useLayoutStore((s) => s.panelSizes.galleryHeight);
  const setGalleryHeight = useLayoutStore((s) => s.setGalleryHeight);

  useEffect(() => {
    setScript(scriptRaw);
  }, [scriptRaw]);

  return (
    <>
      <div className="flex-1 min-h-0 flex gap-2">
        <ScriptPanel script={script} onChange={setScript} />
        <ShotTreeNav script={script} />
        <ShotDetailPanel script={script} />
      </div>

      <BriefAnalysisBar onScriptDerived={setScript} />

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
    </>
  );
}
