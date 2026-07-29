import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { cmd } from "../tauri";
import {
  ensureRefLifecycleRule,
  TOS_DEFAULTS,
  uploadToTos,
  type TosConfig,
} from "./tos";
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

// Seedream image generation — a third Ark surface alongside the video task
// API above: synchronous request/response (no task id, no polling), and a
// flat (non content[]-wrapped) body shape of its own.
const IMAGE_GEN_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const IMAGE_GEN_MODELS = new Set(["seedream-5-0-pro", "seedream-5-0-lite"]);

// AI MediaKit (BytePlus VOD) — a separate product from Ark: different host,
// separate API key, flat (non content[]-wrapped) request/response shapes.
// Reuses this same Provider instance since it's still "a ByteDance capability".
const MEDIAKIT_BASE_URL = "https://mediakit.ap-southeast-1.bytepluses.com/api/v1";
const MEDIAKIT_ENHANCE_ENDPOINT = "mediakit-enhance-video";
const MEDIAKIT_TERMINAL_STATUSES = new Set(["completed", "failed"]);
// Only the terminal values are documented; anything else is treated as
// still-running (same defensive style as Ark's TERMINAL_STATUSES above).
const MEDIAKIT_TOP_LEVEL_FIELDS = new Set([
  "video_url",
  "scene",
  "resolution",
  "tool_version",
  "fps",
  "bit_depth",
]);

type Task = {
  id?: string;
  task_id?: string;
  status: string;
  content?: { video_url?: string };
  error?: { code?: string; message?: string };
};

type ImageGenData = {
  url?: string;
  b64_json?: string;
  size?: string;
  error?: { code?: string; message?: string };
};

type ImageGenResponse = {
  data?: ImageGenData[];
  error?: { code?: string; message?: string };
};

type MediaKitTask = {
  task_id?: string;
  status: string;
  result?: {
    video_url?: string;
    duration?: number;
    fps?: number;
    resolution?: string;
    tool_version?: string;
  };
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

// Ensure the ref-expiry lifecycle rule at most once per session — cheap
// insurance, but not worth a GET+PUT round-trip on every submission.
let lifecycleEnsured = false;

export class BytedanceProvider implements Provider {
  private key = "";
  private mediaKitKey = "";
  private tos: TosConfig | null = null;

  async prepare(): Promise<void> {
    const [key, mediaKitKey, ak, sk, cfg] = await Promise.all([
      cmd.provider_key_get("bytedance").catch(() => ""),
      cmd.provider_key_get("bytedance_mediakit").catch(() => ""),
      cmd.provider_key_get("tos_ak").catch(() => ""),
      cmd.provider_key_get("tos_sk").catch(() => ""),
      cmd.config_load().catch(() => null),
    ]);
    // Neither key is required here — Ark and MediaKit are independent APIs
    // sharing this provider instance, so a MediaKit-only (or Ark-only) setup
    // must not be blocked by the other's missing key. Each run*() method
    // throws for its own key at point of use instead.
    this.key = key;
    this.mediaKitKey = mediaKitKey;

    // TOS is only needed to host reference material. A text-only job has no
    // refs and never calls uploadFile, so missing TOS creds must NOT fail
    // prepare() — leave `tos` null and let uploadFile throw if a ref shows up.
    const bucket = cfg?.tos?.bucket || TOS_DEFAULTS.bucket;
    if (!ak || !sk || !bucket) return;

    this.tos = {
      accessKeyId: ak,
      secretAccessKey: sk,
      region: cfg?.tos?.region || TOS_DEFAULTS.region,
      bucket,
      endpoint: cfg?.tos?.endpoint || TOS_DEFAULTS.endpoint,
    };

    // Best-effort: install the expiry rule so uploaded refs don't accumulate.
    // Never block generation on it — uploads work whether or not it succeeds.
    if (!lifecycleEnsured) {
      lifecycleEnsured = true;
      const days = cfg?.tos?.refExpiryDays ?? TOS_DEFAULTS.refExpiryDays;
      void ensureRefLifecycleRule(this.tos, days).catch(() => {
        lifecycleEnsured = false; // let a later submit retry
      });
    }
  }

  // Ark rejects inline data: URIs for reference material — every ref (image,
  // video, audio) must be a fetchable URL. We upload to the user's TOS bucket
  // and hand Ark a presigned GET URL (bucket stays private; refs auto-expire
  // via the lifecycle rule installed in prepare()).
  async uploadFile(file: File, signal: AbortSignal): Promise<string> {
    if (!this.tos) {
      throw new Error(
        "ByteDance references need TOS object storage — configure the TOS Access Key ID, Secret Access Key, and bucket in Settings → APIs.",
      );
    }
    return uploadToTos(file, this.tos, signal);
  }

  async run(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (endpoint === MEDIAKIT_ENHANCE_ENDPOINT) {
      return this.runMediaKit(input, signal, onProgress, hooks);
    }
    if (IMAGE_GEN_MODELS.has(endpoint)) {
      return this.runImageGen(endpoint, input, signal, onProgress);
    }
    return this.runArk(endpoint, input, signal, onProgress, hooks);
  }

  // Seedream images/generations is synchronous — one request, one response,
  // no task id to poll or cancel mid-flight (hence no `hooks`/AbortSignal
  // wiring beyond the pre-flight check: once the request is in-flight there's
  // nothing local to abort).
  private async runImageGen(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.key) throw new Error("BYTEDANCE_API_KEY not configured — open Settings.");

    const body = buildImageGenRequestBody(endpoint, input);
    onProgress({ kind: "running" });
    const res = await this.request<ImageGenResponse>("POST", IMAGE_GEN_BASE_URL, this.key, body);
    if (res.error) {
      throw new Error(
        [res.error.code, res.error.message].filter(Boolean).join(": ") ||
          "ByteDance image generation failed.",
      );
    }
    onProgress({ kind: "completed" });
    return unwrapImageGen(res);
  }

  private async runArk(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.key) throw new Error("BYTEDANCE_API_KEY not configured — open Settings.");

    const body = buildRequestBody(endpoint, input);
    let task = await this.request<Task>("POST", BASE_URL, this.key, body);
    const taskId = task.id ?? task.task_id;
    if (!taskId) {
      throw new Error(
        `ByteDance task creation returned no id. Raw response: ${JSON.stringify(task).slice(0, 500)}`,
      );
    }
    if (hooks?.onSubmitted) await hooks.onSubmitted(taskId);

    const onAbort = () => {
      void this.request("DELETE", `${BASE_URL}/${taskId}`, this.key).catch(() => {});
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
        task = await this.request<Task>("GET", `${BASE_URL}/${taskId}`, this.key);
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

  // AI MediaKit has no documented cancel/delete endpoint — aborting only
  // stops local polling; the task keeps running/billing on BytePlus's side.
  private async runMediaKit(
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.mediaKitKey) {
      throw new Error("BYTEDANCE_MEDIAKIT_API_KEY not configured — open Settings.");
    }

    const body = buildMediaKitRequestBody(input);
    let task = await this.request<MediaKitTask>(
      "POST",
      `${MEDIAKIT_BASE_URL}/tools/enhance-video`,
      this.mediaKitKey,
      body,
    );
    const taskId = task.task_id;
    if (!taskId) {
      throw new Error(
        `MediaKit task creation returned no task_id. Raw response: ${JSON.stringify(task).slice(0, 500)}`,
      );
    }
    if (hooks?.onSubmitted) await hooks.onSubmitted(taskId);

    let lastStatus = "";
    let polls = 0;
    onProgress({ kind: "queued" });

    while (!MEDIAKIT_TERMINAL_STATUSES.has(task.status ?? "")) {
      if (++polls > MAX_POLLS) {
        throw new Error(
          `MediaKit task never reached a recognized terminal status after ${MAX_POLLS} polls. Last raw response: ${JSON.stringify(task).slice(0, 500)}`,
        );
      }
      await sleep(POLL_MS, signal);
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      task = await this.request<MediaKitTask>(
        "GET",
        `${MEDIAKIT_BASE_URL}/tasks/${taskId}`,
        this.mediaKitKey,
      );
      if (task.status !== lastStatus) {
        lastStatus = task.status ?? "";
        onProgress({ kind: "running" });
      }
    }

    if (task.status !== "completed") {
      const detail = task.error
        ? [task.error.code, task.error.message].filter(Boolean).join(": ")
        : `MediaKit task ended with status "${task.status}". Raw response: ${JSON.stringify(task).slice(0, 500)}`;
      throw new Error(detail);
    }

    onProgress({ kind: "completed" });
    return unwrapMediaKit(task);
  }

  private async request<T>(method: string, url: string, key: string, body?: unknown): Promise<T> {
    const res = await tauriFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
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

// Fields that pass straight through to the images/generations body.
// `max_images` is deliberately excluded — Ark only accepts it nested under
// sequential_image_generation_options, handled separately below.
const IMAGE_GEN_TOP_LEVEL_FIELDS = new Set([
  "size",
  "sequential_image_generation",
  "output_format",
  "watermark",
]);

function buildImageGenRequestBody(
  endpoint: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: endpoint, response_format: "url" };

  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    body.prompt = input.prompt;
  }

  const images = toUrlList(input.image_urls);
  if (images.length === 1) body.image = images[0];
  else if (images.length > 1) body.image = images;

  for (const [k, v] of Object.entries(input)) {
    if (IMAGE_GEN_TOP_LEVEL_FIELDS.has(k) && v !== undefined && v !== "") body[k] = v;
  }

  if (body.sequential_image_generation === "auto") {
    const maxImages = Number(input.max_images);
    if (Number.isFinite(maxImages) && maxImages > 0) {
      body.sequential_image_generation_options = { max_images: maxImages };
    }
  }

  return body;
}

function unwrapImageGen(res: ImageGenResponse): ProviderOutput {
  const files: ProviderFile[] = [];
  for (const d of res.data ?? []) {
    if (!d.url) continue; // per-image content-filter failures carry `error` instead of `url`
    const file: ProviderFile = { url: d.url, isVideo: false };
    const m = d.size?.match(/^(\d+)x(\d+)$/);
    if (m) {
      file.width = Number(m[1]);
      file.height = Number(m[2]);
    }
    files.push(file);
  }
  return { files, raw: res };
}

function buildMediaKitRequestBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!MEDIAKIT_TOP_LEVEL_FIELDS.has(k) || v === undefined || v === "") continue;
    // fps=0 means "keep source fps" (the API's own default when omitted) —
    // not a value worth sending.
    if (k === "fps" && v === 0) continue;
    // bit_depth is an enum param (string options) but the API wants an int.
    body[k] = k === "bit_depth" ? Number(v) : v;
  }
  return body;
}

function unwrapMediaKit(task: MediaKitTask): ProviderOutput {
  const files: ProviderFile[] = [];
  const videoUrl = task.result?.video_url;
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

