import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF, Center } from "@react-three/drei";

type Props = {
  /** Asset-protocol URL of the .glb/.gltf — `fileSrc(image.path)`. */
  url: string;
  /** Spin slowly when idle. On by default; the orbit control stops it as
   *  soon as the user drags. */
  autoRotate?: boolean;
};

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  // Cloned, not mounted directly. `useGLTF` caches per URL and hands every
  // caller the same `Object3D` — and an Object3D has exactly one parent, so
  // attaching it to a second scene graph *detaches* it from the first. With
  // the preview pane still mounted behind the zoom modal, both want the same
  // mesh: without this, opening the modal empties the pane behind it and
  // closing it leaves the pane blank until the selection changes.
  //
  // A shallow-ish `clone()` shares geometries and materials, so the second
  // viewport costs graph nodes rather than GPU memory. Skinned meshes would
  // need SkeletonUtils.clone to rebind their skeleton; nothing generates
  // rigged output today, and a static mesh clones correctly.
  const model = useMemo(() => scene.clone(), [scene]);
  return (
    <Center>
      <primitive object={model} />
    </Center>
  );
}

/**
 * The GLB viewport: camera, lighting rig and orbit controls, with no chrome
 * of its own so it can fill a modal or sit inline in the preview pane.
 *
 * Extracted from `ModelZoomModal` when the preview pane gained a 3D branch —
 * two copies of the rig would drift, and a model that shades differently
 * depending on which surface you opened it from is a bug nobody would think
 * to look for.
 *
 * **This module is the three.js entry point and must only ever be reached
 * through `React.lazy`.** three + fiber + drei is a ~1MB chunk; a static
 * import from anything on the startup path puts all of it in the main bundle.
 * Both call sites go through `LazyBoundary`.
 *
 * Lit entirely from local lights. This used to add drei's
 * `<Environment preset="city" />`, which fetches an HDR from a public CDN at
 * runtime — in a desktop app that is usually offline that request just fails,
 * and the model silently rendered with only the ambient and key lights anyway.
 * The rig below is that same fallback, made deliberate: a hemisphere light for
 * ambient bounce plus a key and a fill, so shading reads correctly with no
 * network at all.
 */
export function ModelCanvas({ url, autoRotate = true }: Props) {
  return (
    <Canvas camera={{ position: [0, 0.5, 2.5], fov: 45 }} shadows>
      <ambientLight intensity={0.6} />
      <hemisphereLight args={["#ffffff", "#404040", 0.8]} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
      <directionalLight position={[-5, 3, -5]} intensity={0.4} />
      <Suspense fallback={null}>
        <Model url={url} />
      </Suspense>
      <OrbitControls makeDefault autoRotate={autoRotate} autoRotateSpeed={0.6} />
    </Canvas>
  );
}
