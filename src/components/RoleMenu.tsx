import { useRef } from "react";
import { selectRefImages, useGenerationStore } from "../stores/generationStore";
import { usePopupDismiss } from "../lib/popup";
import type { ModelNode, RefImage, RoleAssignment } from "../lib/types";

type Props = {
  anchor: HTMLElement | null;
  ref_: RefImage;
  model: ModelNode | null;
  onAssign: (role: RoleAssignment | null) => void;
  onClose: () => void;
};

function rolesSupportedBy(model: ModelNode | null): {
  source: boolean;
  start: boolean;
  end: boolean;
  mesh: boolean;
  alpha: boolean;
  reference: boolean;
  element: boolean;
  image: boolean;
} {
  const has = (name: string) =>
    !!model?.ref_roles?.some((r) => r.role === name);
  return {
    source: has("source"),
    start: has("start"),
    end: has("end"),
    mesh: has("mesh"),
    alpha: has("alpha"),
    reference: has("reference"),
    element: has("element"),
    image: has("image"),
  };
}

export function RoleMenu({ anchor, ref_, model, onAssign, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const refImages = useGenerationStore(selectRefImages);
  const supported = rolesSupportedBy(model);
  const anyRole =
    supported.source ||
    supported.start ||
    supported.end ||
    supported.mesh ||
    supported.alpha ||
    supported.reference ||
    supported.element ||
    supported.image;

  const current = ref_.roleAssignment;
  const myElement = current?.kind === "element" ? current : null;
  const myImage = current?.kind === "image" ? current : null;

  // Existing element group numbers in first-seen order — normalized to "1","2",...
  const existingGroups: string[] = [];
  for (const r of refImages) {
    if (r.roleAssignment?.kind === "element") {
      const g = r.roleAssignment.groupName;
      if (!existingGroups.includes(g)) existingGroups.push(g);
    }
  }
  existingGroups.sort((a, b) => Number(a) - Number(b));
  const nextGroup = String(
    existingGroups.length ? Math.max(...existingGroups.map(Number)) + 1 : 1,
  );

  const existingImageGroups: string[] = [];
  for (const r of refImages) {
    if (r.roleAssignment?.kind === "image") {
      const g = r.roleAssignment.groupName;
      if (!existingImageGroups.includes(g)) existingImageGroups.push(g);
    }
  }
  existingImageGroups.sort((a, b) => Number(a) - Number(b));
  const nextImageGroup = String(
    existingImageGroups.length ? Math.max(...existingImageGroups.map(Number)) + 1 : 1,
  );

  usePopupDismiss(menuRef, onClose);

  // Position near anchor.
  const rect = anchor?.getBoundingClientRect();
  const style = rect
    ? {
        left: Math.max(8, rect.left),
        top: rect.bottom + 4,
      }
    : { left: 100, top: 100 };

  return (
    <div
      ref={menuRef}
      className="fixed z-30 bg-panel text-text border border-dim shadow-xl p-2 w-[220px] flex flex-col gap-1 text-sm"
      style={style}
    >
      <div className="text-xs opacity-60 mb-1">Role</div>
      {!anyRole && (
        <div className="text-xs text-dim px-1">No roles for this model.</div>
      )}
      {supported.source && (
        <RoleOption
          label="source"
          active={ref_.roleAssignment?.kind === "source"}
          onClick={() => onAssign({ kind: "source" })}
        />
      )}
      {supported.start && (
        <RoleOption
          label="start frame (exclusive)"
          active={ref_.roleAssignment?.kind === "start"}
          onClick={() => onAssign({ kind: "start" })}
        />
      )}
      {supported.end && (
        <RoleOption
          label="end frame (exclusive)"
          active={ref_.roleAssignment?.kind === "end"}
          onClick={() => onAssign({ kind: "end" })}
        />
      )}
      {supported.mesh && (
        <RoleOption
          label="mesh"
          active={ref_.roleAssignment?.kind === "mesh"}
          onClick={() => onAssign({ kind: "mesh" })}
        />
      )}
      {supported.reference && (
        <RoleOption
          label="reference (style)"
          active={ref_.roleAssignment?.kind === "reference"}
          onClick={() => onAssign({ kind: "reference" })}
        />
      )}
      {supported.alpha && (
        <RoleOption
          label="alpha matte"
          active={ref_.roleAssignment?.kind === "alpha"}
          onClick={() => onAssign({ kind: "alpha" })}
        />
      )}
      {supported.element && (
        <div className="flex flex-col gap-1 border-t border-dim pt-1 mt-1">
          <div className="text-xs opacity-60">element</div>
          {existingGroups.map((g) => (
            <RoleOption
              key={g}
              label={`@Element${g}${myElement?.groupName === g && myElement.frontal ? " ★" : ""}`}
              active={myElement?.groupName === g}
              onClick={() =>
                onAssign({
                  kind: "element",
                  groupName: g,
                  frontal: myElement?.groupName === g ? myElement.frontal : false,
                })
              }
            />
          ))}
          <RoleOption
            label={`+ New element (@Element${nextGroup})`}
            active={false}
            onClick={() =>
              onAssign({ kind: "element", groupName: nextGroup, frontal: true })
            }
          />
          {myElement && (
            <label className="flex items-center gap-1 text-xs px-1 pt-1">
              <input
                type="checkbox"
                checked={myElement.frontal}
                onChange={(e) =>
                  onAssign({
                    kind: "element",
                    groupName: myElement.groupName,
                    frontal: e.currentTarget.checked,
                  })
                }
                className="accent-accent"
              />
              frontal
            </label>
          )}
        </div>
      )}
      {supported.image && (
        <div className="flex flex-col gap-1 border-t border-dim pt-1 mt-1">
          <div className="text-xs opacity-60">image</div>
          {existingImageGroups.map((g) => (
            <RoleOption
              key={g}
              label={`@Image${g}`}
              active={myImage?.groupName === g}
              onClick={() => onAssign({ kind: "image", groupName: g })}
            />
          ))}
          <RoleOption
            label={`+ New image (@Image${nextImageGroup})`}
            active={false}
            onClick={() => onAssign({ kind: "image", groupName: nextImageGroup })}
          />
        </div>
      )}
      <button
        className="mt-2 text-xs text-accent hover:underline text-left"
        onClick={() => onAssign(null)}
      >
        clear role
      </button>
    </div>
  );
}

function RoleOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-2 py-[3px] ${
        active ? "bg-accent text-on-accent" : "hover:bg-panel"
      }`}
    >
      {label}
    </button>
  );
}
