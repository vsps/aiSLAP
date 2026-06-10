import { usePresetsStore } from "../stores/presetsStore";
import { IconBtn } from "./IconBtn";
import { ModalDialog } from "./ModalDialog";

type Props = {
  onClose: () => void;
};

export function ChainPresetLoadModal({ onClose }: Props) {
  const { presets, delete: deletePreset, applyPreset } = usePresetsStore();

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  }

  return (
    <ModalDialog
      title="Load chain preset"
      onClose={onClose}
      panelClassName="w-[420px] max-h-[70vh] gap-2"
    >
        {presets.length === 0 ? (
          <div className="text-xs opacity-50 py-4 text-center">No presets saved yet</div>
        ) : (
          <div className="overflow-y-auto thin-scroll flex flex-col gap-1 flex-1 min-h-0">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30 group"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono truncate">{preset.name}</div>
                  <div className="text-[10px] opacity-50">
                    {preset.links.length} link{preset.links.length !== 1 ? "s" : ""} · {fmtDate(preset.createdAt)}
                  </div>
                </div>
                <IconBtn
                  name="play_arrow"
                  size={18}
                  title="Load preset"
                  onClick={() => {
                    applyPreset(preset);
                    onClose();
                  }}
                />
                <IconBtn
                  name="delete"
                  size={18}
                  title="Delete preset"
                  onClick={async () => {
                    await deletePreset(preset.id);
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-1">
          <button
            type="button"
            className="px-2 py-[2px] text-sm hover:bg-accent"
            onClick={onClose}
          >
            Close
          </button>
        </div>
    </ModalDialog>
  );
}
