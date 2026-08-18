import { useMemo, useRef } from "react";
import { performImageAction, type ImageAction } from "../lib/actions";
import { usePopupDismiss, useClampedPosition } from "../lib/popup";
import { isVideoPath } from "../lib/media";
import { useSessionStore } from "../stores/sessionStore";

type AvailableAction = Exclude<ImageAction, "select">;
// "-" draws a rule between two runs of items inside one column.
type SectionItem = AvailableAction | "-";
export type MenuSection = { header: string; items: SectionItem[] };

type Props = {
  x: number;
  y: number;
  path: string;
  onClose: () => void;
  // One column per section, in order. Default: everything.
  sections?: MenuSection[];
};

const DEFAULT_SECTIONS: MenuSection[] = [
  {
    header: "PROMPT",
    items: [
      "add_to_refs",
      "copy_prompt",
      "copy_settings",
      "restore_chain",
      "trace",
      "show_info",
    ],
  },
  { header: "IMAGE", items: ["zoom", "edit", "crop", "trim_video"] },
  {
    header: "FILE",
    items: [
      "copy_path",
      "copy_image",
      "open_location",
      "rename",
      "-",
      "delete",
    ],
  },
  { header: "OTHER", items: ["edit_tags", "set_clip_media"] },
];

const LABELS: Record<AvailableAction, string> = {
  add_to_refs: "ADD REF",
  replace_ref: "Replace ref (clear others)",
  edit_tags: "EDIT TAGS…",
  set_clip_media: "TOGGLE CLIP MEDIA",
  copy_path: "COPY PATH",
  copy_image: "COPY IMAGE",
  copy_prompt: "COPY PROMPT",
  copy_settings: "RESTORE PROMPT",
  restore_chain: "RESTORE CHAIN",
  rename: "RENAME",
  edit: "EDIT",
  crop: "CROP",
  trim_video: "TRIM VIDEO",
  trace: "TRACE ORIGINS",
  zoom: "ZOOM",
  refresh: "Refresh",
  open_location: "OPEN LOCATION",
  delete: "MOVE TO TRASH",
  show_info: "SHOW INFO",
};

// Right-click menu for any gallery/preview image. Covers the full image-op
// surface so keyboard-free workflows don't have to hunt for toolbar icons.
// Laid out horizontally: each section is a headed column, so the whole surface
// is one short wide block instead of a long scrolling list.
export function PathContextMenu({
  x,
  y,
  path,
  onClose,
  sections = DEFAULT_SECTIONS,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, x, y);
  usePopupDismiss(ref, onClose, { dismissOnContextMenu: true });

  // Entries that don't apply to this file are dropped here rather than at each
  // of the four call sites, one of which passes its own explicit sections.
  // aiSLAP never removes files inside a PRISM project; TRIM VIDEO is
  // meaningless on a still, and EDIT/CROP are meaningless on a video (both
  // mount an <img>-based editor). Rules the filter strands — leading,
  // trailing, doubled — go with it, as does a column left holding nothing but
  // rules.
  const prism = useSessionStore((s) => s.prism);
  const video = isVideoPath(path);
  const columns = useMemo(() => {
    const drop = (a: SectionItem) =>
      (prism && a === "delete") ||
      (!video && a === "trim_video") ||
      (video && (a === "edit" || a === "crop"));
    return sections
      .map((s) => {
        const kept = s.items.filter((a) => !drop(a));
        return {
          header: s.header,
          items: kept.filter(
            (a, i) =>
              a !== "-" ||
              (i > 0 &&
                kept[i - 1] !== "-" &&
                kept.slice(i + 1).some((b) => b !== "-")),
          ),
        };
      })
      .filter((s) => s.items.length > 0);
  }, [sections, prism, video]);

  const run = (action: AvailableAction) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
    await performImageAction(action, path);
  };

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-stretch bg-panel text-text border border-dim shadow-xl py-0.5 text-xs w-max"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {columns.map((col, i) => (
        <div
          key={col.header}
          className={`flex flex-col min-w-[110px] ${
            i > 0 ? "border-l border-dim" : ""
          }`}
        >
          <div className="px-1.5 py-[2px] text-dim border-b border-dim">
            {col.header}
          </div>
          {col.items.map((a, j) =>
            a === "-" ? (
              <div key={`sep-${j}`} className="my-0.5 border-t border-dim" />
            ) : (
              <button
                key={a}
                type="button"
                onClick={run(a)}
                title={LABELS[a]}
                className="text-left whitespace-nowrap px-1.5 py-[2px] hover:bg-accent"
              >
                {LABELS[a]}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
