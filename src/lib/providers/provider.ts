// Provider abstraction. Hides SDK differences so runJob stays single-purpose.

import { isVideoExt } from "../media";

export type ProviderProgress =
  | { kind: "queued"; position?: number }
  | { kind: "running" }
  | { kind: "completed" };

export type ProviderFile = {
  url: string;
  isVideo: boolean;
  isModel3d?: boolean;
  thumbUrl?: string;
  /** Pixel dimensions, when the provider's response includes them. Lets
   *  downloadAndWrite pick the highest-resolution image by actual size
   *  rather than array position when a response returns more files than
   *  were requested (some "thinking" image models include a lower-res
   *  preview alongside the final image — see output.ts). */
  width?: number;
  height?: number;
  /** Inline text payload (no URL) written verbatim to a .txt sidecar — used
   *  for non-media outputs like SAM3 image embeddings (base64). */
  inlineText?: string;
};

export type ProviderOutput = {
  /** Normalized list of media URLs the API produced. */
  files: ProviderFile[];
  /** Original SDK payload, written into image metadata as `providerResponse`. */
  raw: unknown;
};

export interface Provider {
  /** Validate auth + configure the SDK. Throws with a user-facing message if not ready. */
  prepare(): Promise<void>;

  /** Upload a local file; return a URL the API can fetch. */
  uploadFile(file: File, signal: AbortSignal): Promise<string>;

  /** Submit, poll, and return normalized output. Surfaces queue events via `onProgress`.
   *  `hooks.onSubmitted(requestId)` fires the moment the provider returns a
   *  request id (used by the orphan-recovery layer to persist a record before
   *  we await the result). Optional. */
  run(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput>;
}

export type ProviderRunHooks = {
  onSubmitted?: (requestId: string) => void | Promise<void>;
};

export type ProviderName = "fal" | "replicate" | "bytedance";

export function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    if (!m) return false;
    return isVideoExt(m[1]);
  } catch {
    return false;
  }
}
