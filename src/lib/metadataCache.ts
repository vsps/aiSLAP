// Shared, session-lifetime cache for image sidecar metadata reads. A
// generated image's sidecar never changes after it's written (aside from the
// separate starred flag, which isn't stored here), so once read a path never
// needs to be re-fetched. Used by bulk consumers (e.g. per-column cost
// totals) that would otherwise re-read the same files on every render.
import { cmd } from "./tauri";
import type { ImageMetadata } from "./types";

const cache = new Map<string, Promise<ImageMetadata | null>>();

export function getImageMetadataCached(path: string): Promise<ImageMetadata | null> {
  let p = cache.get(path);
  if (!p) {
    p = cmd.image_metadata_read(path).catch(() => null);
    cache.set(path, p);
  }
  return p;
}
