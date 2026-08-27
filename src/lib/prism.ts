/** PRISM Pipeline path conventions. Mirror of `src-tauri/src/commands/prism.rs`.
 *
 *  In a PRISM project aiSLAP writes into `<entity>/Renders/2dRender/AI` — the
 *  pipeline's own 2D render tree, with `AI` as the render product — and that
 *  media root, not the entity folder, is what the session carries as its shot
 *  path, so every gallery/version/tag path below it works unchanged. The cost
 *  is that `basename(shotPath)` reads "AI" instead of the shot name, which is
 *  what `seqShotNames` below is for.
 *
 *  These helpers key off the path suffix rather than session state, so they stay
 *  usable from pure code (filename templates, script matching, thumbnails).
 *
 *  Note this mirrors `prism.rs` only in the entity <-> media-root *direction we
 *  actually need on this side*. The forward mapping (`media_root_for`) has no TS
 *  counterpart on purpose: creating a media root also creates directories, so
 *  `setShot` goes through `cmd.prism_media_root_ensure` rather than deriving the
 *  path locally. */

import { basename, dirname, normalizeDir } from "./paths";

/** Where aiSLAP output lives inside a PRISM entity folder. */
export const AI_MEDIA_SUBPATH = "Renders/2dRender/AI";

/** The pre-v0.5.1 location. Still recognised so a persisted session path, or a
 *  project generated into before the move, resolves to its entity — Rust keeps
 *  writing there for any entity that already has one. */
export const LEGACY_AI_MEDIA_SUBPATH = "Renders/AI";

/** `<entity>/Renders/2dRender/AI` (or the legacy `<entity>/Renders/AI`) ->
 *  `<entity>`, or null when it isn't a media root. */
export function entityFor(path: string): string | null {
  const p = normalizeDir(path);
  for (const sub of [AI_MEDIA_SUBPATH, LEGACY_AI_MEDIA_SUBPATH]) {
    const suffix = `/${sub}`;
    if (p.endsWith(suffix)) return p.slice(0, -suffix.length);
  }
  return null;
}

/** Sequence and shot names for a shot path, whether it's a native shot folder
 *  or a PRISM media root. Used everywhere a display label or a filename token
 *  needs the *entity* names rather than the last two path segments. */
export function seqShotNames(shotPath: string | null | undefined): {
  seq: string;
  shot: string;
} {
  const entity = shotPath ? (entityFor(shotPath) ?? normalizeDir(shotPath)) : "";
  return { seq: basename(dirname(entity)), shot: basename(entity) };
}

/** Same, from a media file's path (`<shot>/<version>/<file>`). */
export function seqShotNamesForMedia(mediaPath: string): {
  seq: string;
  shot: string;
} {
  return seqShotNames(dirname(dirname(mediaPath)));
}
