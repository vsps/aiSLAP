import { ModelPicker } from "./ModelPicker";
import { SettingsPanel } from "./SettingsPanel";

export function ModelSettingsColumn() {
  return (
    <div className="bg-surface border border-border p-prompt-column text-text w-[300px] flex flex-col gap-prompt-column-gap shrink-0">
      <div className="text-sm font-semibold">MODEL SETTINGS</div>
      <div className="bg-inset rounded p-prompt-panel">
        <ModelPicker />
      </div>
      <div className="flex-1 min-h-0 bg-inset rounded p-prompt-panel">
        <SettingsPanel />
      </div>
    </div>
  );
}
