// BytePlus TOS (Torch Object Storage) SigV4 client — used to host ByteDance
// reference material as fetchable URLs (Ark rejects inline data: URIs for refs).
//
// Signing is Volcengine/BytePlus's "TOS4-HMAC-SHA256" scheme (AWS-SigV4 shape,
// different constants), verified against the official ve-tos-js-sdk:
//   - credential scope: {yyyymmdd}/{region}/tos/request   (terminator "request")
//   - signing key:  HMAC(HMAC(HMAC(HMAC(secret, date), region), "tos"), "request")
//     (secret is NOT prefixed, unlike AWS's "AWS4" prefix)
//   - x-tos-content-sha256 is always "UNSIGNED-PAYLOAD" (bodies are never hashed)
//   - only `host` and `x-tos-*` headers are signed
//
// All hashing/HMAC uses Web Crypto; the network round-trips go through the
// Rust-backed tauriFetch (bypasses CORS), matching the other providers.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const ALGORITHM = "TOS4-HMAC-SHA256";
const SERVICE = "tos";
const UNSIGNED = "UNSIGNED-PAYLOAD";

const REF_PREFIX = "aislap/refs/";
const RULE_ID = "aislap-refs-expiry";
const PRESIGN_EXPIRES_SEC = 86400; // 24h — Ark fetches within seconds/minutes

export type TosConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  /** Host suffix, e.g. "tos-ap-southeast-1.bytepluses.com". */
  endpoint: string;
};

export const TOS_DEFAULTS = {
  bucket: "heck-store",
  region: "ap-southeast-1",
  endpoint: "tos-ap-southeast-1.bytepluses.com",
  refExpiryDays: 1,
} as const;

/** Upload a file to the bucket under the aislap/refs/ prefix and return a
 *  presigned GET URL Ark can fetch (bucket may stay fully private). */
export async function uploadToTos(
  file: File,
  cfg: TosConfig,
  signal?: AbortSignal,
): Promise<string> {
  const ext = extOf(file.name);
  const key = `${REF_PREFIX}${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;
  const body = new Uint8Array(await file.arrayBuffer());
  const contentType = file.type || "application/octet-stream";

  const res = await signedFetch(
    cfg,
    "PUT",
    key,
    {},
    { "content-type": contentType },
    body,
    signal,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `TOS upload failed (${res.status}) for ${key}: ${text.slice(0, 300) || res.statusText}`,
    );
  }
  return presignGet(cfg, key);
}

/** Idempotently install a lifecycle rule that expires everything under the
 *  aislap/refs/ prefix after `days` days. PutBucketLifecycle overwrites the
 *  whole rule set, so read-merge-write to preserve any unrelated rules. */
export async function ensureRefLifecycleRule(cfg: TosConfig, days: number): Promise<void> {
  const getRes = await signedFetch(cfg, "GET", "", { lifecycle: "" }, {}, undefined);

  let rules: Record<string, unknown>[] = [];
  if (getRes.ok) {
    const text = await getRes.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as { Rules?: Record<string, unknown>[] };
        if (Array.isArray(parsed.Rules)) rules = parsed.Rules;
      } catch {
        // Non-JSON body — treat as no existing rules rather than clobber blindly.
      }
    }
  } else if (getRes.status !== 404) {
    // 404 == NoSuchLifecycleConfiguration (fresh bucket) — anything else is real.
    const text = await getRes.text().catch(() => "");
    throw new Error(
      `TOS GetBucketLifecycle failed (${getRes.status}): ${text.slice(0, 300) || getRes.statusText}`,
    );
  }

  rules = rules.filter((r) => r?.ID !== RULE_ID);
  rules.push({
    ID: RULE_ID,
    Prefix: REF_PREFIX,
    Status: "Enabled",
    Expiration: { Days: days },
  });

  const putRes = await signedFetch(
    cfg,
    "PUT",
    "",
    { lifecycle: "" },
    { "content-type": "application/json" },
    JSON.stringify({ Rules: rules }),
  );
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(
      `TOS PutBucketLifecycle failed (${putRes.status}): ${text.slice(0, 300) || putRes.statusText}`,
    );
  }
}

// ---------- signing core ----------

function hostFor(cfg: TosConfig): string {
  return `${cfg.bucket}.${cfg.endpoint}`;
}

/** Header-authenticated request (PUT object, GET/PUT bucket sub-resource). */
async function signedFetch(
  cfg: TosConfig,
  method: string,
  key: string,
  query: Record<string, string>,
  extraHeaders: Record<string, string>,
  body: Uint8Array | string | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const host = hostFor(cfg);
  const { datetime, dateStamp } = stamp();

  const headers: Record<string, string> = {
    host,
    "x-tos-content-sha256": UNSIGNED,
    "x-tos-date": datetime,
    ...extraHeaders,
  };

  const signable = Object.keys(headers)
    .filter((k) => k === "host" || k.startsWith("x-tos-"))
    .sort();
  const canonicalHeaders = signable.map((k) => `${k}:${normValue(headers[k])}`).join("\n");
  const signedHeaders = signable.join(";");
  const canonicalQuery = canonicalQueryString(query);
  const encodedPath = encodePath(key);

  const canonicalRequest = [
    method,
    encodedPath,
    canonicalQuery,
    canonicalHeaders,
    "",
    signedHeaders,
    UNSIGNED,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/request`;
  const stringToSign = [ALGORITHM, datetime, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await deriveSigningKey(cfg.secretAccessKey, dateStamp, cfg.region);
  const signature = toHex(await hmac(signingKey, stringToSign));
  const authorization =
    `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${encodedPath}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  // `host` is set by the HTTP client from the URL — don't send it manually.
  const sendHeaders: Record<string, string> = {
    Authorization: authorization,
    "x-tos-content-sha256": UNSIGNED,
    "x-tos-date": datetime,
    ...extraHeaders,
  };

  return tauriFetch(url, { method, headers: sendHeaders, body, signal });
}

/** Presigned GET URL — auth lives entirely in the query string, payload
 *  UNSIGNED, only `host` signed. */
async function presignGet(cfg: TosConfig, key: string): Promise<string> {
  const host = hostFor(cfg);
  const { datetime, dateStamp } = stamp();
  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/request`;

  const query: Record<string, string> = {
    "X-Tos-Algorithm": ALGORITHM,
    "X-Tos-Content-Sha256": UNSIGNED,
    "X-Tos-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Tos-Date": datetime,
    "X-Tos-Expires": String(PRESIGN_EXPIRES_SEC),
    "X-Tos-SignedHeaders": "host",
  };

  const canonicalQuery = canonicalQueryString(query);
  const encodedPath = encodePath(key);
  const canonicalRequest = [
    "GET",
    encodedPath,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    UNSIGNED,
  ].join("\n");

  const stringToSign = [ALGORITHM, datetime, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await deriveSigningKey(cfg.secretAccessKey, dateStamp, cfg.region);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const finalQuery = `${canonicalQuery}&${uriEscape("X-Tos-Signature")}=${uriEscape(signature)}`;
  return `https://${host}${encodedPath}?${finalQuery}`;
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8(secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, "request");
}

// ---------- primitives ----------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, utf8(data));
}

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(s)));
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** RFC-3986 escape (AWS-style): encodeURIComponent plus !*'() . */
function uriEscape(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(key: string): string {
  if (!key) return "/";
  return `/${key.split("/").map(uriEscape).join("/")}`;
}

function canonicalQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  return keys.map((k) => `${uriEscape(k)}=${uriEscape(query[k])}`).join("&");
}

function normValue(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stamp(): { datetime: string; dateStamp: string } {
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { datetime, dateStamp: datetime.slice(0, 8) };
}
