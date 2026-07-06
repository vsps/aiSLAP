import { fal } from "@fal-ai/client";
import type { QueueStatus } from "@fal-ai/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { cmd } from "../tauri";
import type { FalLifecycle } from "../types";
import {
  isVideoUrl,
  type Provider,
  type ProviderFile,
  type ProviderOutput,
  type ProviderProgress,
  type ProviderRunHooks,
} from "./provider";

export class FalProvider implements Provider {
  private lifecycle: FalLifecycle | undefined;

  async prepare(): Promise<void> {
    const [key, cfg] = await Promise.all([
      cmd.provider_key_get("fal").catch(() => ""),
      cmd.config_load().catch(() => null),
    ]);
    if (!key) throw new Error("FAL_KEY not configured — open Settings.");
    fal.config({ credentials: key, fetch: tauriFetch as unknown as typeof fetch });
    this.lifecycle = cfg?.falLifecycle;
  }

  async uploadFile(file: File, _signal: AbortSignal): Promise<string> {
    return fal.storage.upload(file);
  }

  async run(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    const enqueued = await fal.queue.submit(endpoint, {
      input,
      abortSignal: signal,
      ...(this.lifecycle ? { storageSettings: { expiresIn: this.lifecycle } } : {}),
    });
    const requestId = enqueued.request_id;
    // Fire the hook before we start waiting — gives the caller a chance to
    // persist a recovery record while the request is in fal's queue.
    if (hooks?.onSubmitted) await hooks.onSubmitted(requestId);

    emitProgress(enqueued, onProgress);

    const onAbort = () => {
      void fal.queue.cancel(endpoint, { requestId }).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await fal.queue.subscribeToStatus(endpoint, {
        requestId,
        mode: "polling",
        pollInterval: 1000,
        onQueueUpdate: (u) => emitProgress(u, onProgress),
        abortSignal: signal,
      });
      const res = await fal.queue.result(endpoint, { requestId, abortSignal: signal });
      return unwrapFalOutput(res.data);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** One-shot status check — used by the orphan-recovery driver. */
export async function falQueueStatus(
  endpoint: string,
  requestId: string,
): Promise<"IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "UNKNOWN"> {
  const s = await fal.queue.status(endpoint, { requestId });
  if (s.status === "IN_QUEUE") return "IN_QUEUE";
  if (s.status === "IN_PROGRESS") return "IN_PROGRESS";
  if (s.status === "COMPLETED") return "COMPLETED";
  return "UNKNOWN";
}

/** Fetch a completed request's result. */
export async function falQueueResult(
  endpoint: string,
  requestId: string,
): Promise<ProviderOutput> {
  const res = await fal.queue.result(endpoint, { requestId });
  return unwrapFalOutput(res.data);
}

function emitProgress(u: QueueStatus, onProgress: (e: ProviderProgress) => void): void {
  if (u.status === "IN_QUEUE") {
    onProgress({ kind: "queued", position: u.queue_position });
  } else if (u.status === "IN_PROGRESS") {
    onProgress({ kind: "running" });
  } else if (u.status === "COMPLETED") {
    onProgress({ kind: "completed" });
  }
}

export function unwrapFalOutput(result: unknown): ProviderOutput {
  const r = (result ?? {}) as Record<string, unknown>;
  const files: ProviderFile[] = [];

  const video = r["video"] as { url?: string } | undefined;
  if (video && typeof video.url === "string") {
    files.push({ url: video.url, isVideo: true });
    return { files, raw: result };
  }

  const model3d = r["model_glb"] as { url?: string } | undefined;
  if (model3d && typeof model3d.url === "string") {
    // Meshy uses `thumbnail`; SAM3 3D nodes expose `visualization` instead.
    const thumbUrl =
      (r["thumbnail"] as { url?: string } | undefined)?.url ??
      (r["visualization"] as { url?: string } | undefined)?.url;
    files.push({ url: model3d.url, isVideo: false, isModel3d: true, thumbUrl });
    return { files, raw: result };
  }

  // SAM3 image segmentation returns a `masks` array of image files.
  const masks = r["masks"];
  if (Array.isArray(masks) && masks.length > 0) {
    for (const m of masks as { url?: string }[]) {
      if (m?.url) files.push({ url: m.url, isVideo: false });
    }
    if (files.length > 0) return { files, raw: result };
  }

  // SAM3 image/embed returns a base64 embedding string — no media URL.
  const embedding = r["embedding_b64"];
  if (typeof embedding === "string" && embedding.length > 0) {
    files.push({ url: "", isVideo: false, inlineText: embedding });
    return { files, raw: result };
  }

  const imagesField = r["images"];
  const single = r["image"] as { url?: string } | undefined;
  const images: { url?: string }[] = Array.isArray(imagesField)
    ? (imagesField as { url?: string }[])
    : single && typeof single.url === "string"
    ? [single]
    : [];

  for (const img of images) {
    if (!img?.url) continue;
    files.push({ url: img.url, isVideo: isVideoUrl(img.url) });
  }
  return { files, raw: result };
}
