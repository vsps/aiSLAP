import { useMemo, useRef, useState } from "react";
import {
  selectImageByPath,
  selectTaggedImageByPath,
  useSessionStore,
} from "../stores/sessionStore";
import {
  tagColor,
  tagsEqual as eq,
  useEffectiveTagDefs,
  useTagsStore,
} from "../stores/tagsStore";
import { usePopupDismiss, useClampedPosition } from "../lib/popup";
import { basename } from "../lib/paths";
import { Icon } from "../lib/icon";

/** Tags on the target image, from whichever loaded view holds it. Reading
 *  from the store rather than a prop keeps the popover in sync with the
 *  optimistic patch tagsStore.setImageTags applies. */
function useImageTags(path: string): string[] {
  const byPath = useSessionStore(selectImageByPath);
  const taggedByPath = useSessionStore(selectTaggedImageByPath);
  return useMemo(
    () => (byPath.get(path) ?? taggedByPath.get(path))?.tags ?? EMPTY_TAGS,
    [byPath, taggedByPath, path],
  );
}

/** Stable empty array — a fresh `[]` here would change identity every render
 *  and defeat the memo for every untagged image. */
const EMPTY_TAGS: string[] = [];

export function TagEditorPopup() {
  const target = useSessionStore((s) => s.tagEditor);
  if (!target) return null;
  // Keyed + passed by value so the editor remounts (fresh query, fresh
  // anchor) per image and never has to cope with a null target mid-render.
  return <Editor key={target.path} target={target} />;
}

type Target = { path: string; anchor: { x: number; y: number } | null };

function Editor({ target }: { target: Target }) {
  const close = useSessionStore((s) => s.setTagEditor);
  const defs = useEffectiveTagDefs();
  const setImageTags = useTagsStore((s) => s.setImageTags);

  const tags = useImageTags(target.path);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = target.anchor ?? {
    x: window.innerWidth / 2 - 110,
    y: window.innerHeight / 3,
  };
  const pos = useClampedPosition(ref, anchor.x, anchor.y);
  usePopupDismiss(ref, () => close(null));

  const trimmed = query.trim();
  const suggestions = defs
    .filter((d) => !tags.some((t) => eq(t, d.name)))
    .filter(
      (d) => !trimmed || d.name.toLowerCase().includes(trimmed.toLowerCase()),
    );
  const isNew = !!trimmed && !defs.some((d) => eq(d.name, trimmed));

  async function apply(next: string[]) {
    setBusy(true);
    try {
      await setImageTags(target.path, next);
      setQuery("");
    } finally {
      setBusy(false);
    }
  }

  const add = (tag: string) =>
    void apply(tags.some((t) => eq(t, tag)) ? tags : [...tags, tag]);
  const remove = (tag: string) => void apply(tags.filter((t) => !eq(t, tag)));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter commits the top suggestion, or the typed value as a new tag.
      const pick = suggestions[0]?.name;
      if (trimmed && (isNew || !pick)) add(trimmed);
      else if (pick) add(pick);
    } else if (e.key === "Backspace" && !query && tags.length > 0) {
      remove(tags[tags.length - 1]);
    }
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-panel text-text border border-dim shadow-xl text-xs w-[220px] flex flex-col"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        className="px-1.5 py-1 text-dim truncate border-b border-dim"
        title={target.path}
      >
        {basename(target.path)}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 p-1.5 border-b border-dim">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => remove(t)}
              title={`Remove "${t}"`}
              className="flex items-center gap-1 px-1 py-[1px] bg-inset hover:bg-accent hover:text-bg"
            >
              <span
                className="w-[6px] h-[6px] shrink-0"
                style={{ background: tagColor(defs, t) }}
              />
              {t}
              <Icon name="close" size={11} />
            </button>
          ))}
        </div>
      )}

      <input
        autoFocus
        value={query}
        disabled={busy}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Add tag…"
        className="bg-inset px-1.5 py-1 outline-none disabled:opacity-50"
      />

      <div className="max-h-[180px] overflow-y-auto thin-scroll py-0.5">
        {isNew && (
          <button
            type="button"
            onClick={() => add(trimmed)}
            className="w-full text-left px-1.5 py-[2px] hover:bg-accent flex items-center gap-1"
          >
            <Icon name="add" size={12} />
            Create "{trimmed}"
          </button>
        )}
        {suggestions.map((d) => (
          <button
            key={d.name}
            type="button"
            onClick={() => add(d.name)}
            className="w-full text-left px-1.5 py-[2px] hover:bg-accent flex items-center gap-1.5"
          >
            <span
              className="w-[6px] h-[6px] shrink-0"
              style={{ background: d.color }}
            />
            <span className="truncate">{d.name}</span>
          </button>
        ))}
        {!isNew && suggestions.length === 0 && (
          <div className="px-1.5 py-[2px] text-dim">
            {defs.length === 0
              ? "No tags yet — type to create one."
              : "No matches."}
          </div>
        )}
      </div>
    </div>
  );
}
