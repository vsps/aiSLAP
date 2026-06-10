import { useEffect, useRef, useState } from "react";
import { cmd } from "../lib/tauri";
import type { ImageMetadata } from "../lib/types";
import { basename } from "../lib/paths";

type Props = {
  path: string;
  onClose: () => void;
};

export function ImageInfoModal({ path, onClose }: Props) {
  const [meta, setMeta] = useState<ImageMetadata | null | "loading">("loading");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    void cmd.image_metadata_read(path).then(setMeta).catch(() => setMeta(null));
  }, [path]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const prompt = meta && meta !== "loading"
    ? (meta.combinedPrompt ||
       [meta.sequencePrompt, ...(meta.shotPrompts ?? (meta.shotPrompt ? [meta.shotPrompt] : [meta.prompt ?? ""]))]
         .filter(Boolean)
         .join(" "))
    : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="bg-panel text-text border border-dim shadow-xl flex flex-col max-w-2xl w-full max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 bg-surface text-sm font-mono truncate shrink-0">
          {basename(path)}
        </div>

        {meta === "loading" ? (
          <div className="p-4 text-xs text-dim">Loading…</div>
        ) : meta === null ? (
          <div className="p-4 text-xs text-dim">No sidecar found for this file.</div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto thin-scroll flex flex-col">
            {/* Prompt summary at top */}
            {prompt && (
              <div className="px-4 py-3 border-b border-dim shrink-0">
                <div className="text-xs text-dim uppercase tracking-wide mb-1">Prompt</div>
                <div className="text-xs text-text whitespace-pre-wrap">{prompt}</div>
              </div>
            )}
            {/* Full JSON */}
            <pre className="p-4 text-xs font-mono text-text overflow-x-auto thin-scroll whitespace-pre-wrap break-all">
              {JSON.stringify(meta, null, 2)}
            </pre>
          </div>
        )}

        <div className="px-4 py-2 flex justify-end border-t border-dim shrink-0">
          <button className="px-3 py-1 bg-bg text-xs" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
