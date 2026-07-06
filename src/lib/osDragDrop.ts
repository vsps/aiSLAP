// Single app-level OS file drag-drop listener. Replaces per-component
// getCurrentWebview().onDragDropEvent registrations (one per gallery column
// plus one in the ref panel) with one listener that hit-tests via
// document.elementFromPoint against the same data-* markers the internal
// pointer-drag system already uses.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSessionStore } from "../stores/sessionStore";
import { useGenerationStore } from "../stores/generationStore";
import { classifyMedia } from "./media";
import { cmd } from "./tauri";
import { showMessage } from "./dialog";
import { basename } from "./paths";

export type OsDragTarget =
  | { kind: "column"; version: string; isSrc: boolean; destDir: string }
  | { kind: "ref" }
  | null;

let target: OsDragTarget = null;
const listeners = new Set<() => void>();

function setTarget(next: OsDragTarget) {
  target = next;
  listeners.forEach((l) => l());
}

export function getOsDragTarget(): OsDragTarget {
  return target;
}

export function subscribeOsDragTarget(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function resolveTarget(x: number, y: number): OsDragTarget {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / dpr, y / dpr);
  if (!el) return null;
  const refPanel = (el as HTMLElement).closest<HTMLElement>("[data-ref-drop]");
  if (refPanel) return { kind: "ref" };
  const col = (el as HTMLElement).closest<HTMLElement>("[data-column-version]");
  if (col) {
    const version = col.dataset.columnVersion ?? "";
    const destDir = col.dataset.columnDest ?? "";
    const isSrc = col.dataset.columnIsSrc === "true";
    if (version && destDir) return { kind: "column", version, isSrc, destDir };
  }
  return null;
}

// OS file drag-drop onto a column → copy each file in, then rescan so it
// appears. The GLOBAL SRC column uses ref_copy_to_global_src (project-level,
// overwrite-on-collision). The per-shot SRC and version columns copy directly
// into their destDir.
export async function ingestIntoColumn(
  paths: string[],
  destDir: string,
  isSrc: boolean,
  version: string,
): Promise<void> {
  const shot = useSessionStore.getState().shotPath;
  if (!shot) {
    await showMessage("Open a shot first", { kind: "warning" });
    return;
  }
  const media = paths.filter((p) => classifyMedia(p) !== null);
  if (media.length === 0) return;
  let any = false;
  for (const p of media) {
    try {
      if (isSrc && version === "GLOBAL SRC") {
        await cmd.ref_copy_to_global_src(shot, p);
      } else {
        await cmd.dir_ensure(destDir);
        await cmd.image_copy_to_dir(p, destDir);
      }
      any = true;
    } catch (e) {
      await showMessage(`Failed to add ${basename(p)}: ${e}`, {
        kind: "error",
      });
    }
  }
  if (any) await useSessionStore.getState().rescanShot();
}

export async function ingestIntoRefPanel(paths: string[]): Promise<void> {
  const session = useSessionStore.getState();
  const { shotPath } = session;
  if (!shotPath) {
    await showMessage("Open a shot first", { kind: "warning" });
    return;
  }
  const destDir = `${shotPath}/SRC`;
  // Ensure the per-shot SRC folder exists (created at shot creation,
  // but guard against legacy shots that don't have it yet).
  await cmd.dir_ensure(destDir);
  const media = paths.filter((p) => classifyMedia(p) !== null);
  if (media.length === 0) return;
  const copied: string[] = [];
  for (const p of media) {
    try {
      const dest = await cmd.image_copy_to_dir(p, destDir);
      copied.push(dest);
    } catch (e) {
      await showMessage(`Failed to add ${basename(p)}: ${e}`, {
        kind: "error",
      });
    }
  }
  if (copied.length) {
    useGenerationStore.getState().addRefs(copied);
    await useSessionStore.getState().rescanShot();
  }
}

let installed = false;

export function installOsDragDropListener(): void {
  if (installed) return;
  installed = true;
  // getCurrentWebview() reads window.__TAURI_INTERNALS__ synchronously — if
  // that isn't injected yet (e.g. a dev-mode Vite full-reload racing the
  // Tauri preload script), it throws. This runs directly in App's mount
  // effect with no error boundary above it, so an uncaught throw here blanks
  // the entire app; never let it propagate.
  try {
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setTarget(resolveTarget(p.position.x, p.position.y));
        } else if (p.type === "leave") {
          setTarget(null);
        } else if (p.type === "drop") {
          const hit = resolveTarget(p.position.x, p.position.y);
          setTarget(null);
          if (hit?.kind === "ref") {
            await ingestIntoRefPanel(p.paths);
          } else if (hit?.kind === "column") {
            await ingestIntoColumn(
              p.paths,
              hit.destDir,
              hit.isSrc,
              hit.version,
            );
          }
        }
      })
      .catch((e) => console.error("onDragDropEvent registration failed:", e));
  } catch (e) {
    installed = false;
    console.error("installOsDragDropListener failed:", e);
  }
}
