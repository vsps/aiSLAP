import { pickFile } from "../../lib/dialog";
import { fileSrc } from "../../lib/assets";
import { basename } from "../../lib/paths";
import { findSequenceBody, findShotBody, parseScript } from "../../lib/script";
import { useSessionStore } from "../../stores/sessionStore";
import { Btn } from "../Btn";

type Props = {
  script: string;
};

/**
 * The currently selected shot (driven by `sessionStore.shotPath`, set via
 * `ShotTreeNav`): its script excerpt, one pinned storyboard frame, and its
 * reference images. Both image areas are `[data-*-drop]`-marked so the
 * shared OS drag-drop listener (`lib/osDragDrop.ts`) routes a file dropped
 * here to the right place — storyboard images can also be pinned from the
 * gallery via the "TOGGLE STORYBOARD IMAGE" context-menu action.
 */
export function ShotDetailPanel({ script }: Props) {
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const shotPath = useSessionStore((s) => s.shotPath);
  const shotEntityPath = useSessionStore((s) => s.shotEntityPath);
  const storyboardImagePath = useSessionStore((s) => s.storyboardImagePath);
  const columns = useSessionStore((s) => s.columns);
  const setShotStoryboardImage = useSessionStore((s) => s.setShotStoryboardImage);

  const shotName = basename(shotEntityPath ?? shotPath);
  const seqName = basename(sequencePath);
  const body =
    shotPath && sequencePath
      ? findShotBody(parseScript(script), seqName, shotName)
      : "";
  const seqBody =
    sequencePath && !shotPath ? findSequenceBody(parseScript(script), seqName) : "";

  const refColumn = columns.find((c) => c.refScope === "shot");
  const refImages = refColumn ? [...refColumn.srcImages, ...refColumn.images] : [];

  async function browseStoryboard() {
    const picked = await pickFile("Pick storyboard image", {
      extensions: ["png", "jpg", "jpeg", "webp"],
    });
    if (picked?.[0]) await setShotStoryboardImage(picked[0]);
  }

  if (!shotPath) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-1">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Selected shot
        </div>
        <div className="flex-1 bg-inset flex items-center justify-center text-xs text-dim p-4 text-center">
          {seqBody
            ? seqBody
            : "Pick a shot in the tree to see its storyboard and references."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0 min-h-0 overflow-y-auto thin-scroll">
      <div>
        <div className="text-xs font-semibold text-accent uppercase tracking-wide">
          {shotName}
        </div>
        {body && (
          <div className="text-xs text-dim whitespace-pre-wrap mt-1">{body}</div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            Storyboard
          </div>
          <div className="flex gap-1">
            <Btn onClick={browseStoryboard}>Browse</Btn>
            {storyboardImagePath && (
              <Btn onClick={() => void setShotStoryboardImage(null)}>Clear</Btn>
            )}
          </div>
        </div>
        <div
          data-storyboard-drop="true"
          className="bg-inset aspect-video w-full flex items-center justify-center overflow-hidden"
        >
          {storyboardImagePath ? (
            <img
              src={fileSrc(storyboardImagePath)}
              alt="Storyboard"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <span className="text-xs text-dim">
              Drop an image here, or pin one from the gallery
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1 flex-1 min-h-0">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Reference images
        </div>
        <div
          data-ref-drop="true"
          className="flex-1 min-h-[80px] bg-inset grid grid-cols-3 gap-1 p-1 content-start overflow-y-auto thin-scroll"
        >
          {refImages.length === 0 && (
            <span className="col-span-3 text-xs text-dim p-2">
              Drop reference images here.
            </span>
          )}
          {refImages.map((img) => (
            <img
              key={img.path}
              src={fileSrc(img.thumbPath ?? img.path)}
              alt={img.filename}
              className="aspect-square w-full object-cover bg-bg"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
