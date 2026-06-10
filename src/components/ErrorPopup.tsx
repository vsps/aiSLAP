import { useEffect, useState } from "react";
import { useGenerationStore } from "../stores/generationStore";

export function ErrorPopup() {
  const errorPopup = useGenerationStore((s) => s.errorPopup);
  const setError = useGenerationStore((s) => s.setError);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!errorPopup) return;
    setCopied(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setError(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [errorPopup, setError]);

  if (!errorPopup) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(errorPopup);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable; ignore silently
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={() => setError(null)}
    >
      <div
        className="bg-panel text-text max-w-[640px] w-full border border-dim shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 bg-bad text-text text-sm">Generation Error</div>
        <pre className="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[60vh]">
          {errorPopup}
        </pre>
        <div className="px-4 py-2 flex justify-end gap-2">
          <button
            className="bg-dim text-text px-3 py-1"
            onClick={copy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            className="bg-accent text-text px-3 py-1"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
