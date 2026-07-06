import { useEffect } from "react";

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
      onClick={onClose}
    >
      <div
        className={`bg-panel text-text border border-dim flex flex-col ${padded ? "p-4" : ""} ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title != null && <div className="text-sm font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
