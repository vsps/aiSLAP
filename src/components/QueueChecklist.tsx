import { useGenerationStore } from "../stores/generationStore";

/**
 * Left half of the log surface — one row per in-flight or recently completed
 * submission, ticked when the job's media is on disk. Rows disappear ~5s
 * after `done` (existing schedulePrune in generate.ts).
 */
export function QueueChecklist({
  height,
  className = "",
}: {
  height: number;
  className?: string;
}) {
  const jobs = useGenerationStore((s) => s.jobs);
  const visible = jobs.filter((j) => j.status !== "cancelled");

  return (
    <div
      className={`bg-panel text-dim px-2 py-1 font-mono overflow-y-auto thin-scroll flex flex-col shrink-0 ${className}`}
      style={{ fontSize: 11, height: `${height}px` }}
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
                className={`flex items-baseline gap-1 truncate ${color}`}
                title={preview || j.progressMessage}
              >
                <span className="w-3 shrink-0 text-center">{glyph}</span>
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
