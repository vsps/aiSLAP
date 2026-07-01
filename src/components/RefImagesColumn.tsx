import { memo, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IconBtn } from "./IconBtn";
import { RoleMenu } from "./RoleMenu";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { useLayoutStore } from "../stores/layoutStore";
import {
  selectCurrentModel,
  selectRefImages,
  useGenerationStore,
} from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import { fileSrc } from "../lib/assets";
import { basename } from "../lib/paths";
import { pickFile, showMessage } from "../lib/dialog";
import { cmd } from "../lib/tauri";
import { performImageAction } from "../lib/actions";
import type { ModelNode, RefImage, RoleAssignment } from "../lib/types";
import {
  MEDIA_EXTS,
  VIDEO_EXTS,
  classifyMedia,
  type MediaKind,
} from "../lib/media";

const GROUP_PALETTE = [
  "#e74c3c",
  "#f39c12",
  "#f1c40f",
  "#2ecc71",
  "#1abc9c",
  "#9b59b6",
  "#e91e63",
  "#3498db",
];
const START_COLOR = "#22c55e";
const END_COLOR = "#ef4444";
const SOURCE_COLOR = "#3b82f6";
const MESH_COLOR = "#f97316";

function roleColor(role: RoleAssignment | null): string | null {
  if (!role) return null;
  if (role.kind === "start") return START_COLOR;
  if (role.kind === "end") return END_COLOR;
  if (role.kind === "source") return SOURCE_COLOR;
  if (role.kind === "mesh") return MESH_COLOR;
  if (role.kind === "element" || role.kind === "image") {
    const n = Number(role.groupName);
    const i = (Number.isFinite(n) ? n : 1) - 1;
    return GROUP_PALETTE[i % GROUP_PALETTE.length];
  }
  return null;
}

function showRow(
  kind: MediaKind,
  hasRefs: boolean,
  m: ModelNode | null,
): boolean {
  if (hasRefs) return true;
  if (!m) return kind === "image";
  // 3D mesh ref slot (e.g. SAM3 3d-align body_mesh_url) — surfaced by role.
  if (kind === "model3d") return !!m.ref_roles?.some((r) => r.role === "mesh");
  for (const i of m.inputs) {
    if (kind === "image" && i.data_type === "IMAGE") return true;
    if (kind === "video" && i.data_type === "VIDEO") return true;
    if (kind === "audio" && i.data_type === "AUDIO") return true;
  }
  return false;
}

function isMedia(path: string): boolean {
  return classifyMedia(path) !== null;
}

const ROW_TITLE: Record<MediaKind, string> = {
  image: "REF IMAGES",
  video: "REF VIDEOS",
  audio: "REF AUDIO",
  model3d: "REF 3D",
};

type DropTarget =
  | { kind: "reorder"; idx: number }
  | { kind: "slot"; role: "start" | "end" }
  | null;

export function RefImagesColumn() {
  const currentModel = useGenerationStore(selectCurrentModel);
  const refImages = useGenerationStore(selectRefImages);
  const addRefs = useGenerationStore((s) => s.addRefs);
  const removeRef = useGenerationStore((s) => s.removeRef);
  const removeAllRefs = useGenerationStore((s) => s.removeAllRefs);
  const assignRole = useGenerationStore((s) => s.assignRole);
  const swapRoleAssignments = useGenerationStore((s) => s.swapRoleAssignments);
  const reorderRefs = useGenerationStore((s) => s.reorderRefs);
  const expandedIdx = useGenerationStore((s) => s.expandedIdx);
  const width = useLayoutStore((s) => s.widths.refImages);
  const linksLen = useGenerationStore((s) => s.links.length);
  const activeLink = useGenerationStore((s) =>
    s.expandedIdx == null ? null : s.links[s.expandedIdx],
  );
  const setLinkConsumesPrev = useGenerationStore((s) => s.setLinkConsumesPrev);
  const showChainPrev =
    !!activeLink &&
    activeLink.consumesPrev &&
    expandedIdx != null &&
    expandedIdx > 0 &&
    linksLen > 1;
  const prevLinkModel = useGenerationStore((s) =>
    s.expandedIdx != null && s.expandedIdx > 0
      ? (s.links[s.expandedIdx - 1]?.model ?? null)
      : null,
  );

  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    ref: RefImage;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [galleryDragOver, setGalleryDragOver] = useState(false);
  const [dragState, setDragState] = useState<{
    fromIdx: number;
    overIdx: number | null;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const imageDrag = useSessionStore((s) => s.imageDrag);

  // While a gallery thumbnail is being dragged, track whether the pointer is
  // over the ref panel so we can highlight it as a drop target. Drop itself is
  // handled by Gallery's pointerup listener (which knows the source path).
  useEffect(() => {
    if (!imageDrag) {
      setGalleryDragOver(false);
      return;
    }
    const onMove = (e: PointerEvent) => {
      const el = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      setGalleryDragOver(inside);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [imageDrag]);

  async function ingestPaths(paths: string[]) {
    const session = useSessionStore.getState();
    const { shotPath, targetVersion, columns: sessionCols } = session;
    if (!shotPath) {
      await showMessage("Open a shot first", { kind: "warning" });
      return;
    }
    if (!targetVersion) {
      await showMessage("Pick a target version first", { kind: "warning" });
      return;
    }
    // Refs must not silently land in GLOBAL SRC — that path is now
    // explicit-only (drop on the SRC column).
    const targetCol = sessionCols.find((c) => c.version === targetVersion);
    if (targetCol?.isSrc) {
      await showMessage(
        "Select a non-SRC version as target (drop on SRC explicitly to save there).",
        { kind: "warning" },
      );
      return;
    }
    const destDir = `${shotPath}/${targetVersion}`;
    const media = paths.filter(isMedia);
    if (media.length === 0) return;
    const copied: string[] = [];
    for (const p of media) {
      try {
        const dest = await cmd.image_copy_to_dir(p, destDir);
        copied.push(dest);
      } catch (e) {
        await showMessage(`Failed to add ${basename(p)}: ${e}`, {
          kind: "error",
        });
      }
    }
    if (copied.length) {
      addRefs(copied);
      // Files now also live in the current gen folder — rescan so the
      // version column reflects them too.
      await useSessionStore.getState().rescanShot();
    }
  }

  async function onAdd() {
    const paths = await pickFile("Pick reference media", {
      extensions: MEDIA_EXTS,
      multiple: true,
    });
    if (!paths) return;
    await ingestPaths(paths);
  }

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const hitTest = (x: number, y: number): boolean => {
      const el = panelRef.current;
      if (!el) return false;
      const dpr = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      const cx = x / dpr;
      const cy = y / dpr;
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(hitTest(p.position.x, p.position.y));
        } else if (p.type === "leave") {
          setDragOver(false);
        } else if (p.type === "drop") {
          const inside = hitTest(p.position.x, p.position.y);
          setDragOver(false);
          if (inside) await ingestPaths(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("onDragDropEvent registration failed:", e));
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginHandleDrag(
    fromIdx: number,
    pointerId: number,
    handleEl: HTMLElement,
  ) {
    handleEl.setPointerCapture(pointerId);
    setDragState({ fromIdx, overIdx: null });
    let currentTarget: DropTarget = null;

    const resolveDrop = (x: number, y: number): DropTarget => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const slot = el.closest<HTMLElement>("[data-role-slot]");
      if (slot) {
        const role = slot.dataset.roleSlot;
        if (role === "start" || role === "end") return { kind: "slot", role };
      }
      const thumb = el.closest<HTMLElement>("[data-ref-idx]");
      if (thumb) {
        const n = Number(thumb.dataset.refIdx);
        return Number.isFinite(n) ? { kind: "reorder", idx: n } : null;
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      const t = resolveDrop(ev.clientX, ev.clientY);
      currentTarget = t;
      setDragState({
        fromIdx,
        overIdx: t?.kind === "reorder" ? t.idx : null,
      });
    };
    const onUp = () => {
      handleEl.releasePointerCapture(pointerId);
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onUp);
      setDragState(null);

      const t = currentTarget;
      const dragged = refImages[fromIdx];
      if (!t || !dragged) return;

      if (t.kind === "slot") {
        assignRole(dragged.path, { kind: t.role });
        return;
      }
      if (t.idx === fromIdx) return;
      const target = refImages[t.idx];
      if (!target) return;

      const draggedRole = dragged.roleAssignment;
      const targetRole = target.roleAssignment;
      const slotKind = (r: RoleAssignment | null) =>
        r && (r.kind === "start" || r.kind === "end") ? r.kind : null;
      const draggedIsSlot = slotKind(draggedRole);
      const targetIsSlot = slotKind(targetRole);

      if (draggedIsSlot && targetIsSlot) {
        swapRoleAssignments(dragged.path, target.path);
        return;
      }
      if (targetIsSlot && !draggedIsSlot) {
        assignRole(dragged.path, targetRole);
        return;
      }
      if (draggedIsSlot && !targetIsSlot) {
        assignRole(dragged.path, null);
      }
      reorderRefs(fromIdx, t.idx);
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  }

  const buckets: Record<MediaKind, { ref: RefImage; idx: number }[]> = {
    image: [],
    video: [],
    audio: [],
    model3d: [],
  };
  refImages.forEach((r, idx) => {
    const k = classifyMedia(r.path) ?? "image";
    buckets[k].push({ ref: r, idx });
  });

  const modelHasStart = !!currentModel?.ref_roles?.some(
    (r) => r.role === "start",
  );
  const modelHasEnd = !!currentModel?.ref_roles?.some((r) => r.role === "end");
  const startTaken = refImages.some((r) => r.roleAssignment?.kind === "start");
  const endTaken = refImages.some((r) => r.roleAssignment?.kind === "end");
  const showStartSlot = modelHasStart && !startTaken;
  const showEndSlot = modelHasEnd && !endTaken;

  const visibleKinds = (
    ["image", "video", "audio", "model3d"] as MediaKind[]
  ).filter(
    (k) =>
      showRow(k, buckets[k].length > 0, currentModel) ||
      (k === "image" && showChainPrev),
  );

  return (
    <>
      <div
        ref={panelRef}
        data-ref-drop="true"
        style={{ width }}
        className={`relative bg-surface border border-border p-prompt-column text-text flex flex-col gap-prompt-column-gap shrink-0 transition-colors ${
          dragOver || galleryDragOver ? "outline outline-2 outline-accent" : ""
        }`}
      >
        <div className="flex items-center text-sm font-semibold">
          <span>REFERENCES</span>
          <span className="flex-1" />
          <span className="text-xs opacity-60 font-mono">
            {refImages.length}
          </span>
          <button
            type="button"
            onClick={removeAllRefs}
            disabled={refImages.length === 0}
            className="ml-2 px-1 text-xs font-mono text-red-500 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
            title="Clear all references"
          >
            [clear]
          </button>
        </div>
        <div className="flex flex-col gap-prompt-column-gap overflow-y-auto thin-scroll bg-inset p-prompt-panel flex-1 min-h-0">
          {visibleKinds.map((kind) => (
            <div key={kind} className="flex flex-col gap-1">
              <div className="text-[11px] font-mono opacity-60">
                {ROW_TITLE[kind]}{" "}
                <span className="opacity-70">({buckets[kind].length})</span>
              </div>
              <div className="flex flex-wrap gap-prompt-column-gap content-start">
                {kind === "image" && showChainPrev && activeLink && (
                  <ChainPrevTile
                    modelName={prevLinkModel?.name ?? null}
                    onRemove={() => setLinkConsumesPrev(activeLink.id, false)}
                  />
                )}
                {kind === "image" && showStartSlot && (
                  <RoleSlotPlaceholder kind="start" />
                )}
                {kind === "image" && showEndSlot && (
                  <RoleSlotPlaceholder kind="end" />
                )}
                {buckets[kind].map(({ ref: r, idx }) => (
                  <RefThumb
                    key={r.path}
                    index={idx}
                    ref_={r}
                    color={roleColor(r.roleAssignment)}
                    isDragging={dragState?.fromIdx === idx}
                    isDropTarget={
                      dragState != null &&
                      dragState.overIdx === idx &&
                      dragState.fromIdx !== idx
                    }
                    onRemove={() => removeRef(r.path)}
                    onOpenMenu={(anchor) => setMenu({ anchor, ref: r })}
                    onSelect={() => void performImageAction("select", r.path)}
                    onHandlePointerDown={(pointerId, handleEl) =>
                      beginHandleDrag(idx, pointerId, handleEl)
                    }
                  />
                ))}
                {kind === "image" && <RefAddTile onAdd={onAdd} />}
              </div>
            </div>
          ))}
        </div>
        <ColumnResizeHandle columnKey="refImages" />
      </div>

      {menu && (
        <RoleMenu
          anchor={menu.anchor}
          ref_={menu.ref}
          model={currentModel}
          onAssign={(role: RoleAssignment | null) => {
            assignRole(menu.ref.path, role);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function isVideoPath(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop();
  return !!ext && VIDEO_EXTS.includes(ext);
}

function isAudioPath(path: string): boolean {
  return classifyMedia(path) === "audio";
}

// memo'd: many refs render in the grid; skip re-rendering thumbs whose props
// are unchanged when a sibling drag updates the parent.
const RefThumb = memo(function RefThumb({
  index,
  ref_,
  color,
  isDragging,
  isDropTarget,
  onRemove,
  onOpenMenu,
  onSelect,
  onHandlePointerDown,
}: {
  index: number;
  ref_: RefImage;
  color: string | null;
  isDragging: boolean;
  isDropTarget: boolean;
  onRemove: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
  onSelect: () => void;
  onHandlePointerDown: (pointerId: number, handleEl: HTMLElement) => void;
}) {
  const label = roleLabel(ref_);
  const isVideo = isVideoPath(ref_.path);
  const isAudio = isAudioPath(ref_.path);
  const src = fileSrc(ref_.path);

  const baseStyle: React.CSSProperties =
    isVideo || isAudio
      ? {}
      : {
          backgroundImage: `url("${src}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        };
  if (color && !isDropTarget) {
    baseStyle.outline = `2px solid ${color}`;
    baseStyle.outlineOffset = "-2px";
  }

  return (
    <div
      data-ref-idx={index}
      className={`relative bg-bg text-text overflow-hidden w-[109px] h-[109px] flex flex-col justify-between p-[3px] group ${
        isDragging ? "opacity-40" : ""
      } ${isDropTarget ? "outline outline-2 outline-accent" : ""}`}
      style={baseStyle}
    >
      {isVideo && (
        <video
          src={src}
          preload="metadata"
          muted
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        />
      )}
      {isAudio && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span
            aria-hidden
            className="material-symbols-outlined opacity-70"
            style={{ fontSize: 48 }}
          >
            graphic_eq
          </span>
        </div>
      )}
      <div
        className="relative z-10 flex items-start bg-bg/90 hover:bg-bg px-1 text-xs leading-tight truncate max-w-full cursor-pointer"
        title="Click to change role"
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e.currentTarget);
        }}
      >
        {label}
      </div>

      <div
        className="absolute inset-0 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={ref_.path}
      />

      <div
        className="relative flex items-center gap-[3px] bg-bg/85 px-[2px] py-[1px] cursor-grab active:cursor-grabbing select-none"
        title="Drag to reorder"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const tgt = e.target as HTMLElement;
          if (tgt.closest("button")) return;
          e.preventDefault();
          onHandlePointerDown(e.pointerId, e.currentTarget);
        }}
      >
        <IconBtn
          name="close"
          size={18}
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        />
        <div className="flex-1" />
        <span
          aria-hidden
          className="material-symbols-outlined opacity-60 pointer-events-none"
          style={{ fontSize: 18 }}
        >
          drag_indicator
        </span>
      </div>
    </div>
  );
});

function RoleSlotPlaceholder({ kind }: { kind: "start" | "end" }) {
  const color = kind === "start" ? START_COLOR : END_COLOR;
  return (
    <div
      data-role-slot={kind}
      className="w-[109px] h-[109px] flex items-center justify-center text-xs font-mono opacity-70 outline-dashed outline-2"
      style={{ outlineColor: color, outlineOffset: "-2px", color }}
      title={`Drop an image here to set ${kind} frame`}
    >
      {kind.toUpperCase()}
    </div>
  );
}

function ChainPrevTile({
  modelName,
  onRemove,
}: {
  modelName: string | null;
  onRemove: () => void;
}) {
  return (
    <div
      className="relative bg-bg/40 text-text overflow-hidden w-[109px] h-[109px] flex flex-col items-center justify-center p-[3px] outline-dashed outline-2 outline-accent/60"
      title={modelName ? `Output of: ${modelName}` : "Output of previous link"}
    >
      <IconBtn
        name="close"
        size={16}
        title="Don't consume previous link's output"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute top-0 right-0"
      />
      <span
        aria-hidden
        className="material-symbols-outlined opacity-80"
        style={{ fontSize: 32 }}
      >
        link
      </span>
      <div className="text-[10px] opacity-80 mt-1">prev link</div>
      {modelName && (
        <div className="text-[10px] opacity-60 text-center break-words leading-tight px-1">
          {modelName}
        </div>
      )}
    </div>
  );
}

function RefAddTile({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="bg-surface w-[109px] h-[109px] flex items-center justify-center">
      <IconBtn
        name="add_photo_alternate"
        size={28}
        title="Add reference media"
        onClick={onAdd}
      />
    </div>
  );
}

function roleLabel(r: RefImage): string {
  const a = r.roleAssignment;
  if (!a) return basename(r.path);
  switch (a.kind) {
    case "source":
      return "source";
    case "start":
      return "start";
    case "end":
      return "end";
    case "mesh":
      return "mesh";
    case "element":
      return `@Element${a.groupName}${a.frontal ? " ★" : ""}`;
    case "image":
      return `@Image${a.groupName}`;
    case "chain_prev":
      return "prev link";
  }
}
