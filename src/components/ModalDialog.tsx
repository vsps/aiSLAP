import { useEffect, useRef } from "react";

type Props = {
  /** Rendered as the standard header row when given; omit for custom headers. */
  title?: React.ReactNode;
  onClose: () => void;
  /** Sizing/spacing extras for the panel (width, max-height, gap). */
  panelClassName?: string;
  /** Set false for panels with their own flush-edge header/footer strips
   *  (e.g. a full-bleed title bar) that don't want the default p-4 inset. */
  padded?: boolean;
  children: React.ReactNode;
};

/**
 * Shared modal chrome: dimmed backdrop, centered panel, Escape + backdrop
 * click to close. Content (inputs, buttons) is supplied by the caller.
 */
export function ModalDialog({
  title,
  onClose,
  panelClassName = "min-w-[320px] gap-2",
  padded = true,
  children,
}: Props) {
  // Track whether the mousedown that started this gesture landed directly on
  // the backdrop (not bubbled up from the panel) — a plain onClick isn't
  // enough because dragging a CSS `resize` handle in the panel's corner can
  // end (mouseup) with the pointer past the panel's edge, over the backdrop,
  // which would otherwise fire onClose mid-resize. Only close when BOTH the
  // press and release targeted the backdrop itself.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        className={`bg-panel text-text border border-dim flex flex-col ${padded ? "p-4" : ""} ${panelClassName}`}
      >
        {title != null && <div className="text-sm font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
