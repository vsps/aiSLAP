// Shared, session-lifetime cache for image sidecar metadata reads. A
// generated image's sidecar is written once and then only ever changed by an
// explicit user action (tagging), so once read a path never needs to be
// re-fetched until something invalidates it. Used by bulk consumers (e.g.
// per-column cost totals) that would otherwise re-read the same files on
// every render.
import { cmd } from "./tauri";
import type { Config, ImageMetadata, SharedConfig } from "./types";

const cache = new Map<string, Promise<ImageMetadata | null>>();

export function getImageMetadataCached(
  path: string,
): Promise<ImageMetadata | null> {
  let p = cache.get(path);
  if (!p) {
    p = cmd.image_metadata_read(path).catch(() => null);
    cache.set(path, p);
  }
  return p;
}

/** Drop a path's cached sidecar after writing to it (tags live in there —
 *  see tagsStore.setImageTags), so the next read sees the new contents. */
export function invalidateImageMetadata(path: string): void {
  cache.delete(path);
}

// Config rarely changes and is read per-thumbnail hover (for the ffmpeg
// path) — cache it and invalidate on save instead of re-reading from disk
// every time.
let configPromise: Promise<Config | null> | null = null;

export function getConfigCached(): Promise<Config | null> {
  if (!configPromise) {
    configPromise = cmd.config_load().catch(() => null);
  }
  return configPromise;
}

export function invalidateConfigCache(): void {
  configPromise = null;
}

// The shared YAML config lives on a network share and aiSLAP never writes to
// it, so there's no local save to invalidate on — a session-lifetime cache
// with no invalidation path is fine here (a live edit picks up on next launch,
// same as models_load's own lack of hot reload).
let sharedConfigPromise: Promise<SharedConfig | null> | null = null;

export function getSharedConfigCached(): Promise<SharedConfig | null> {
  if (!sharedConfigPromise) {
    sharedConfigPromise = cmd.shared_config_load().catch(() => null);
  }
  return sharedConfigPromise;
}
