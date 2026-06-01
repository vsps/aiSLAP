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
        visible.map((j) => {
          const done = j.status === "done";
          const failed = j.status === "failed";
          const glyph = done ? "☑" : failed ? "✕" : "☐";
          const color = done ? "text-ok" : failed ? "text-bad" : "text-dim";
          const preview = j.shotPromptPreview ?? "";
          return (
            <div
              key={j.id}
              className={`flex items-baseline gap-1 truncate ${color}`}
              title={preview || j.progressMessage}
            >
              <span className="w-3 shrink-0 text-center">{glyph}</span>
              <span className="flex-1 truncate">
                {preview || "(no prompt)"}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
