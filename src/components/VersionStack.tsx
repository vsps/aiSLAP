import { useCallback, useRef } from "react";
import type { VersionStack as VersionStackData } from "../lib/types";
import { Thumbnail } from "./Thumbnail";
import { editTagsAt, performImageAction } from "../lib/actions";

type Props = {
  shotPath: string;
  shotClipMediaPath?: string | null;
  stack: VersionStackData;
  size: number;
  selectedGlobally: boolean;
  onOpenPicker: (rect: DOMRect) => void;
  onToggleClipMedia: (imagePath: string) => void;
  onDragStart: (payload: {
    fromPath: string;
    fromShot: string;
    fromVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

const STACK_CARD_OFFSET = 3;
const STACK_CARD_MAX = 3;

export function VersionStack({
  shotPath,
  shotClipMediaPath,
  stack,
  size,
  selectedGlobally,
  onOpenPicker,
  onToggleClipMedia,
  onDragStart,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  const selectImg =
    stack.images.find((i) => i.filename === stack.selectedFilename) ??
    stack.images[stack.images.length - 1] ??
    null;

  const visibleCards = Math.min(
    Math.max(stack.images.length - 1, 0),
    STACK_CARD_MAX,
  );
  // Reserve room around the top card for the stack-edge cards behind it.
  const padTotal = STACK_CARD_MAX * STACK_CARD_OFFSET + 2;

  const clipMediaSelected = !!selectImg && selectImg.path === shotClipMediaPath;

  const selectImgPath = selectImg?.path;
  const handleSelect = useCallback(() => {
    if (!selectImgPath) return;
    // Set global selection to the visible select for downstream
    // actions (delete, trace, etc.), then open the version picker.
    void performImageAction("select", selectImgPath);
    if (rootRef.current) onOpenPicker(rootRef.current.getBoundingClientRect());
  }, [selectImgPath, onOpenPicker]);
  const handleEditTags = useCallback(
    (_path: string, anchor?: DOMRect) => {
      if (selectImgPath) editTagsAt(selectImgPath, anchor);
    },
    [selectImgPath],
  );
  const handleToggleClipMedia = useCallback(() => {
    if (!selectImgPath) return;
    onToggleClipMedia(selectImgPath);
  }, [selectImgPath, onToggleClipMedia]);
  const handleThumbDragStart = useCallback(
    (payload: { fromPath: string; pointerEvent: React.PointerEvent }) =>
      onDragStart({
        fromPath: payload.fromPath,
        fromShot: shotPath,
        fromVersion: stack.version,
        pointerEvent: payload.pointerEvent,
      }),
    [onDragStart, shotPath, stack.version],
  );

  return (
    <div
      ref={rootRef}
      data-version-cell-shot={shotPath}
      data-version-cell-version={stack.version}
      className="relative shrink-0"
      style={{ width: size + padTotal, height: size + padTotal }}
      title={
        "Drag: move image · Shift+drag: copy image · " +
        "Ctrl+drag: move stack · Ctrl+Shift+drag: copy stack"
      }
    >
      {/* Stack-edge backdrop cards. */}
      {Array.from({ length: visibleCards }).map((_, i) => {
        const off = (visibleCards - i) * STACK_CARD_OFFSET;
        return (
          <div
            key={i}
            className="absolute bg-bg border border-border pointer-events-none"
            style={{
              top: padTotal - off,
              left: padTotal - off,
              width: size,
              height: size,
            }}
          />
        );
      })}

      {/* Top card — full Thumbnail so RMB / indicators / hover-strip all light up. */}
      <div
        className="absolute"
        style={{ top: padTotal, left: padTotal, width: size, height: size }}
      >
        {selectImg ? (
          <div className="w-full" style={{ height: size }}>
            <Thumbnail
              image={selectImg}
              selected={selectedGlobally}
              columnVersion={stack.version}
              onSelect={handleSelect}
              onEditTags={handleEditTags}
              clipMediaSelected={clipMediaSelected}
              onToggleClipMedia={handleToggleClipMedia}
              onDragStart={handleThumbDragStart}
              maxAspect={1}
            />
          </div>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-xs text-dim bg-bg border border-border"
            style={{ height: size }}
          >
            empty
          </div>
        )}

        {/* Version label, anchored to the top card. */}
        <span className="absolute top-1 left-1 px-1 text-[10px] font-mono bg-bg/80 text-text z-10 pointer-events-none">
          {stack.version}
        </span>

        {/* Image count badge, anchored to the top card. */}
        {stack.images.length > 0 && (
          <span className="absolute bottom-1 right-1 px-1 text-[10px] font-mono bg-bg/80 text-text z-10 pointer-events-none">
            {stack.images.length}
          </span>
        )}
      </div>
    </div>
  );
}
