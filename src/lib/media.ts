export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"];
export const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv"];
export const AUDIO_EXTS = ["mp3", "wav"];
export const MEDIA_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS];

export type MediaKind = "image" | "video" | "audio";

export function classifyMedia(path: string): MediaKind | null {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return null;
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}
