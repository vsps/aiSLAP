import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { performImageAction, type ImageAction } from "../lib/actions";

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
  "---",
  "delete",
];

const LABELS: Record<AvailableAction, string> = {
  add_to_refs: "Use as reference",
  toggle_star: "Promote to visible",
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
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 4;
    const left = Math.min(x, window.innerWidth - r.width - pad);
    const top = Math.min(y, window.innerHeight - r.height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("contextmenu", down);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("contextmenu", down);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

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
