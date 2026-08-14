import { useMemo, useRef } from "react";
import { performImageAction, type ImageAction } from "../lib/actions";
import { usePopupDismiss, useClampedPosition } from "../lib/popup";
import { useSessionStore } from "../stores/sessionStore";

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
  "copy_prompt",
  "copy_settings",
  "restore_chain",
  "trace",
  "show_info",
  "---",
  "zoom",
  "edit",
  "crop",
  "---",
  "copy_path",
  "copy_image",
  "open_location",
  "rename",
  "---",
  "copy_to_global_src",
  "---",
  "edit_tags",
  "set_clip_media",
  "---",
  "delete",
];

const LABELS: Record<AvailableAction, string> = {
  add_to_refs: "ADD REF",
  replace_ref: "Replace ref (clear others)",
  edit_tags: "EDIT TAGS…",
  set_clip_media: "TOGGLE CLIP MEDIA",
  copy_path: "COPY PATH",
  copy_image: "COPY IMAGE",
  copy_to_global_src: "COPY TO GLOBAL SRC",
  copy_prompt: "COPY PROMPT",
  copy_settings: "RESTORE PROMPT",
  restore_chain: "RESTORE CHAIN",
  rename: "RENAME",
  edit: "EDIT",
  crop: "CROP",
  trace: "TRACE ORIGINS",
  zoom: "ZOOM",
  refresh: "Refresh",
  open_location: "OPEN LOCATION",
  delete: "MOVE TO TRASH",
  show_info: "SHOW INFO",
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

  // aiSLAP never removes files inside a PRISM project, so the entry doesn't
  // appear there at all. Filtered here rather than at each of the four call
  // sites, two of which pass their own explicit item lists. Trailing/adjacent
  // separators are dropped with it so the menu doesn't grow a stray rule.
  const prism = useSessionStore((s) => s.prism);
  const visibleItems = useMemo(() => {
    if (!prism) return items;
    const kept = items.filter((a) => a !== "delete");
    return kept.filter(
      (a, i) =>
        a !== "---" ||
        (i > 0 && kept[i - 1] !== "---" && kept.slice(i + 1).some((b) => b !== "---")),
    );
  }, [items, prism]);

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
      {visibleItems.map((a, i) =>
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
