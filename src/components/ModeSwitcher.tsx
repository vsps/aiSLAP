import { Btn } from "./Btn";
import { useLayoutStore, type AppMode } from "../stores/layoutStore";
import { useTimelineStore } from "../stores/timelineStore";

const MODES: { value: AppMode; label: string; title: string }[] = [
  { value: "generate", label: "GENERATE", title: "Prompt, run and browse output" },
  { value: "deliver", label: "DELIVER", title: "Edit, tag and export" },
  { value: "audit", label: "AUDIT", title: "Costs, usage and reports" },
];

/**
 * The window's top-level surface picker. App-global — a mode switch leaves the
 * active tab and every per-tab store untouched (see `layoutStore.mode`).
 */
export function ModeSwitcher() {
  const mode = useLayoutStore((s) => s.mode);
  const setMode = useLayoutStore((s) => s.setMode);

  function pick(next: AppMode) {
    // The timeline strip only exists on DELIVER, but `timelineActive` is store
    // state that outlives its unmount — and LatestImageColumn hides its whole
    // toolbar while it is set. Leaving DELIVER mid-playback would therefore
    // blank the GENERATE preview's controls with no timeline in sight to
    // explain why. Hand the view back to the per-shot preview on the way out.
    if (mode === "deliver" && next !== "deliver") {
      useTimelineStore.getState().deactivate();
    }
    setMode(next);
  }

  return (
    <div className="flex justify-center gap-[2px] shrink-0 text-xs font-mono">
      {MODES.map((m) => (
        <Btn
          key={m.value}
          variant="toggle"
          active={m.value === mode}
          title={m.title}
          onClick={() => pick(m.value)}
          className="px-4 py-[3px] tracking-wide"
        >
          {m.label}
        </Btn>
      ))}
    </div>
  );
}
