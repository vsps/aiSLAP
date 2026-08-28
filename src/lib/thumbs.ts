import { useEffect, useState } from "react";
import { cmd } from "./tauri";
import { joinPath } from "./paths";
import { getConfigCached } from "./metadataCache";
import type { ThumbsReport } from "./types";

/**
 * Driving the thumbnail cache from the frontend.
 *
 * The sweep itself is idempotent and interruptible in Rust; what this adds is a
 * per-session memory of which folders have already been swept. Without it every
 * rescan — and a rescan follows every generation iteration — would re-walk the
 * shot, which on a read-only share means retrying a write that will never
 * succeed, once a second, forever.
 */
const swept = new Set<string>();
/** In-flight sweeps, so two rescans landing together don't both walk the disk. */
const running = new Map<string, Promise<ThumbsReport | null>>();

export function producedAnything(r: ThumbsReport | null): boolean {
  if (!r) return false;
  return (
    r.imagesEncoded + r.postersUpgraded + r.postersExtracted + r.pruned > 0
  );
}

async function run(
  root: string,
  recursive: boolean,
): Promise<ThumbsReport | null> {
  const cfg = await getConfigCached();
  const ffmpegPath = (cfg?.ffmpegPath ?? "").trim();
  const report = await cmd
    .thumbs_ensure(root, recursive, ffmpegPath)
    .catch((e) => {
      console.warn(`[thumbs] sweep failed for ${root}:`, e);
      return null;
    });
  // Every `null` the lookup cache is holding may have just become a real path.
  // Gallery columns get theirs from the rescan the caller triggers; the timeline
  // asks per path, and would otherwise keep showing an icon until the next
  // navigation.
  if (producedAnything(report)) lookups.clear();
  return report;
}

function sweepDirOnce(dir: string): Promise<ThumbsReport | null> {
  const existing = running.get(dir);
  if (existing) return existing;
  if (swept.has(dir)) return Promise.resolve(null);
  const p = run(dir, false).finally(() => {
    // Marked swept even on failure: a share that rejected the write once will
    // reject it again, and retrying on every rescan is worse than no thumbnails.
    swept.add(dir);
    running.delete(dir);
  });
  running.set(dir, p);
  return p;
}

/**
 * Build any missing thumbnails for one shot, at most once per session.
 *
 * Two sweeps, not one: a shot's own folders, and the project-level `SRC` that
 * renders as the GLOBAL SRC column in every shot's gallery. That column holds
 * the plates, which are usually the largest files in the project, and it sits
 * outside the shot so a shot-scoped walk never reaches it.
 *
 * Resolves to `null` when there was nothing to do (already swept, or the sweep
 * failed) and to a report otherwise — callers use `producedAnything` to decide
 * whether a rescan is worth it.
 */
export async function sweepShotOnce(
  shotPath: string,
  projectPath: string | null,
): Promise<ThumbsReport | null> {
  const reports = await Promise.all([
    sweepDirOnce(shotPath),
    projectPath ? sweepDirOnce(joinPath(projectPath, "SRC")) : null,
  ]);
  return reports.find(producedAnything) ?? reports.find(Boolean) ?? null;
}

/**
 * Full project sweep: encodes everything missing and prunes orphaned entries.
 * This is the one that backfills the 8MB legacy `.thumb.png` posters, so it is
 * user-triggered rather than automatic — on a large project it reads every
 * media file once.
 */
export async function rebuildProjectThumbs(
  projectPath: string,
): Promise<ThumbsReport | null> {
  const report = await run(projectPath, true);
  // A full sweep supersedes every per-shot decision, including the ones that
  // failed — let them be retried after this. (`run` already cleared the lookup
  // cache if anything was produced; a prune with no encodes counts too.)
  swept.clear();
  lookups.clear();
  return report;
}

// ---------- lookup by bare path ----------
//
// A gallery scan resolves `thumbPath` for every tile it returns, so nothing in
// the gallery needs this. The timeline does: its clips reference media by path
// and never pass through a scan.

/** Promise-keyed, exactly like `metadataCache` — the same path asked for by
 *  five clips costs one IPC round trip. */
const lookups = new Map<string, Promise<string | null>>();

export function thumbForPath(path: string): Promise<string | null> {
  let p = lookups.get(path);
  if (!p) {
    p = cmd.thumb_lookup(path).catch(() => null);
    lookups.set(path, p);
  }
  return p;
}

/**
 * The cached thumbnail for `path`. Three states, and the difference matters:
 *
 * - `undefined` — still resolving. Callers should request *nothing* yet. Getting
 *   this wrong means guessing at sibling paths that no longer exist and eating a
 *   404 per tile before the real answer lands.
 * - `string` — use it.
 * - `null` — resolved, and there is no thumbnail. Fall back to the original
 *   (a still) or an icon (a video).
 */
export function useThumbForPath(path: string | null): string | null | undefined {
  const [thumb, setThumb] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!path) {
      setThumb(null);
      return;
    }
    let live = true;
    setThumb(undefined);
    void thumbForPath(path).then((t) => {
      if (live) setThumb(t);
    });
    return () => {
      live = false;
    };
  }, [path]);
  return thumb;
}
