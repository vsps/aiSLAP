import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Dismiss a popup/menu on outside click, Escape, or the cursor leaving the
 * window. Ref-based (checks `!ref.current.contains(e.target)`) rather than a
 * plain global listener — a plain listener fires on mousedown before a click
 * on the popup's own buttons has a chance to register, since the popup can
 * unmount between mousedown and click.
 *
 * Registered in the capture phase (not bubble) so it still fires when a
 * trigger elsewhere (e.g. another thumbnail's onContextMenu) calls
 * stopPropagation — otherwise an already-open popup never hears the event
 * that should have dismissed it, and right-clicking around the app stacks
 * up menus instead of replacing them.
 */
export function usePopupDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: { dismissOnContextMenu?: boolean },
): void {
  const dismissOnContextMenu = options?.dismissOnContextMenu ?? false;
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const leave = (e: MouseEvent) => {
      if (e.relatedTarget === null) onClose();
    };
    window.addEventListener("mousedown", down, { capture: true });
    window.addEventListener("keydown", esc);
    document.documentElement.addEventListener("mouseleave", leave);
    if (dismissOnContextMenu)
      window.addEventListener("contextmenu", down, { capture: true });
    return () => {
      window.removeEventListener("mousedown", down, { capture: true });
      window.removeEventListener("keydown", esc);
      document.documentElement.removeEventListener("mouseleave", leave);
      if (dismissOnContextMenu)
        window.removeEventListener("contextmenu", down, { capture: true });
    };
  }, [ref, onClose, dismissOnContextMenu]);
}

/**
 * Clamp a popup anchored at client (x, y) so it stays within the viewport.
 * Measures the popup (via `ref`) after mount and nudges left/top inward if
 * it would overflow the window edge.
 */
export function useClampedPosition(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
): { left: number; top: number } {
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 4;
    const left = Math.min(x, window.innerWidth - r.width - pad);
    const top = Math.min(y, window.innerHeight - r.height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [ref, x, y]);

  return pos;
}
