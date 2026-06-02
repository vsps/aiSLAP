import Replicate from "replicate";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { cmd } from "../tauri";
import {
  isVideoUrl,
  type Provider,
  type ProviderFile,
  type ProviderOutput,
  type ProviderProgress,
  type ProviderRunHooks,
} from "./provider";

type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: unknown;
  logs?: string;
};

const POLL_MS = 1000;
const DATA_URI_LIMIT = 1_000_000; // 1 MB

export class ReplicateProvider implements Provider {
  private client: Replicate | null = null;

  async prepare(): Promise<void> {
    const key = await cmd.provider_key_get("replicate").catch(() => "");
    if (!key) throw new Error("REPLICATE_API_TOKEN not configured — open Settings.");
    this.client = new Replicate({ auth: key, fetch: tauriFetch as unknown as typeof fetch });
  }

  async uploadFile(file: File, _signal: AbortSignal): Promise<string> {
    const client = this.requireClient();
    try {
      const created = await client.files.create(file);
      const url = (created as { urls?: { get?: string } }).urls?.get;
      if (typeof url === "string") return url;
      throw new Error("Replicate Files API returned no URL.");
    } catch (e) {
      if (file.size <= DATA_URI_LIMIT) return await fileToDataUri(file);
      throw new Error(
        `Replicate file upload failed (${file.size} bytes). Files API may be disabled for this workspace. Underlying: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async run(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (e: ProviderProgress) => void,
    hooks?: ProviderRunHooks,
  ): Promise<ProviderOutput> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    const client = this.requireClient();
    const created = await createPrediction(client, endpoint, input);
    let prediction: Prediction = created;
    // Fire the hook with replicate's prediction id — recovery isn't wired
    // for replicate yet, but the persisted record keeps it available.
    if (hooks?.onSubmitted) await hooks.onSubmitted(prediction.id);

    const onAbort = () => {
      void client.predictions.cancel(prediction.id).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let lastStatus = "";
    try {
      // Initial event so the UI flips out of "queued by us".
      onProgress({ kind: prediction.status === "processing" ? "running" : "queued" });

      while (
        prediction.status === "starting" ||
        prediction.status === "processing"
      ) {
        await sleep(POLL_MS, signal);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        prediction = (await client.predictions.get(prediction.id)) as Prediction;
        if (prediction.status !== lastStatus) {
          lastStatus = prediction.status;
          if (prediction.status === "starting") onProgress({ kind: "queued" });
          else if (prediction.status === "processing") onProgress({ kind: "running" });
        }
      }

      if (prediction.status === "canceled") {
        throw new DOMException("aborted", "AbortError");
      }
      if (prediction.status === "failed") {
        const detail = prediction.error
          ? typeof prediction.error === "string"
            ? prediction.error
            : JSON.stringify(prediction.error)
          : "Replicate prediction failed.";
        throw new Error(detail);
      }

      onProgress({ kind: "completed" });
      return unwrap(prediction);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private requireClient(): Replicate {
    if (!this.client) {
      throw new Error("Replicate client not prepared — call prepare() first.");
    }
    return this.client;
  }
}

async function createPrediction(
  client: Replicate,
  endpoint: string,
  input: Record<string, unknown>,
): Promise<Prediction> {
  // Endpoint is "owner/model" or "owner/model:version_hash".
  const colon = endpoint.indexOf(":");
  if (colon >= 0) {
    const version = endpoint.slice(colon + 1);
    const created = await client.predictions.create({ version, input });
    return created as unknown as Prediction;
  }
  // No version pin: use the model-latest path.
  const slash = endpoint.indexOf("/");
  if (slash <= 0) {
    throw new Error(
      `Invalid Replicate endpoint "${endpoint}". Expected "owner/model" or "owner/model:version".`,
    );
  }
  const owner = endpoint.slice(0, slash);
  const name = endpoint.slice(slash + 1);
  const created = await client.predictions.create({
    model: `${owner}/${name}`,
    input,
  } as unknown as Parameters<typeof client.predictions.create>[0]);
  return created as unknown as Prediction;
}

function unwrap(prediction: Prediction): ProviderOutput {
  const files: ProviderFile[] = [];
  const out = prediction.output;

  const collect = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v)) {
      files.push({ url: v, isVideo: isVideoUrl(v) });
    } else if (v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      const url = r["url"];
      if (typeof url === "string") {
        files.push({ url, isVideo: isVideoUrl(url) });
      } else if (Array.isArray(r["images"])) {
        for (const item of r["images"] as unknown[]) collect(item);
      } else if (typeof r["video"] === "string") {
        files.push({ url: r["video"] as string, isVideo: true });
      }
    }
  };

  if (Array.isArray(out)) {
    for (const v of out) collect(v);
  } else {
    collect(out);
  }

  return { files, raw: prediction };
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

async function fileToDataUri(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const type = file.type || "application/octet-stream";
  return `data:${type};base64,${b64}`;
}
