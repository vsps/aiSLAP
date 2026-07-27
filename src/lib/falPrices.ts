// Per-endpoint prices from fal's official Platform APIs
// (https://fal.ai/docs/platform-apis/v1/models/pricing). Requires the same
// FAL_KEY already configured for generation. Because it's an authenticated
// call, fetching is user-triggered (Settings button) and results are
// persisted to config — never fetched implicitly at startup.
//
// A companion endpoint, /models/pricing/estimate, is used separately at
// generation time (see estimateGenerationCost, consumed by
// lib/generation/output.ts) to get fal's own authoritative cost for a
// specific completed job rather than the local per-item multiplication this
// file also provides as a fallback.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { pushLog } from "../stores/logStore";

const PRICING_URL = "https://api.fal.ai/v1/models/pricing";
const ESTIMATE_URL = "https://api.fal.ai/v1/models/pricing/estimate";
const MAX_IDS_PER_REQUEST = 50;

type PricingEntry = {
  endpoint_id?: string;
  unit_price?: number;
  unit?: string;
  currency?: string;
};

type PricingPage = {
  prices?: PricingEntry[];
  next_cursor?: string | null;
  has_more?: boolean;
};

type ApiErrorBody = { error?: { message?: string } };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error?.message) return body.error.message;
  } catch {
    // fall through to statusText
  }
  return res.statusText || `HTTP ${res.status}`;
}

/** Fetch official per-endpoint prices for every distinct id in `endpoints`.
 *  Endpoints fal doesn't price (or that don't exist) are simply absent from
 *  the result. A 401/429 aborts the whole call (bad key / rate limited —
 *  retrying other chunks won't help); any other per-chunk failure is logged
 *  and skipped so a partial result still comes back rather than throwing
 *  away everything already collected. */
export async function fetchFalPrices(
  endpoints: string[],
  apiKey: string,
): Promise<Record<string, string>> {
  const unique = [...new Set(endpoints)];
  const out: Record<string, string> = {};
  if (unique.length === 0) return out;

  let anyChunkFailed = false;

  for (const ids of chunk(unique, MAX_IDS_PER_REQUEST)) {
    let cursor: string | null = null;
    do {
      const url = new URL(PRICING_URL);
      url.searchParams.set("endpoint_id", ids.join(","));
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await tauriFetch(url.toString(), {
        headers: { Authorization: `Key ${apiKey}` },
      });

      if (!res.ok) {
        const msg = await readErrorMessage(res);
        if (res.status === 401 || res.status === 429) {
          throw new Error(`fal pricing API: ${msg}`);
        }
        pushLog("INFO", `fal pricing API chunk failed: ${msg}`);
        anyChunkFailed = true;
        break;
      }

      let page: PricingPage;
      try {
        page = (await res.json()) as PricingPage;
      } catch {
        pushLog("INFO", "fal pricing API: malformed JSON response");
        anyChunkFailed = true;
        break;
      }

      for (const entry of page.prices ?? []) {
        const priceStr = synthesizePriceString(entry);
        if (priceStr && entry.endpoint_id) out[entry.endpoint_id] = priceStr;
      }

      cursor = page.has_more ? (page.next_cursor ?? null) : null;
    } while (cursor);
  }

  if (Object.keys(out).length === 0 && anyChunkFailed) {
    throw new Error("fal pricing API: no prices could be fetched — see log for details.");
  }
  return out;
}

/** Build the "$X per Y" string every downstream consumer expects
 *  (parseFalPrice's `\$\s*(\d+(?:\.\d+)?)(?:[^.,]*?\bper\s+([^,.]+))?` regex),
 *  from a structured pricing entry. Returns null for anything that can't be
 *  trusted: missing fields, a non-finite/negative amount, a non-USD currency
 *  (every consumer hardcodes "$" — silently mislabeling a foreign amount
 *  would be a real bug), or a unit containing punctuation that would
 *  truncate the regex's capture group. */
function synthesizePriceString(entry: PricingEntry): string | null {
  const { endpoint_id, unit_price, unit, currency } = entry;
  if (!endpoint_id || !unit) return null;
  if (typeof unit_price !== "number" || !Number.isFinite(unit_price) || unit_price < 0) return null;
  if (currency && currency !== "USD") return null;
  if (/[,.]/.test(unit)) return null;
  return `$${formatUnitPrice(unit_price)} per ${unit}`;
}

/** Format a per-unit price for storage/parsing (not display — see
 *  formatCost for that). Scales decimal places to magnitude so a real
 *  sub-cent price (common for cheap per-second video billing) doesn't round
 *  to "0.000" and silently become free forever, then trims trailing zeros.
 *  Always emits plain decimal notation (never scientific), matching
 *  parseFalPrice's `\d+(?:\.\d+)?` expectation. */
export function formatUnitPrice(n: number): string {
  const decimals = n < 0.01 ? 6 : n < 1 ? 4 : 2;
  let s = n.toFixed(decimals);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// Sub-cent prices need more decimals than dollars-and-cents formatting gives.
export function formatCost(n: number): string {
  return n < 0.1 ? n.toFixed(3) : n.toFixed(2);
}

export type ParsedPrice = { amount: number; unit: string };

/** Extract the first "$X per <unit>" from a price string. Returns null when
 *  no dollar amount is present. `unit` is the lowercased phrase after "per"
 *  (up to the next comma/period), e.g. "request", "second", "16 frames". */
export function parseFalPrice(text: string): ParsedPrice | null {
  const m = text.match(/\$\s*(\d+(?:\.\d+)?)(?:[^.,]*?\bper\s+([^,.]+))?/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: (m[2] ?? "").trim().toLowerCase() };
}

/** Units where one billed unit == one output, so a submit-time total can be
 *  computed as amount × runs. Time/size-based units (second, megapixel,
 *  frames) depend on the output and only get a unit-price label. */
export function isPerItemUnit(unit: string): boolean {
  return /^(request|image|video|unit|generation)s?\b/.test(unit);
}

/** Seconds-billed units — almost every video model. Distinct from
 *  isPerItemUnit() because the total depends on the output's actual
 *  duration, not a flat per-run amount. */
export function isPerSecondUnit(unit: string): boolean {
  return /^sec(ond)?s?\b/.test(unit);
}

/** Area-billed units — fal's official pricing API reports "megapixels" for
 *  e.g. the FLUX family and Topaz image upscale. Distinct from
 *  isPerItemUnit()/isPerSecondUnit() because the total depends on the
 *  output's actual pixel dimensions, not a flat amount or a duration. */
export function isPerAreaUnit(unit: string): boolean {
  return /^megapixels?\b/.test(unit);
}

/** Parse a `duration` setting value to seconds. Handles the numeric,
 *  numeric-string, and suffixed-string ("8s") shapes used across the model
 *  registry. Returns null for non-numeric values (e.g. seedance-2's "auto"),
 *  where the actual output length isn't knowable from settings alone. */
export function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const m = raw.match(/^(\d+(?:\.\d+)?)/);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export type CostContext = {
  /** True when the actual output is a video — a per-second price (fetched or
   *  overridden) only resolves to a total when this is set. */
  isVideo?: boolean;
  /** Output duration in seconds, from the generation's `duration` setting
   *  (see parseDurationSeconds). Null/undefined when unknown. */
  durationSec?: number | null;
  /** The generation's `resolution` setting, for models priced per-resolution.
   *  Overrides are keyed `${endpoint}::${resolution}` when the user entered a
   *  tiered override, falling back to the flat `${endpoint}` key otherwise —
   *  fal's own pricing API has no per-resolution breakdown (see falPrices.ts
   *  header), so a fetched price is always the flat key. */
  resolution?: string | null;
  /** Actual output pixel count / 1,000,000, for area-billed units (see
   *  isPerAreaUnit) — measured from the real output file (see
   *  lib/generation/output.ts), never guessed from a named size preset.
   *  Null/undefined when unknown. */
  megapixels?: number | null;
};

/** Per-output price for one endpoint, from the local cache. A user-entered
 *  override (Settings -> Costs) always wins when present — it's the only way
 *  to price non-fal models, or a specific resolution, since only fal has a
 *  pricing API and only at the model level. An override is always treated as
 *  a terminal exact value: flat for images, $/sec × `ctx.durationSec` for
 *  video — never scaled by `ctx.megapixels`, since the point of an override
 *  is "use this exact number," not "apply this formula." A fetched (non-
 *  override) price, by contrast, is resolved by its reported unit: flat
 *  (isPerItemUnit), $/sec × duration (isPerSecondUnit), or $/megapixel ×
 *  `ctx.megapixels` (isPerAreaUnit) — whichever multiplier isn't available
 *  for the unit in question (e.g. no known duration, or no measured
 *  megapixels) leaves the price unresolved (null).
 *
 *  This is the FALLBACK path for fal outputs — lib/generation/output.ts
 *  prefers a live estimateGenerationCost() result when one succeeded, and
 *  only falls back to this local computation when it didn't (missing key,
 *  network error, non-fal provider, or an endpoint fal's pricing API doesn't
 *  know about all collapse to the same fallback). */
export function perItemPrice(
  provider: string | undefined,
  endpoint: string,
  prices: Record<string, string>,
  overrides?: Record<string, number>,
  ctx?: CostContext,
): number | null {
  const overrideKey = ctx?.resolution ? `${endpoint}::${ctx.resolution}` : endpoint;
  const override = overrides?.[overrideKey] ?? (ctx?.resolution ? overrides?.[endpoint] : undefined);
  if (override != null && Number.isFinite(override)) {
    if (!ctx?.isVideo) return override;
    return ctx.durationSec != null ? override * ctx.durationSec : null;
  }
  if ((provider ?? "fal") !== "fal") return null;
  const text = prices[overrideKey] ?? prices[endpoint];
  if (!text) return null;
  const parsed = parseFalPrice(text);
  if (!parsed) return null;
  if (isPerItemUnit(parsed.unit)) return parsed.amount;
  if (ctx?.isVideo && isPerSecondUnit(parsed.unit) && ctx.durationSec != null) {
    return parsed.amount * ctx.durationSec;
  }
  if (isPerAreaUnit(parsed.unit) && ctx?.megapixels != null) {
    return parsed.amount * ctx.megapixels;
  }
  return null;
}

type EstimateResponse = { total_cost?: number };

/** Ask fal for its own authoritative cost of `quantity` calls to `endpoint`,
 *  via /models/pricing/estimate (estimate_type "historical_api_price" —
 *  fal's own historical pricing data, not just unit_price × quantity).
 *  Deliberately never throws: any network error, non-200, malformed JSON, or
 *  missing/invalid `total_cost` resolves to null, so callers can fall back
 *  to the local perItemPrice() computation without their own try/catch.
 *  Not used for the /models/pricing/estimate "unit_price" variant or for
 *  pre-submission cost previews (RunColumn) — those stay purely local since
 *  there's nothing real to ask fal about yet before a generation runs. */
export async function estimateGenerationCost(
  apiKey: string,
  endpoint: string,
  quantity: number,
): Promise<number | null> {
  if (!apiKey || !endpoint || !(quantity > 0)) return null;
  try {
    const res = await tauriFetch(ESTIMATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${apiKey}`,
      },
      body: JSON.stringify({
        estimate_type: "historical_api_price",
        endpoints: { [endpoint]: { call_quantity: quantity } },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as EstimateResponse;
    return typeof data.total_cost === "number" && Number.isFinite(data.total_cost) && data.total_cost >= 0
      ? data.total_cost
      : null;
  } catch {
    return null;
  }
}
