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
