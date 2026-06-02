import { useEffect, useRef } from "react";
import { useLogStore } from "../stores/logStore";

const LEVEL_CLASS: Record<string, string> = {
  INFO: "text-dim",
  PROGRESS: "text-text",
  SUCCESS: "text-ok",
  ERROR: "text-bad",
};

export function LogWindow({
  height,
  className = "",
}: {
  height: number;
  className?: string;
}) {
  const lines = useLogStore((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest line on each push so the latest activity is
  // visible without manual scrolling; user can scroll up to inspect history.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, height]);

  return (
    <div
      ref={ref}
      className={`bg-panel text-dim px-2 py-1 font-mono overflow-y-auto thin-scroll flex flex-col shrink-0 ${className}`}
      style={{ fontSize: 11, height: `${height}px` }}
    >
      {lines.length === 0 ? (
        <span className="opacity-40">—</span>
      ) : (
        lines.map((l) => (
          <div
            key={l.id}
            className={`truncate shrink-0 ${LEVEL_CLASS[l.level] ?? "text-text"}`}
            title={`${l.timestamp} ${l.level} ${l.tag ? `[${l.tag}] ` : ""}${l.message}`}
          >
            <span className="opacity-60">{formatTime(l.timestamp)}</span>
            {l.tag && <span className="opacity-60"> [{l.tag}]</span>} {l.message}
          </div>
        ))
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
