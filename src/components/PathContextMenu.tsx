import { useRef } from "react";
import { performImageAction, type ImageAction } from "../lib/actions";
import { usePopupDismiss, useClampedPosition } from "../lib/popup";

type AvailableAction = Exclude<ImageAction, "select">;
type MenuItem = AvailableAction | "---";

type Props = {
  x: number;
  y: number;
  path: string;
  onClose: () => void;
  // Which items to show, in order. "---" renders a separator. Default: all.
  items?: MenuItem[];
};

const DEFAULT_ITEMS: MenuItem[] = [
  "add_to_refs",
  "copy_settings",
  "restore_chain",
  "---",
  "zoom",
  "edit",
  "crop",
  "trace",
  "---",
  "toggle_star",
  "set_clip_media",
  "---",
  "copy_prompt",
  "copy_path",
  "copy_image",
  "copy_to_global_src",
  "open_location",
  "rename",
  "show_info",
  "---",
  "delete",
];

const LABELS: Record<AvailableAction, string> = {
  add_to_refs: "Use as reference",
  replace_ref: "Replace ref (clear others)",
  toggle_star: "Toggle favorite",
  set_clip_media: "Set as clip media",
  copy_path: "Copy path",
  copy_image: "Copy image",
  copy_to_global_src: "Copy to GLOBAL SRC",
  copy_prompt: "Copy prompt",
  copy_settings: "Reuse prompt",
  restore_chain: "Restore chain",
  rename: "Rename...",
  edit: "Edit (draw)",
  crop: "Crop",
  trace: "Trace origins",
  zoom: "Zoom",
  refresh: "Refresh",
  open_location: "Open Location",
  delete: "Delete",
  show_info: "Show info",
};

// Right-click menu for any gallery/preview image. Covers the full image-op
// surface so keyboard-free workflows don't have to hunt for toolbar icons.
export function PathContextMenu({
  x,
  y,
  path,
  onClose,
  items = DEFAULT_ITEMS,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, x, y);
  usePopupDismiss(ref, onClose, { dismissOnContextMenu: true });

  const run = (action: AvailableAction) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
    await performImageAction(action, path);
  };

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-panel text-text border border-dim shadow-xl py-0.5 text-xs w-max min-w-[120px]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((a, i) =>
        a === "---" ? (
          <div key={`sep-${i}`} className="my-0.5 border-t border-dim" />
        ) : (
          <button
            key={a}
            type="button"
            onClick={run(a)}
            title={LABELS[a]}
            className="w-full text-left px-1.5 py-[2px] hover:bg-accent"
          >
            {LABELS[a]}
          </button>
        ),
      )}
    </div>
  );
}
