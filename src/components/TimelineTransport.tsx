import { useEffect, useState } from "react";
import { useTimelineStore } from "../stores/timelineStore";
import { IconBtn } from "./IconBtn";
import { ExportModal } from "./ExportModal";
import { confirmAction } from "../lib/dialog";

export function TimelineTransport() {
  const totalDurationSec = useTimelineStore((s) => s.totalDurationSec);
  const setTotalDuration = useTimelineStore((s) => s.setTotalDuration);
  const playing = useTimelineStore((s) => s.playing);
  const play = useTimelineStore((s) => s.play);
  const pause = useTimelineStore((s) => s.pause);
  const restart = useTimelineStore((s) => s.restart);
  const resetClips = useTimelineStore((s) => s.resetClips);
  const clipCount = useTimelineStore((s) => s.clips.length);

  const [exportOpen, setExportOpen] = useState(false);
  const [draft, setDraft] = useState(totalDurationSec.toFixed(1));
  useEffect(() => {
    setDraft(totalDurationSec.toFixed(1));
  }, [totalDurationSec]);

  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n) && n > 0) {
      setTotalDuration(n);
    } else {
      setDraft(totalDurationSec.toFixed(1));
    }
  };

  return (
    <div className="flex items-center px-2 gap-2 border-l border-border bg-panel">
      <IconBtn
        name="fast_rewind"
        size={18}
        title="Rewind to start"
        onClick={restart}
        disabled={totalDurationSec <= 0}
      />
      {playing ? (
        <IconBtn name="pause" size={18} title="Pause" onClick={pause} />
      ) : (
        <IconBtn
          name="play_arrow"
          size={18}
          title="Play"
          onClick={play}
          disabled={totalDurationSec <= 0}
        />
      )}
      <IconBtn
        name="download"
        size={18}
        title="Export"
        onClick={() => setExportOpen(true)}
        disabled={totalDurationSec <= 0}
      />
      <div className="flex items-center gap-1 ml-1">
        <input
          type="number"
          step={0.1}
          min={0.5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-16 bg-bg border border-border text-text px-1 py-[1px] text-xs text-right font-mono"
          title="Total timeline duration (seconds)"
        />
        <span className="text-xs text-dim font-mono">s</span>
      </div>
      <IconBtn
        name="restore"
        size={18}
        title="Reset clips (order, durations, slip, disabled) — keeps media picks"
        onClick={async () => {
          const ok = await confirmAction(
            "Reset clip order, durations, slip offsets, and disabled state? Media picks (clip eye + version override) are preserved.",
            { title: "Reset timeline", kind: "warning" },
          );
          if (ok) resetClips();
        }}
        disabled={clipCount === 0}
      />
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
}
