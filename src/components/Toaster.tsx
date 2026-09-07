import { useEffect, useState } from "react";
import { TOAST_DWELL_MS, useToastStore, type Toast } from "../stores/toastStore";

/** Fade-out duration. Kept in step with the `duration-500` class below —
 *  Tailwind needs the literal class name, so this can't be derived from it. */
const FADE_MS = 500;

/**
 * Stack of transient confirmations, centered on screen.
 *
 * **Nothing here takes pointer events.** The container is `pointer-events-none`
 * so a toast sitting over the middle of the workbench doesn't swallow a click
 * underneath it — the whole point is that the interface stays usable while it
 * is up. That also means a toast can't be dismissed by clicking it, which is
 * fine: it leaves on its own.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    // z above ModalDialog's z-50 rather than equal to it: at the same layer
    // the winner is DOM order, which is not something a notification should
    // depend on. Safe to sit on top precisely because it takes no clicks.
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-1 pointer-events-none">
      {toasts.map((t) => (
        <ToastLine key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastLine({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  // Mount transparent, then flip on the next frame so the transition has two
  // states to move between — set opacity-100 in the same paint and there is
  // nothing to animate from.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const fade = setTimeout(() => setShown(false), TOAST_DWELL_MS);
    // Removed from the store only once the fade has actually finished,
    // otherwise it vanishes instantly instead of easing out.
    const drop = setTimeout(() => dismiss(toast.id), TOAST_DWELL_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fade);
      clearTimeout(drop);
    };
  }, [toast.id, dismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`bg-src-bg border border-border text-text text-xs px-3 py-1.5 rounded-full shadow-lg transition-opacity duration-500 ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      {toast.text}
    </div>
  );
}
