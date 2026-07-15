import { fal } from "@fal-ai/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { cmd } from "../tauri";
import type {
  Provider,
  ProviderFile,
  ProviderOutput,
  ProviderProgress,
  ProviderRunHooks,
} from "./provider";

const BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const POLL_MS = 5000;
const MAX_POLLS = 240; // ~20 min at POLL_MS=5000 — safety net, not an expected duration
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "expired", "cancelled"]);

type Task = {
  id?: string;
  task_id?: string;
  status: string;
  content?: { video_url?: string };
  error?: { code?: string; message?: string };
};

// api_field -> content[] role, grouped by content "type".
const IMAGE_ROLE_FIELDS: Record<string, string> = {
  reference_image_urls: "reference_image",
  first_frame_url: "first_frame",
  last_frame_url: "last_frame",
};
const VIDEO_ROLE_FIELDS: Record<string, string> = {
  reference_video_urls: "reference_video",
};
const AUDIO_ROLE_FIELDS: Record<string, string> = {
  reference_audio_urls: "reference_audio",
};

// Fields that pass straight through to the request body (not content[]).
const TOP_LEVEL_FIELDS = new Set([
  "resolution",
  "ratio",
  "duration",
  "generate_audio",
  "watermark",
  "seed",
]);

export class BytedanceProvider implements Provider {
  private key = "";

  async prepare(): Promise<void> {
    const key = await cmd.provider_key_get("bytedance").catch(() => "");
    if (!key) throw new Error("BYTEDANCE_API_KEY not configured — open Settings.");
    this.key = key;
  }

  // Confirmed live: Ark validates content[].{video_url,audio_url}.url as a
  // real fetchable web URL — a data: URI is rejected outright, and Ark's own
  // Files API returns an opaque id that's also rejected ("invalid url") when
  // dropped into that field, so there's no ByteDance-native way to host a
  // local video/audio file. Images tolerate a data: URI fine; video/audio
  // route through fal.ai's public object storage instead (requires a
  // FAL_KEY, independent of which provider is actually generating).
  async uploadFile(file: File, _signal: AbortSignal): Promise<string> {
    if (classifyFile(file) === "image") return fileToDataUri(file);
    return this.uploadToFalStorage(file);
  }

  private async uploadToFalStorage(file: File): Promise<string> {
    const falKey = await cmd.provider_key_get("fal").catch(() => "");
    if (!falKey) {
      throw new Error(
        "ByteDance video/audio references need a public URL — configure a FAL_KEY in Settings (used only to host the file via fal.ai storage).",
      );
    }
    fal.config({ credentials: falKey, fetch: tauriFetch as unknown as typeof fetch });
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

    const body = buildRequestBody(endpoint, input);
    let task = await this.request<Task>("POST", BASE_URL, body);
    const taskId = task.id ?? task.task_id;
    if (!taskId) {
      throw new Error(
        `ByteDance task creation returned no id. Raw response: ${JSON.stringify(task).slice(0, 500)}`,
      );
    }
    if (hooks?.onSubmitted) await hooks.onSubmitted(taskId);

    const onAbort = () => {
      void this.request("DELETE", `${BASE_URL}/${taskId}`).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let lastStatus = "";
    let polls = 0;
    try {
      onProgress({ kind: task.status === "running" ? "running" : "queued" });

      // The creation response's `status` isn't reliably one of the known
      // in-progress values (seen undefined on a real task) — loop until a
      // known TERMINAL status shows up instead of gating on "queued"/
      // "running" specifically, so an unrecognized in-progress value still
      // gets polled. MAX_POLLS is a safety net in case the field name is
      // something else entirely (would otherwise spin forever).
      while (!TERMINAL_STATUSES.has(task.status ?? "")) {
        if (++polls > MAX_POLLS) {
          throw new Error(
            `ByteDance task never reached a recognized terminal status after ${MAX_POLLS} polls. Last raw response: ${JSON.stringify(task).slice(0, 500)}`,
          );
        }
        await sleep(POLL_MS, signal);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        task = await this.request<Task>("GET", `${BASE_URL}/${taskId}`);
        if (task.status !== lastStatus) {
          lastStatus = task.status ?? "";
          onProgress({ kind: task.status === "running" ? "running" : "queued" });
        }
      }

      if (task.status === "cancelled") {
        throw new DOMException("aborted", "AbortError");
      }
      if (task.status !== "succeeded") {
        const detail = task.error
          ? [task.error.code, task.error.message].filter(Boolean).join(": ")
          : `ByteDance task ended with status "${task.status}". Raw response: ${JSON.stringify(task).slice(0, 500)}`;
        throw new Error(detail);
      }

      onProgress({ kind: "completed" });
      return unwrap(task);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await tauriFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // leave json as {} — handled below via res.ok check
      }
    }
    if (!res.ok) {
      const errObj = (json as { error?: { message?: string } })?.error;
      const msg = errObj?.message || text.slice(0, 300) || res.statusText;
      throw new Error(`ByteDance API ${method} ${url} failed (${res.status}): ${msg}`);
    }
    return json as T;
  }
}

function buildRequestBody(endpoint: string, input: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const body: Record<string, unknown> = { model: endpoint };

  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    content.push({ type: "text", text: input.prompt });
  }

  for (const [field, role] of Object.entries(IMAGE_ROLE_FIELDS)) {
    for (const url of toUrlList(input[field])) {
      content.push({ type: "image_url", image_url: { url }, role });
    }
  }
  for (const [field, role] of Object.entries(VIDEO_ROLE_FIELDS)) {
    for (const url of toUrlList(input[field])) {
      content.push({ type: "video_url", video_url: { url }, role });
    }
  }
  for (const [field, role] of Object.entries(AUDIO_ROLE_FIELDS)) {
    for (const url of toUrlList(input[field])) {
      content.push({ type: "audio_url", audio_url: { url }, role });
    }
  }

  for (const [k, v] of Object.entries(input)) {
    if (TOP_LEVEL_FIELDS.has(k) && v !== undefined && v !== "") body[k] = v;
  }

  body.content = content;
  return body;
}

function toUrlList(v: unknown): string[] {
  if (typeof v === "string" && v.length > 0) return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return [];
}

function unwrap(task: Task): ProviderOutput {
  const files: ProviderFile[] = [];
  const videoUrl = task.content?.video_url;
  if (videoUrl) files.push({ url: videoUrl, isVideo: true });
  return { files, raw: task };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyFile(file: File): "image" | "video" | "audio" {
  const type = file.type.toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  return "image";
}

async function fileToDataUri(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const type = file.type || "application/octet-stream";
  return `data:${type};base64,${b64}`;
}
