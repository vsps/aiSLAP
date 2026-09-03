import { ModelPicker } from "./ModelPicker";
import { SettingsPanel } from "./SettingsPanel";
import { CollapsedColumnBar } from "./CollapsedColumnBar";
import { useLayoutStore } from "../stores/layoutStore";

const TITLE = "MODEL SETTINGS";

export function ModelSettingsColumn() {
  const collapsed = useLayoutStore((s) => s.collapsed.modelSettings);
  const toggleCollapsed = useLayoutStore((s) => s.toggleCollapsed);

  if (collapsed) {
    return (
      <CollapsedColumnBar
        title={TITLE}
        onClick={() => toggleCollapsed("modelSettings")}
      />
    );
  }

  return (
    <div className="bg-surface border border-border p-prompt-column text-text w-[300px] flex flex-col gap-prompt-column-gap shrink-0">
      <div
        className="text-sm font-semibold cursor-pointer select-none"
        title="Click to collapse"
        onClick={() => toggleCollapsed("modelSettings")}
      >
        {TITLE}
      </div>
      <div className="bg-inset p-prompt-panel">
        <ModelPicker />
      </div>
      <SettingsPanel className="flex-1 min-h-0 bg-inset p-prompt-panel" />
    </div>
  );
}
