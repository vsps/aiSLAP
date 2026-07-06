import { useEffect } from "react";

type Props = {
  onClose: () => void;
  /** Bind a plain Escape → onClose listener. Pass false when the caller
   *  already binds its own keydown handler (e.g. one that also handles
   *  arrow-key nav, or Escape needs extra conditional logic) — avoids a
   *  duplicate listener firing onClose twice. */
  closeOnEscape?: boolean;
  /** ImageZoomModal/ModelZoomModal sit at z-40; DrawMode/CropMode/
   *  SamPromptModal open on top of those, at z-50. */
  z?: 40 | 50;
  backgroundClassName?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp?: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
};

/**
 * Shared fullscreen-viewer/editor chrome: fixed full-bleed backdrop, no
 * built-in centering (each caller lays out its own toolbar/content/footer
 * flex column). Used by ImageZoomModal, ModelZoomModal, DrawMode, CropMode,
 * SamPromptModal — the "editor" side of the modal family, as opposed to
 * ModalDialog's centered dialog chrome.
 */
export function FullscreenModal({
  onClose,
  closeOnEscape = true,
  z = 50,
  backgroundClassName = "bg-black/90",
  onClick,
  onMouseUp,
  children,
}: Props) {
  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOnEscape, onClose]);

  const zClass = z === 40 ? "z-40" : "z-50";

  return (
    <div
      className={`fixed inset-0 ${zClass} flex flex-col ${backgroundClassName}`}
      onClick={onClick}
      onMouseUp={onMouseUp}
    >
      {children}
    </div>
  );
}
