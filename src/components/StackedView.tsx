import { useEffect, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { cmd } from "../lib/tauri";
import { selectImagePath, toggleStarPath } from "../lib/actions";
import { showMessage } from "../lib/dialog";
import { dirname, joinPath } from "../lib/paths";
import { VersionStack } from "./VersionStack";
import { SelectPickerPopup } from "./SelectPickerPopup";
import { Thumbnail } from "./Thumbnail";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    fromShotPath?: string;
    fromVersionName?: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

type PickerState = {
  shotPath: string;
  version: string;
  selectedFilename: string;
  anchor: { x: number; y: number };
};

export function StackedView({ onDragStart }: Props) {
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const shotPath = useSessionStore((s) => s.shotPath);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const sequenceStacks = useSessionStore((s) => s.sequenceStacks);
  const sequenceStacksLoading = useSessionStore((s) => s.sequenceStacksLoading);
  const rescanSequenceStacks = useSessionStore((s) => s.rescanSequenceStacks);
  const setShot = useSessionStore((s) => s.setShot);
  const thumbColWidth = useSessionStore((s) => s.thumbColWidth);
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);

  const [picker, setPicker] = useState<PickerState | null>(null);

  useEffect(() => {
    if (sequencePath && !sequenceStacks) void rescanSequenceStacks();
  }, [sequencePath, sequenceStacks, rescanSequenceStacks]);

  if (!sequencePath) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Open a sequence to see its shot stacks.
      </div>
    );
  }

  if (sequenceStacksLoading && !sequenceStacks) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        Loading…
      </div>
    );
  }

  if (!sequenceStacks || sequenceStacks.shots.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        No shots in this sequence yet.
      </div>
    );
  }

  async function pickSelect(shot: string, version: string, filename: string) {
    try {
      await cmd.shot_version_select_set(shot, version, filename);
      await rescanSequenceStacks();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  function toggleClipMediaFor(
    shot: string,
    currentClip: string | null | undefined,
    imagePath: string,
  ) {
    void setShotClipMedia(shot, currentClip === imagePath ? null : imagePath);
    void rescanSequenceStacks();
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto thin-scroll bg-surface p-gallery-column">
        {/* GLOBAL SRC fixed row — Thumbnails so RMB + indicators come for free. */}
        <div
          className="flex items-stretch gap-gallery-column-gap mb-gallery-column-gap"
          data-stacked-global-src={joinPath(dirname(sequencePath), "SRC")}
        >
          <div className="shrink-0 w-[140px] bg-src-bg border border-border px-2 py-1 text-sm font-semibold">
            GLOBAL SRC
          </div>
          <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
            {sequenceStacks.globalSrcImages.length === 0 ? (
              <div className="text-xs text-dim self-center pl-2">No refs</div>
            ) : (
              sequenceStacks.globalSrcImages.map((img) => (
                <div
                  key={img.path}
                  className="shrink-0"
                  style={{ width: thumbColWidth, height: thumbColWidth }}
                >
                  <Thumbnail
                    image={img}
                    selected={selectedImagePath === img.path}
                    columnVersion="GLOBAL SRC"
                    onSelect={selectImagePath}
                    onToggleStar={toggleStarPath}
                    onDragStart={(payload) =>
                      onDragStart({
                        fromPath: payload.fromPath,
                        fromColumnVersion: payload.fromColumnVersion,
                        pointerEvent: payload.pointerEvent,
                      })
                    }
                    maxAspect={1}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* One row per shot */}
        <div className="flex flex-col gap-gallery-column-gap">
          {sequenceStacks.shots.map((s) => {
            const isCurrentShot = s.shotPath === shotPath;
            return (
              <div
                key={s.shotPath}
                data-shot-row={s.shotPath}
                className={`flex items-start gap-gallery-column-gap p-2 border ${
                  isCurrentShot
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface"
                }`}
              >
                <button
                  type="button"
                  className="shrink-0 w-[140px] self-stretch bg-src-bg border border-border px-2 py-1 text-sm text-left truncate hover:border-accent"
                  title={s.shotPath}
                  onClick={() => void setShot(s.shotPath)}
                >
                  {s.shotName}
                </button>
                <div className="flex-1 min-w-0 flex flex-wrap gap-3 pt-1">
                  {s.versions.length === 0 ? (
                    <div className="text-xs text-dim self-center pl-2">
                      No versions
                    </div>
                  ) : (
                    s.versions.map((v) => {
                      const selectPath = v.images.find(
                        (i) => i.filename === v.selectedFilename,
                      )?.path;
                      const isSelectedGlobal =
                        !!selectPath && selectPath === selectedImagePath;
                      return (
                        <VersionStack
                          key={v.version}
                          shotPath={s.shotPath}
                          shotClipMediaPath={s.clipMediaPath ?? null}
                          stack={v}
                          size={thumbColWidth}
                          selectedGlobally={isSelectedGlobal}
                          onOpenPicker={(rect) => {
                            setPicker({
                              shotPath: s.shotPath,
                              version: v.version,
                              selectedFilename: v.selectedFilename,
                              anchor: { x: rect.left, y: rect.bottom + 4 },
                            });
                          }}
                          onToggleClipMedia={(imgPath) =>
                            toggleClipMediaFor(
                              s.shotPath,
                              s.clipMediaPath,
                              imgPath,
                            )
                          }
                          onDragStart={(payload) =>
                            onDragStart({
                              fromPath: payload.fromPath,
                              fromColumnVersion: payload.fromVersion,
                              fromShotPath: payload.fromShot,
                              fromVersionName: payload.fromVersion,
                              pointerEvent: payload.pointerEvent,
                            })
                          }
                        />
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {picker &&
        (() => {
          const shot = sequenceStacks.shots.find(
            (s) => s.shotPath === picker.shotPath,
          );
          const version = shot?.versions.find(
            (v) => v.version === picker.version,
          );
          if (!version) return null;
          return (
            <SelectPickerPopup
              anchor={picker.anchor}
              images={version.images}
              selectedFilename={picker.selectedFilename}
              onPick={(filename) => {
                setPicker(null);
                void pickSelect(picker.shotPath, picker.version, filename);
              }}
              onClose={() => setPicker(null)}
              onDragStart={(payload) =>
                onDragStart({
                  fromPath: payload.fromPath,
                  fromColumnVersion: picker.version,
                  fromShotPath: picker.shotPath,
                  fromVersionName: picker.version,
                  pointerEvent: payload.pointerEvent,
                })
              }
            />
          );
        })()}
    </>
  );
}
