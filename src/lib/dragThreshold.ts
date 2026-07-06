// Shared pointer-threshold drag detection: track pointer movement from a
// pointerdown and only fire once it exceeds a small threshold, so plain
// clicks don't get misread as drags.

/** Attach window listeners on pointerdown that call `onStart` once the
 *  pointer moves past `thresholdPx` from the origin; cleans itself up on
 *  pointerup/pointercancel or once `onStart` fires. */
export function startThresholdDrag(
  e: { clientX: number; clientY: number },
  thresholdPx: number,
  onStart: () => void,
): void {
  const startX = e.clientX;
  const startY = e.clientY;
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > thresholdPx) {
      cleanup();
      onStart();
    }
  };
  const onUp = () => cleanup();
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
