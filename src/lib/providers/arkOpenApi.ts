// BytePlus Ark management OpenAPI — the private asset library (Advanced
// Creation Rights). A different surface from the Ark data plane in
// bytedance.ts: its own host, IAM AK/SK request signing instead of the Bearer
// API key, and an Action/Version RPC shape with a `Result` /
// `ResponseMetadata.Error` envelope.
//
// Signing is BytePlus's OpenAPI "HMAC-SHA256" V4 scheme — the same shape as
// TOS4 in tos.ts but with different constants:
//   - credential scope: {yyyymmdd}/{region}/ark/request
//   - signing key:  HMAC(HMAC(HMAC(HMAC(secret, date), region), "ark"), "request")
//   - the body IS hashed (x-content-sha256), unlike TOS's UNSIGNED-PAYLOAD
//   - signed headers: content-type, host, x-content-sha256, x-date
//
// Only image assets in AIGC (virtual-character) groups are used. Real-human
// LivenessFace groups need an H5 verification flow aiSLAP doesn't implement.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { hmac, sha256Hex, toHex, utf8 } from "./tos";

const HOST = "ark.ap-southeast-1.byteplusapi.com";
const REGION = "ap-southeast-1";
const SERVICE = "ark";
const VERSION = "2024-01-01";
const ALGORITHM = "HMAC-SHA256";

export const ARK_ASSET_DEFAULTS = {
  projectName: "default",
} as const;

/** A failed Action call, keeping the HTTP status and API error code so a
 *  caller can tell throttling (retry later) from a real rejection. */
export class ArkApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ArkApiError";
  }

  /** 429, or a throttling-shaped error code — CreateAsset is rate-limited
   *  per tier (3 / 120 / 300 per minute). */
  get isThrottled(): boolean {
    return this.status === 429 || /throttl|ratelimit|too ?many|qpm|flowlimit/i.test(this.code);
  }
}

export type ArkCreds = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type ArkAsset = {
  Id: string;
  Name?: string;
  GroupId?: string;
  /** `Processing` → `Active` | `Failed`. Only `Active` assets are usable. */
  Status?: string;
  AssetType?: string;
  /** Temporary signed URL — expires; never persist it. */
  URL?: string;
  [k: string]: unknown;
};

type ArkAssetGroup = { Id: string; Name?: string; GroupType?: string };

type Envelope<T> = {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: T;
};

/** One signed Action call. Throws on HTTP failure *and* on a
 *  `ResponseMetadata.Error`, which the API returns with HTTP 200. */
export async function arkOpenApi<T>(
  action: string,
  body: Record<string, unknown>,
  creds: ArkCreds,
  signal?: AbortSignal,
): Promise<T> {
  const payload = JSON.stringify(body);
  const payloadHash = await sha256Hex(payload);
  const query = `Action=${encodeURIComponent(action)}&Version=${VERSION}`;
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = datetime.slice(0, 8);

  const signedHeaders: Record<string, string> = {
    "content-type": "application/json",
    host: HOST,
    "x-content-sha256": payloadHash,
    "x-date": datetime,
  };
  const names = Object.keys(signedHeaders).sort();
  const canonicalRequest = [
    "POST",
    "/",
    query,
    names.map((k) => `${k}:${signedHeaders[k]}`).join("\n") + "\n",
    names.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/request`;
  const stringToSign = [ALGORITHM, datetime, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(utf8(creds.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  // `host` is set by the HTTP client from the URL — don't send it manually.
  const res = await tauriFetch(`https://${HOST}/?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Content-Sha256": payloadHash,
      "X-Date": datetime,
      Authorization:
        `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
    body: payload,
    signal,
  });

  const text = await res.text();
  let json: Envelope<T> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Envelope<T>;
    } catch {
      // handled below — a non-JSON body is only acceptable on success, and
      // there isn't one
    }
  }
  const err = json.ResponseMetadata?.Error;
  if (err?.Code || !res.ok) {
    const detail =
      [err?.Code, err?.Message].filter(Boolean).join(": ") ||
      text.slice(0, 300) ||
      res.statusText;
    throw new ArkApiError(
      `Ark ${action} failed (${res.status}): ${detail}`,
      res.status,
      err?.Code ?? "",
    );
  }
  return (json.Result ?? {}) as T;
}

// Group ids by `${projectName}/${groupName}` — a group is created once and
// looked up by name after that, so cache the lookup for the session.
const groupIds = new Map<string, string>();

/** Find the AIGC group by exact name, creating it if absent. */
export async function ensureAssetGroup(
  creds: ArkCreds,
  groupName: string,
  projectName: string,
  signal?: AbortSignal,
): Promise<string> {
  const cacheKey = `${projectName}/${groupName}`;
  const cached = groupIds.get(cacheKey);
  if (cached) return cached;

  const listed = await arkOpenApi<{ Items?: ArkAssetGroup[] }>(
    "ListAssetGroups",
    { Filter: { GroupType: "AIGC" }, MaxResults: 100, ProjectName: projectName },
    creds,
    signal,
  );
  const matches = (listed.Items ?? []).filter((g) => g.Name === groupName);
  if (matches.length > 1) {
    throw new Error(
      `More than one Ark asset group is named "${groupName}" — rename one in the BytePlus console, or pick another group name in Settings.`,
    );
  }
  let id: string | undefined = matches[0]?.Id;
  if (!id) {
    const created = await arkOpenApi<{ Id?: string }>(
      "CreateAssetGroup",
      {
        Name: groupName,
        Description: "Character references registered from aiSLAP",
        GroupType: "AIGC",
        ProjectName: projectName,
      },
      creds,
      signal,
    );
    id = created.Id;
    if (!id) throw new Error("Ark CreateAssetGroup returned no group id.");
  }
  groupIds.set(cacheKey, id);
  return id;
}
