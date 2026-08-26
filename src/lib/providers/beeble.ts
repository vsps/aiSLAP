import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { cmd } from "../tauri";
import type {
  Provider,
  ProviderFile,
  ProviderOutput,
  ProviderProgress,
  ProviderRunHooks,
} from "./provider";

// Beeble (beeble.ai) — SwitchX relighting / background replacement.
// Docs: https://developer.beeble.ai/docs
//
// Three things make this provider shorter than the others:
//   * one product, one submit endpoint, one status endpoint;
//   * uploads are presigned-PUT, so no SDK and no separate object store
//     (contrast bytedance, which needs TOS);
//   * auth is a bare `x-api-key` header, not a bearer token.
//
// What it does NOT report is cost: the generation response carries no price, so
// outputs land with `costUsd` absent and the project rollup counts them as
// unknown. Beeble bills in credits off-API (`/v1/account/billing`), and guessing
// a dollar figure from a credit count would be worse than saying nothing.

const BASE_URL = "https://api.beeble.ai/v1";
const POLL_MS = 4000;
const MAX_POLLS = 300; // ~20 min — safety net, not an expected duration
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/** Endpoint sentinels. The node's `endpoint` is the *only* thing that decides
 *  `generation_type`, rather than it being a user-facing parameter: the two are
 *  not interchangeable (a video source cannot produce a still), and the model
 *  file's `outputs` already has to agree with it for `kind` inference to put
 *  the result in the right viewer. One source of truth, in the model file. */
const ENDPOINT_GENERATION_TYPE: Record<string, "image" | "video"> = {
  "switchx-image": "image",
  "switchx-video": "video",
};

/** Fields `buildArgs` may produce that belong in the request verbatim. Anything
 *  else in `input` is dropped rather than forwarded — the API rejects unknown
 *  fields, and a stray setting from a previously-selected model is exactly the
 *  kind of thing that would otherwise leak in. */
const PASSTHROUGH_FIELDS = new Set([
  "prompt",
  "alpha_mode",
  "alpha_keyframe_index",
  "seed",
  "max_resolution",
]);

/** Fields that must be a single URI string, though the ref plumbing hands them
 *  over as arrays when more than one ref is attached. */
const URI_FIELDS = ["source_uri", "reference_image_uri", "alpha_uri"] as const;

type UploadResponse = {
  id: string;
  upload_url: string;
  beeble_uri: string;
};

type SwitchXStatus = {
  id: string;
  status: string;
  progress?: number | null;
  generation_type?: string | null;
  alpha_mode?: string | null;
  output?: {
    /** Composited result — the actual deliverable. */
    render?: string | null;
    /** Preprocessed source, and the extracted matte. Left in `raw` (and so in
     *  the sidecar's providerResponse) rather than returned as outputs: they
     *  are diagnostic, and returning them would put three tiles in the gallery
     *  for every generation. Signed URLs expire after 72h. */
    source?: string | null;
    alpha?: string | null;
  } | null;
  seed?: number | null;
  error?: string | null;
};

export class BeebleProvider implements Provider {
  private key = "";

  async prepare(): Promise<void> {
    this.key = await cmd.provider_key_get("beeble").catch(() => "");
    if (!this.key) {
      throw new Error(
        "BEEBLE_API_KEY not configured — open Settings → APIs. Create a key at developer.beeble.ai/api-keys.",
      );
    }
  }

  /**
   * Presigned-PUT upload. Three steps: ask for a URL, PUT the bytes, hand back
   * the `beeble://` URI the generation endpoint wants.
   *
   * The returned URI is what goes into `source_uri` / `reference_image_uri` /
   * `alpha_uri`, so this is also why those fields never see an `asset://` path.
   */
  async uploadFile(file: File, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.key) await this.prepare();

    const slot = await this.request<UploadResponse>(
      "POST",
      `${BASE_URL}/uploads`,
      { filename: uploadFilename(file.name) },
    );

    const put = await tauriFetch(slot.upload_url, {
      method: "PUT",
      // The presigned URL signs the method and path, not our headers — but S3
      // still stores whatever Content-Type we send, and the wrong one comes
      // back to bite when the API re-fetches the object.
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: new Uint8Array(await file.arrayBuffer()),
      signal,
    });
    if (!put.ok) {
      throw new Error(
        `Beeble upload of ${file.name} failed (${put.status}): ${put.statusText}`,
      );
    }
    return slot.beeble_uri;
  }

  async run(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.key) await this.prepare();

    const body = buildRequestBody(endpoint, input);
    let job = await this.request<SwitchXStatus>(
      "POST",
      `${BASE_URL}/switchx/generations`,
      body,
    );
    if (!job.id) {
      throw new Error(
        `Beeble returned no job id. Raw response: ${JSON.stringify(job).slice(0, 500)}`,
      );
    }
    if (hooks?.onSubmitted) await hooks.onSubmitted(job.id);

    let polls = 0;
    onProgress({ kind: job.status === "processing" ? "running" : "queued" });
    let lastStatus = job.status;

    // Loop until a *known terminal* status shows up rather than while the status
    // looks in-progress, so an undocumented intermediate value still gets
    // polled instead of being mistaken for completion. MAX_POLLS is the guard
    // against that going on forever.
    while (!TERMINAL_STATUSES.has(job.status ?? "")) {
      if (++polls > MAX_POLLS) {
        throw new Error(
          `Beeble job ${job.id} never reached a terminal status after ${MAX_POLLS} polls (last: ${job.status}).`,
        );
      }
      await sleep(POLL_MS, signal);
      job = await this.request<SwitchXStatus>(
        "GET",
        `${BASE_URL}/switchx/generations/${job.id}`,
      );
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        onProgress({ kind: job.status === "processing" ? "running" : "queued" });
      }
    }

    if (job.status === "failed") {
      throw new Error(job.error || `Beeble job ${job.id} failed.`);
    }

    const render = job.output?.render;
    if (!render) {
      throw new Error(
        `Beeble job ${job.id} completed with no render URL. Raw response: ${JSON.stringify(job).slice(0, 500)}`,
      );
    }

    onProgress({ kind: "completed" });
    const isVideo =
      (job.generation_type ?? ENDPOINT_GENERATION_TYPE[endpoint]) === "video";
    const files: ProviderFile[] = [{ url: render, isVideo }];
    // No `requestId`: that field exists for fal's billing-events lookup, and
    // Beeble has no equivalent. The job id is in `raw` either way.
    return { files, raw: job };
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    const res = await tauriFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.key,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // leave json as {} — handled below via res.ok
      }
    }
    if (!res.ok) {
      const j = json as { detail?: unknown; error?: unknown; message?: string };
      const msg =
        stringifyDetail(j.detail) ||
        stringifyDetail(j.error) ||
        j.message ||
        text.slice(0, 300) ||
        res.statusText;
      throw new Error(`Beeble API ${method} ${url} failed (${res.status}): ${msg}`);
    }
    return json as T;
  }
}

/** FastAPI reports validation errors as `detail: [{loc, msg, type}]` and other
 *  errors as `detail: "…"`. Flatten either into one line so a 422 says which
 *  field was wrong instead of `[object Object]`. */
function stringifyDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const e = d as { loc?: unknown[]; msg?: string };
        const where = Array.isArray(e.loc) ? e.loc.join(".") : "";
        return [where, e.msg].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

/** The upload endpoint validates `filename` at 3–255 chars with a recognised
 *  extension. aiSLAP filenames are long but well under the cap; a pathological
 *  one gets truncated from the *front* so the extension survives. */
function uploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "upload.png";
  if (base.length <= 255) return base.length >= 3 ? base : `ref_${base}`;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return base.slice(0, 255 - ext.length) + ext;
}

export function buildRequestBody(
  endpoint: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const generationType = ENDPOINT_GENERATION_TYPE[endpoint];
  if (!generationType) {
    throw new Error(`Unknown Beeble endpoint "${endpoint}".`);
  }

  const body: Record<string, unknown> = { generation_type: generationType };

  for (const field of URI_FIELDS) {
    const uri = firstUri(input[field]);
    if (uri) body[field] = uri;
  }

  for (const [k, v] of Object.entries(input)) {
    if (!PASSTHROUGH_FIELDS.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    body[k] = v;
  }

  // Declared as an enum in the model files so the settings panel offers a
  // two-value dropdown instead of a spinner over an invalid range — but the
  // API's field is an integer, so undo the string here.
  if (typeof body.max_resolution === "string") {
    const n = Number(body.max_resolution);
    if (Number.isFinite(n)) body.max_resolution = n;
    else delete body.max_resolution;
  }

  // `alpha_mode` is required by the API and every node declares it with a
  // default, so a missing value means the settings object was hand-edited or
  // came from an older sidecar. "auto" is the same default the model files use.
  if (typeof body.alpha_mode !== "string") body.alpha_mode = "auto";

  // `alpha_keyframe_index` is only meaningful for video "select" mode; sending
  // it otherwise is a 422 waiting to happen.
  if (
    body.alpha_mode !== "select" ||
    generationType !== "video"
  ) {
    delete body.alpha_keyframe_index;
  }

  if (!body.source_uri) {
    throw new Error(
      "SwitchX needs a source: attach the image or video to transform and give it the `source` role.",
    );
  }
  if (!body.prompt && !body.reference_image_uri) {
    throw new Error(
      "SwitchX needs either a prompt or a reference image — attach a reference and give it the `image` role, or type a prompt.",
    );
  }
  if (
    (body.alpha_mode === "custom" || body.alpha_mode === "select") &&
    !body.alpha_uri
  ) {
    throw new Error(
      `SwitchX alpha_mode "${body.alpha_mode}" needs an alpha matte — attach one and give it the \`alpha\` role, or switch to "auto".`,
    );
  }

  return body;
}

/** Refs arrive as a bare string when one is attached and an array when several
 *  are; these API fields take exactly one URI. */
function firstUri(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" && x.length > 0);
    return typeof first === "string" ? first : null;
  }
  return null;
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
