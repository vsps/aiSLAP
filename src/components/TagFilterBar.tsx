import { useTagsStore } from "../stores/tagsStore";
import { ToggleGroup } from "./ToggleGroup";
import { Icon } from "../lib/icon";
import type { TagFilterMode } from "../lib/types";

const MODES: { value: TagFilterMode; label: string }[] = [
  { value: "any", label: "ANY" },
  { value: "all", label: "ALL" },
];

/** Chip row above the gallery. Narrows the columns view client-side and
 *  drives the project-wide tag view's query — one filter, both surfaces. */
export function TagFilterBar() {
  const defs = useTagsStore((s) => s.defs);
  const activeFilter = useTagsStore((s) => s.activeFilter);
  const filterMode = useTagsStore((s) => s.filterMode);
  const toggleFilter = useTagsStore((s) => s.toggleFilter);
  const setFilterMode = useTagsStore((s) => s.setFilterMode);
  const clearFilter = useTagsStore((s) => s.clearFilter);

  if (defs.length === 0) return null;
  const isOn = (name: string) =>
    activeFilter.some((t) => t.toLowerCase() === name.toLowerCase());

  return (
    <div className="flex items-center gap-2 shrink-0 px-2 py-1 bg-surface border-b border-border overflow-x-auto thin-scroll">
      <Icon name="sell" size={14} className="text-dim shrink-0" />
      <div className="flex items-center gap-1 flex-wrap">
        {defs.map((d) => {
          const on = isOn(d.name);
          return (
            <button
              key={d.name}
              type="button"
              onClick={() => toggleFilter(d.name)}
              title={
                on ? `Stop filtering by "${d.name}"` : `Filter by "${d.name}"`
              }
              className={`flex items-center gap-1 px-1.5 py-[1px] text-xs whitespace-nowrap border ${
                on
                  ? "bg-accent text-bg border-accent"
                  : "bg-bg border-dim hover:bg-panel"
              }`}
            >
              <span
                className="w-[6px] h-[6px] shrink-0"
                style={{ background: d.color }}
              />
              {d.name}
            </button>
          );
        })}
      </div>
      {activeFilter.length > 1 && (
        <ToggleGroup
          value={filterMode}
          options={MODES}
          onChange={setFilterMode}
          className="shrink-0"
        />
      )}
      {activeFilter.length > 0 && (
        <button
          type="button"
          onClick={clearFilter}
          title="Clear tag filter"
          className="px-1.5 py-[1px] text-xs bg-bg hover:bg-panel shrink-0"
        >
          CLEAR
        </button>
      )}
    </div>
  );
}
