import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF, Center } from "@react-three/drei";
import type { GalleryImage } from "../lib/types";
import { fileSrc } from "../lib/assets";
import { performImageAction } from "../lib/actions";
import { FullscreenModal } from "./FullscreenModal";

type Props = {
  image: GalleryImage;
  onClose: () => void;
  /** Omitted in a PRISM project, where aiSLAP never deletes. */
  onDelete?: () => void;
};

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return (
    <Center>
      <primitive object={scene} />
    </Center>
  );
}

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
        <button
          className="accent-hover px-2 py-1 text-xs font-mono"
          title="Add to refs"
          onClick={() => performImageAction("add_to_refs", image.path)}
        >
          + ref
        </button>
        {onDelete && (
          <button
            className="accent-hover px-2 py-1 text-xs font-mono text-bad"
            title="Move to TRASH"
            onClick={async () => { await onDelete(); onClose(); }}
          >
            trash
          </button>
        )}
        <button
          className="accent-hover px-2 py-1 text-xs font-mono"
          title="Close (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {/* 3D canvas */}
      <div className="flex-1 min-h-0">
        {/* Lit entirely from local lights. This used to add drei's
            <Environment preset="city" />, which fetches an HDR from a public
            CDN at runtime — in a desktop app that is usually offline that
            request just fails, and the model silently rendered with only the
            ambient and key lights anyway. The rig below is that same fallback,
            made deliberate: a hemisphere light for ambient bounce plus a key
            and a fill, so shading reads correctly with no network at all. */}
        <Canvas camera={{ position: [0, 0.5, 2.5], fov: 45 }} shadows>
          <ambientLight intensity={0.6} />
          <hemisphereLight args={["#ffffff", "#404040", 0.8]} />
          <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
          <directionalLight position={[-5, 3, -5]} intensity={0.4} />
          <Suspense fallback={null}>
            <Model url={modelUrl} />
          </Suspense>
          <OrbitControls makeDefault autoRotate autoRotateSpeed={0.6} />
        </Canvas>
      </div>

      <div className="px-3 py-1 bg-panel text-xs text-dim shrink-0">
        drag to orbit · scroll to zoom · right-drag to pan
      </div>
    </FullscreenModal>
  );
}
