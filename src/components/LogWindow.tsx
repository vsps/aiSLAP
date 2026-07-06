import { useEffect, useRef, useState } from "react";
import { useLogStore } from "../stores/logStore";
import { formatTime } from "../lib/format";
import { usePopupDismiss } from "../lib/popup";

const LEVEL_CLASS: Record<string, string> = {
  INFO: "text-dim",
  PROGRESS: "text-text",
  SUCCESS: "text-ok",
  ERROR: "text-bad",
};

function lineText(l: { timestamp: string; level: string; tag?: string; message: string }): string {
  return `${l.timestamp} ${l.level} ${l.tag ? `[${l.tag}] ` : ""}${l.message}`;
}

export function LogWindow({
  height,
  className = "",
}: {
  height: number;
  className?: string;
}) {
  const lines = useLogStore((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  // Auto-scroll to the newest line on each push so the latest activity is
  // visible without manual scrolling; user can scroll up to inspect history.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, height]);

  return (
    <div
      ref={ref}
      className={`bg-panel text-dim px-2 py-1 font-mono overflow-auto thin-scroll flex flex-col shrink-0 ${className}`}
      style={{ fontSize: 11, height: `${height}px` }}
    >
      {lines.length === 0 ? (
        <span className="opacity-40">—</span>
      ) : (
        lines.map((l) => (
          <div
            key={l.id}
            className={`whitespace-nowrap shrink-0 ${LEVEL_CLASS[l.level] ?? "text-text"}`}
            title={lineText(l)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, text: lineText(l) });
            }}
          >
            <span className="opacity-60">{formatTime(l.timestamp)}</span>
            {l.tag && <span className="opacity-60"> [{l.tag}]</span>} {l.message}
          </div>
        ))
      )}

      {menu && (
        <LogLineMenu
          x={menu.x}
          y={menu.y}
          text={menu.text}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function LogLineMenu({
  x,
  y,
  text,
  onClose,
}: {
  x: number;
  y: number;
  text: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopupDismiss(ref, onClose, { dismissOnContextMenu: true });

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-panel text-text border border-dim shadow-xl py-0.5 text-xs w-max min-w-[120px]"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="w-full text-left px-1.5 py-[2px] hover:bg-accent"
        onClick={() => {
          void navigator.clipboard.writeText(text).catch(() => {});
          onClose();
        }}
      >
        Copy log line
      </button>
    </div>
  );
}
