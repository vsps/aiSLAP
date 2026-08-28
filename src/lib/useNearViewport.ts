import { useEffect, useState, type RefObject } from "react";

// Gating media loads on "has this scrolled near the viewport yet".
//
// `loading="lazy"` is not a render window. Chromium applies its own margin on
// both axes relative to the scroll root, so a gallery of eight horizontally
// scrolled columns fetches several times the strictly-visible set — and it does
// nothing at all for `<video>`, which has no lazy attribute and range-reads its
// container header the moment it mounts. On a project sitting on a network share
// that is the difference between a tab switch costing a few megabytes and
// costing a few hundred.

// Generous, because rootMargin only expands the *root* — an intermediate
// clipping ancestor (each gallery column is its own `overflow-y-auto`) gets no
// buffer, so this budget is really only buying the horizontal axis, where the
// off-screen columns are. Tighter than this and columns just off the right edge
// pop in visibly during a horizontal scroll.
const MARGIN = "400px";

// One observer for every tile in the app rather than one per tile: a shot can
// hold several hundred, and each IntersectionObserver carries its own
// bookkeeping in the compositor.
let observer: IntersectionObserver | null = null;
const callbacks = new Map<Element, () => void>();

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cb = callbacks.get(entry.target);
        if (cb) cb();
      }
    },
    { rootMargin: MARGIN },
  );
  return observer;
}

/**
 * Has `ref`'s element come within a screenful of the viewport yet?
 *
 * Latching is deliberate: once a tile has been seen it stays loaded for the life
 * of the mount, so scrolling back and forth over a column doesn't thrash the
 * network. A tab switch remounts everything anyway, which is what resets it.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);

  // One effect, registering and unregistering together. Splitting them — a
  // dep-less effect to observe plus an unmount-only cleanup to unobserve — is
  // wrong under StrictMode, which runs mount → cleanup → mount: the cleanup
  // unobserves during the simulated remount, and any "already observed" guard
  // then stops the second mount re-observing. `near` never flips and every tile
  // renders blank. That bug shipped once; don't reintroduce it.
  //
  // `ref.current` therefore has to exist on the first commit. Every caller
  // renders its wrapper unconditionally, which is what makes that safe.
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (jsdom in tests, an ancient webview) means every
    // tile loads, i.e. exactly the behaviour before this existed. Degrade,
    // don't blank.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = ensureObserver();
    callbacks.set(el, () => setNear(true));
    io.observe(el);
    return () => {
      callbacks.delete(el);
      io.unobserve(el);
    };
  }, [ref, near]);

  return near;
}
