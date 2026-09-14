import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { performImageAction } from "../lib/actions";
import { FullscreenModal } from "./FullscreenModal";
import { ModelCanvas } from "./ModelCanvas";
import { Btn } from "./Btn";
import { IconBtn } from "./IconBtn";

type Props = {
  image: GalleryImage;
  onClose: () => void;
  /** Omitted in a PRISM project, where aiSLAP never deletes. */
  onDelete?: () => void;
};

export function ModelZoomModal({ image, onClose, onDelete }: Props) {
  const modelUrl = fileSrc(image.path);

  return (
    <FullscreenModal
      onClose={onClose}
      z={40}
      backgroundClassName="bg-bg"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 bg-panel shrink-0">
        <span className="font-mono text-xs text-dim truncate flex-1">{image.filename}</span>
        <Btn
          title="Add to refs"
          onClick={() => performImageAction("add_to_refs", image.path)}
        >
          + ref
        </Btn>
        {onDelete && (
          <Btn
            title="Move to TRASH"
            onClick={async () => { await onDelete(); onClose(); }}
          >
            trash
          </Btn>
        )}
        <IconBtn name="close" size={18} title="Close (Esc)" onClick={onClose} />
      </div>

      {/* 3D canvas — the rig lives in ModelCanvas, shared with the preview
          pane so the two surfaces cannot shade the same model differently. */}
      <div className="flex-1 min-h-0">
        <ModelCanvas url={modelUrl} />
      </div>

      <div className="px-3 py-1 bg-panel text-xs text-dim shrink-0">
        drag to orbit · scroll to zoom · right-drag to pan
      </div>
    </FullscreenModal>
  );
}
