import type { GalleryImage } from "./types";
import { basename } from "./paths";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
export const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "m4v", "avi"];
export const AUDIO_EXTS = ["mp3", "wav"];
export const MODEL_3D_EXTS = ["glb", "gltf"];
export const MEDIA_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...MODEL_3D_EXTS];

export type MediaKind = "image" | "video" | "audio" | "model3d";

/** Lowercased file extension (without dot), or "" if none. */
export function fileExt(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}

export function classifyMedia(path: string): MediaKind | null {
  const ext = fileExt(path);
  if (!ext) return null;
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  if (MODEL_3D_EXTS.includes(ext)) return "model3d";
  return null;
}

export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.includes(ext.toLowerCase());
}

export function isVideoPath(path: string): boolean {
  return isVideoExt(fileExt(path));
}

/** The thumbnail suffix new poster frames are written with, and the one every
 *  project generated before the switch to JPEG is full of. Mirrors
 *  `THUMB_SUFFIXES` in `commands/fsutil.rs` — keep the two in step. */
export const THUMB_SUFFIXES = [".thumb.jpg", ".thumb.png"];

/** Thumbnail sidecars a video may have, in preference order. Only for callers
 *  that have a bare path and no scanned `GalleryImage`: the gallery already
 *  resolves the real one into `thumbPath`, so prefer that when it exists. */
export function videoThumbCandidates(videoPath: string): string[] {
  const dot = videoPath.lastIndexOf(".");
  const stem = dot >= 0 ? videoPath.slice(0, dot) : videoPath;
  return THUMB_SUFFIXES.map((s) => `${stem}${s}`);
}

/** MIME type for a filename, defaulting to octet-stream. Used when building
 *  File/Blob objects for uploads and clipboard. */
export function guessContentType(filename: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
  };
  return map[fileExt(filename)] ?? "application/octet-stream";
}

/** Build a minimal GalleryImage for a path that isn't in the scanned columns
 *  (e.g. a starred image from another shot, or a ref added mid-session before
 *  the next rescan). Good enough to render — filename/video/3d flags only. */
export function syntheticImage(path: string): GalleryImage {
  const filename = basename(path) || path;
  const ext = fileExt(filename);
  return {
    filename,
    path,
    metadataPath: "",
    isVideo: VIDEO_EXTS.includes(ext),
    isModel3d: MODEL_3D_EXTS.includes(ext),
  };
}
