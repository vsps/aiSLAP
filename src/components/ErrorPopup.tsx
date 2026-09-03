import { useEffect, useState } from "react";
import { useGenerationStore } from "../stores/generationStore";
import { ModalDialog } from "./ModalDialog";
import { Btn } from "./Btn";

export function ErrorPopup() {
  const errorPopup = useGenerationStore((s) => s.errorPopup);
  const setError = useGenerationStore((s) => s.setError);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (errorPopup) setCopied(false);
  }, [errorPopup]);

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
    <ModalDialog
      onClose={() => setError(null)}
      padded={false}
      panelClassName="max-w-[640px] w-full shadow-xl"
    >
      <div className="px-4 py-2 bg-bad text-text text-sm">Generation Error</div>
      <pre className="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[60vh]">
        {errorPopup}
      </pre>
      <div className="px-4 py-2 flex justify-end gap-2">
        <Btn onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Btn>
        <Btn onClick={() => setError(null)}>
          Dismiss
        </Btn>
      </div>
    </ModalDialog>
  );
}
