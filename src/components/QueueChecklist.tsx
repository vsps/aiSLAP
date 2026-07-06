import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { useGenerationStore } from "../stores/generationStore";
import { formatTime } from "../lib/format";

/**
 * Left half of the log surface — one row per submission iteration, ticked
 * when the iteration's media is on disk. Completed rows persist (the store
 * caps total jobs at 50, dropping the oldest completed first); the list
 * scrolls and auto-pins to the newest activity.
 */
export function QueueChecklist({
  height,
  className = "",
  style,
}: {
  height: number;
  className?: string;
  style?: CSSProperties;
}) {
  const jobs = useGenerationStore((s) => s.jobs);
  const visible = jobs.filter((j) => j.status !== "cancelled");

  const ref = useRef<HTMLDivElement>(null);
  // Auto-scroll to the bottom on changes so the latest submission/iter is
  // visible; the user can scroll up to inspect history.
  const completedTotal = visible.reduce((s, j) => s + j.completedIterations, 0);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [visible.length, completedTotal, height]);

  return (
    <div
      ref={ref}
      className={`bg-panel text-dim px-2 py-1 font-mono overflow-y-auto thin-scroll flex flex-col shrink-0 ${className}`}
      style={{ fontSize: 11, height: `${height}px`, ...style }}
    >
      {visible.length === 0 ? (
        <span className="opacity-40">queue empty</span>
      ) : (
        visible.flatMap((j) => {
          const total = Math.max(1, j.iterations);
          const preview = j.shotPromptPreview ?? "";
          return Array.from({ length: total }, (_, idx) => {
            const k = idx + 1;
            const done = j.status === "done" || k <= j.completedIterations;
            // The single iter that was in flight when the job failed.
            const failed =
              j.status === "failed" && k === j.completedIterations + 1;
            const glyph = done ? "☑" : failed ? "✕" : "☐";
            const color = done
              ? "text-ok"
              : failed
                ? "text-bad"
                : "text-dim";
            const suffix = total > 1 ? ` ${k}/${total}` : "";
            return (
              <div
                key={`${j.id}-${k}`}
                className={`flex items-baseline gap-1 truncate shrink-0 ${color}`}
                title={`${j.enqueuedAt} · ${preview || j.progressMessage}`}
              >
                <span className="w-3 shrink-0 text-center">{glyph}</span>
                <span className="opacity-60 shrink-0">
                  {formatTime(j.enqueuedAt)}
                </span>
                <span className="flex-1 truncate">
                  {preview || "(no prompt)"}
                  {suffix && <span className="opacity-50">{suffix}</span>}
                </span>
              </div>
            );
          });
        })
      )}
    </div>
  );
}
