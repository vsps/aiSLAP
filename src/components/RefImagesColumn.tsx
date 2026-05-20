import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IconBtn } from "./IconBtn";
import { RoleMenu } from "./RoleMenu";
import { useGenerationStore } from "../stores/generationStore";
import { useSessionStore } from "../stores/sessionStore";
import { fileSrc } from "../lib/assets";
import { basename } from "../lib/paths";
import { pickFile, showMessage } from "../lib/dialog";
import { cmd } from "../lib/tauri";
import { performImageAction } from "../lib/actions";
import type { RefImage, RoleAssignment } from "../lib/types";
import { MEDIA_EXTS, VIDEO_EXTS, classifyMedia } from "../lib/media";

function isMedia(path: string): boolean {
  return classifyMedia(path) !== null;
}

export function RefImagesColumn() {
  const { currentModel, refImages, addRefs, removeRef, removeAllRefs, assignRole, reorderRefs } =
    useGenerationStore();
  const expandedIdx = useGenerationStore((s) => s.expandedIdx);
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

  const [menu, setMenu] = useState<{ anchor: HTMLElement; ref: RefImage } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [galleryDragOver, setGalleryDragOver] = useState(false);
  const [dragState, setDragState] = useState<{ fromIdx: number; overIdx: number | null } | null>(
    null,
  );
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
    // Read shotPath fresh each call — the Tauri drop listener is registered
    // once for the component lifetime, so we can't rely on a closed-over value.
    const shotPath = useSessionStore.getState().shotPath;
    if (!shotPath) {
      await showMessage("Open a shot first", { kind: "warning" });
      return;
    }
    const media = paths.filter(isMedia);
    if (media.length === 0) return;
    const copied: string[] = [];
    for (const p of media) {
      try {
        const dest = await cmd.ref_copy_to_global_src(shotPath, p);
        copied.push(dest);
      } catch (e) {
        await showMessage(`Failed to add ${basename(p)}: ${e}`, { kind: "error" });
      }
    }
    if (copied.length) addRefs(copied);
  }

  async function onAdd() {
    const paths = await pickFile("Pick reference media", {
      extensions: MEDIA_EXTS,
      multiple: true,
    });
    if (!paths) return;
    await ingestPaths(paths);
  }

  // Tauri-level OS file drop. Registered once. `disposed` guards against the
  // cleanup firing before onDragDropEvent's promise resolves — otherwise the
  // real listener leaks and stale handlers stack up on every shot change.
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

  // Intra-app drag-to-reorder. The white bar on each thumb is the handle
  // (image body stays as a zoom target). Pointer events so it coexists with
  // Tauri's OS file-drop (HTML5 drag is blocked on Windows when dragDropEnabled=true).
  function beginHandleDrag(fromIdx: number, pointerId: number, handleEl: HTMLElement) {
    handleEl.setPointerCapture(pointerId);
    setDragState({ fromIdx, overIdx: null });
    let currentOver: number | null = null;

    const findIdxAt = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const thumb = el.closest<HTMLElement>("[data-ref-idx]");
      if (!thumb) return null;
      const n = Number(thumb.dataset.refIdx);
      return Number.isFinite(n) ? n : null;
    };

    const onMove = (ev: PointerEvent) => {
      const idx = findIdxAt(ev.clientX, ev.clientY);
      currentOver = idx;
      setDragState({ fromIdx, overIdx: idx });
    };
    const onUp = () => {
      handleEl.releasePointerCapture(pointerId);
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onUp);
      setDragState(null);
      if (currentOver != null && currentOver !== fromIdx) {
        reorderRefs(fromIdx, currentOver);
      }
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  }

  return (
    <>
      <div
        ref={panelRef}
        data-ref-drop="true"
        className={`bg-surface border border-border p-prompt-column text-text w-[381px] flex flex-col gap-prompt-column-gap shrink-0 transition-colors ${
          dragOver || galleryDragOver ? "outline outline-2 outline-accent" : ""
        }`}
      >
        <div className="flex items-center text-sm font-semibold">
          <span>REF IMAGES</span>
          <span className="flex-1" />
          <span className="text-xs opacity-60 font-mono">{refImages.length}</span>
          <button
            type="button"
            onClick={removeAllRefs}
            disabled={refImages.length === 0}
            className="ml-2 px-1 text-xs font-mono text-red-500 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
            title="Clear all references"
          >[clear]</button>
        </div>
        <div className="flex flex-wrap gap-prompt-column-gap content-start overflow-y-auto thin-scroll bg-inset p-prompt-panel flex-1 min-h-0">
          {showChainPrev && activeLink && (
            <ChainPrevTile
              modelName={prevLinkModel?.name ?? null}
              onRemove={() => setLinkConsumesPrev(activeLink.id, false)}
            />
          )}
          {refImages.map((r, idx) => (
            <RefThumb
              key={r.path}
              index={idx}
              ref_={r}
              isDragging={dragState?.fromIdx === idx}
              isDropTarget={dragState != null && dragState.overIdx === idx && dragState.fromIdx !== idx}
              onRemove={() => removeRef(r.path)}
              onOpenMenu={(anchor) => setMenu({ anchor, ref: r })}
              onZoom={() => void performImageAction("zoom", r.path)}
              onHandlePointerDown={(pointerId, handleEl) => beginHandleDrag(idx, pointerId, handleEl)}
            />
          ))}
          <RefAddTile onAdd={onAdd} />
        </div>
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

function RefThumb({
  index,
  ref_,
  isDragging,
  isDropTarget,
  onRemove,
  onOpenMenu,
  onZoom,
  onHandlePointerDown,
}: {
  index: number;
  ref_: RefImage;
  isDragging: boolean;
  isDropTarget: boolean;
  onRemove: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
  onZoom: () => void;
  onHandlePointerDown: (pointerId: number, handleEl: HTMLElement) => void;
}) {
  const label = roleLabel(ref_);
  const isVideo = isVideoPath(ref_.path);
  const isAudio = isAudioPath(ref_.path);
  const src = fileSrc(ref_.path);

  return (
    <div
      data-ref-idx={index}
      className={`relative bg-bg text-text overflow-hidden w-[109px] h-[109px] flex flex-col justify-between p-[3px] group ${
        isDragging ? "opacity-40" : ""
      } ${isDropTarget ? "outline outline-2 outline-accent" : ""}`}
      style={isVideo || isAudio ? undefined : {
        backgroundImage: `url("${src}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
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
      {/* Top bar = role label + role-menu trigger (click anywhere on the bar). */}
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

      {/* Click body to zoom */}
      <div
        className="absolute inset-0 cursor-zoom-in"
        onClick={onZoom}
        title={ref_.path}
      />

      <div
        className="relative flex items-center gap-[3px] bg-bg/85 px-[2px] py-[1px] cursor-grab active:cursor-grabbing select-none"
        title="Drag to reorder"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // Don't initiate drag if the press landed on an icon button.
          const tgt = e.target as HTMLElement;
          if (tgt.closest("button")) return;
          e.preventDefault();
          onHandlePointerDown(e.pointerId, e.currentTarget);
        }}
      >
        <IconBtn name="close" size={18} title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }} />
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
      <IconBtn name="add_photo_alternate" size={28} title="Add reference images" onClick={onAdd} />
    </div>
  );
}

function roleLabel(r: RefImage): string {
  const a = r.roleAssignment;
  if (!a) return basename(r.path);
  switch (a.kind) {
    case "source": return "source";
    case "start": return "start";
    case "end": return "end";
    case "element": return `@Element${a.groupName}${a.frontal ? " ★" : ""}`;
    case "image": return `@Image${a.groupName}`;
    case "chain_prev": return "prev link";
  }
}
