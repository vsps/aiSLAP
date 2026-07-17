// Fetch per-endpoint prices from fal's (unofficial) website gallery API.
// There is no documented pricing API; https://fal.ai/api/models is what the
// fal.ai model gallery itself uses. Each item carries `id` (matching our
// catalog `node.endpoint` exactly) and `pricingInfoOverride`, a markdown
// string like "$0.005 per request" or "Your request will cost **$0.03**…".
// Because it's unofficial the fetch is user-triggered (Settings button) and
// results are persisted to config — never fetched implicitly at startup.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

type GalleryItem = {
  id?: string;
  pricingInfoOverride?: string | null;
};

type GalleryPage = {
  items?: GalleryItem[];
  page?: number;
  pages?: number;
};

// Dash-tokens that carry no model identity on their own: registry prefixes,
// task/verb words, tiers, media kinds. A path segment made up entirely of
// these (e.g. "image-to-video", "video-rle", "3d-objects") is a task name,
// not a model name, and makes a useless gallery search keyword.
const GENERIC_WORDS = new Set([
  "fal-ai", "edit", "image", "video", "fast", "pro", "standard", "lite",
  "upscale", "embed", "to", "reference", "text", "multi", "frame", "first",
  "last", "3d", "rle", "body", "objects", "align",
]);

function isGenericSegment(seg: string): boolean {
  if (/^v?\d+(\.\d+)*$/i.test(seg)) return true; // version-ish: v3, 4.5
  return seg
    .toLowerCase()
    .split("-")
    .every((w) => GENERIC_WORDS.has(w) || /^\d+$/.test(w));
}

// The model-name segment usually sits late in the path ("fal-ai/bytedance/
// seedream/v4.5/edit" → "seedream"), so prefer the last non-generic
// candidate, skipping too-short ones like kling's "o3" tier. The search term
// drops trailing version suffixes ("seedance-2.0" → "seedance") — broader
// keywords are safe because harvesting matches by exact id anyway.
function keywordFor(endpoint: string): string {
  const segs = endpoint.split("/").filter(Boolean);
  const candidates = segs.filter((s) => !isGenericSegment(s));
  const pick =
    [...candidates].reverse().find((s) => s.length >= 4) ??
    candidates[candidates.length - 1] ??
    segs[segs.length - 1] ??
    endpoint;
  const stripped = pick.replace(/[-.]v?\d+(\.\d+)*$/i, "");
  return stripped.length >= 3 ? stripped : pick;
}

const MAX_PAGES_PER_KEYWORD = 5;

/** Query the gallery for every distinct keyword derived from `endpoints`,
 *  harvesting exact-id matches for ANY requested endpoint from every page.
 *  Returns endpoint → cleaned price text; endpoints fal doesn't price (or
 *  the API doesn't know) are simply absent. */
export async function fetchFalPrices(
  endpoints: string[],
): Promise<Record<string, string>> {
  const wanted = new Set(endpoints);
  const keywords = [...new Set(endpoints.map(keywordFor))];
  const out: Record<string, string> = {};

  for (const kw of keywords) {
    let page = 1;
    let pages = 1;
    do {
      const url = `https://fal.ai/api/models?keywords=${encodeURIComponent(kw)}&page=${page}`;
      const res = await tauriFetch(url);
      if (!res.ok) throw new Error(`fal gallery API: HTTP ${res.status} for "${kw}"`);
      const data = (await res.json()) as GalleryPage;
      for (const item of data.items ?? []) {
        if (!item.id || !wanted.has(item.id)) continue;
        const text = cleanPriceText(item.pricingInfoOverride);
        if (text) out[item.id] = text;
      }
      pages = Math.min(data.pages ?? 1, MAX_PAGES_PER_KEYWORD);
      page += 1;
    } while (page <= pages);
  }
  return out;
}

function cleanPriceText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replaceAll("**", "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
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
  /** True when the actual output is a video — a per-second price (scraped or
   *  overridden) only resolves to a total when this is set. */
  isVideo?: boolean;
  /** Output duration in seconds, from the generation's `duration` setting
   *  (see parseDurationSeconds). Null/undefined when unknown. */
  durationSec?: number | null;
  /** The generation's `resolution` setting, for models priced per-resolution.
   *  Overrides are keyed `${endpoint}::${resolution}` when set, since
   *  scraping only ever yields one blended price per model regardless of
   *  resolution (Settings -> Costs table). */
  resolution?: string | null;
};

/** Per-output price for one endpoint. A user-entered override (Settings ->
 *  Costs) always wins when present — it's the only way to price non-fal
 *  models, or a specific resolution, since only fal has a scraper and only
 *  at the model level. For video, both an override and a scraped price are
 *  interpreted as $/sec and multiplied by `ctx.durationSec`; without a known
 *  duration a per-second price can't be resolved to a total (null). */
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
  const text = prices[endpoint];
  if (!text) return null;
  const parsed = parseFalPrice(text);
  if (!parsed) return null;
  if (isPerItemUnit(parsed.unit)) return parsed.amount;
  if (ctx?.isVideo && isPerSecondUnit(parsed.unit) && ctx.durationSec != null) {
    return parsed.amount * ctx.durationSec;
  }
  return null;
}
