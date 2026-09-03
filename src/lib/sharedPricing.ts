// The team's price sheet, held in Turso (see src-tauri/src/db/pricing.rs).
//
// Precedence: the shared sheet wins. `config.json` keeps a copy purely as the
// offline cache — it is what the app reads at startup before (and if) the pull
// lands, and it is all there is when no Turso is configured. Merging rather
// than replacing means a price only this machine has fetched isn't lost the
// moment someone else's sheet is a few endpoints short.
//
// Every function here is best-effort and never throws: pricing is a labelling
// concern, and a network blip must not stop the app starting or a price
// override being typed.

import { pushLog } from "../stores/logStore";
import { usePricesStore } from "../stores/pricesStore";
import { cmd } from "./tauri";
import { DEFAULT_CONFIG } from "./types";
import type { Config } from "./types";

async function patchConfig(patch: Partial<Config>): Promise<void> {
  const onDisk = (await cmd.config_load().catch(() => null)) ?? DEFAULT_CONFIG;
  await cmd.config_save({ ...onDisk, ...patch });
}

/**
 * Pull the shared sheet and adopt it: shared entries win per key, local-only
 * entries survive. Updates `pricesStore` (what the app reads) and the
 * `config.json` cache (what survives a restart, and what stands in when the
 * remote is unreachable).
 *
 * Returns what happened, so a caller with somewhere to say it can. A `null`
 * pull — no Turso configured — is not a failure and leaves everything alone.
 */
export async function pullSharedPricing(): Promise<
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ok"; prices: number; overrides: number; updatedAt?: string; updatedBy?: string }
> {
  let shared;
  try {
    shared = await cmd.pricing_pull();
  } catch (e) {
    return { status: "error", message: String(e) };
  }
  if (!shared) return { status: "unconfigured" };

  const priceCount = Object.keys(shared.prices).length;
  const overrideCount = Object.keys(shared.overrides).length;
  const result = {
    status: "ok" as const,
    prices: priceCount,
    overrides: overrideCount,
    updatedAt: shared.updatedAt,
    updatedBy: shared.updatedBy,
  };
  // An empty sheet (nobody has pushed yet) has nothing to adopt, and writing
  // it through would rewrite the local cache to say the same thing — with a
  // `falPricesFetchedAt` of undefined, erasing the timestamp of a fetch this
  // machine really did make.
  if (priceCount === 0 && overrideCount === 0) return result;

  const store = usePricesStore.getState();
  const fetchedAt = shared.updatedAt ?? store.fetchedAt;

  // Only the halves the sheet actually contributed to are written back. The
  // merge is `{...local, ...shared}`, so a sheet with no overrides would
  // otherwise persist the store's copy of them — and the store is a live
  // object this function does not own. Anything that had emptied it (a failed
  // config load, a concurrent edit) would be committed to disk as an empty
  // map, turning a transient in-memory state into permanent data loss.
  const patch: Partial<Config> = {};
  if (priceCount > 0) {
    const prices = { ...store.prices, ...shared.prices };
    store.setPrices(prices, fetchedAt);
    patch.falPrices = prices;
    if (fetchedAt) patch.falPricesFetchedAt = fetchedAt;
  }
  if (overrideCount > 0) {
    const overrides = { ...store.overrides, ...shared.overrides };
    store.setOverrides(overrides);
    patch.priceOverrides = overrides;
  }
  await patchConfig(patch).catch((e) =>
    pushLog("INFO", `shared pricing: local cache write failed: ${e}`),
  );

  return result;
}

/** Publish prices and/or overrides to the shared sheet. Fire-and-forget by
 *  design — the local write has already happened and is what the user sees;
 *  this is the part that lets everyone else see it too. */
export async function pushSharedPricing(
  prices: Record<string, string>,
  overrides: Record<string, number>,
): Promise<number | null> {
  try {
    return await cmd.pricing_push(prices, overrides);
  } catch (e) {
    pushLog("INFO", `shared pricing: push failed: ${e}`);
    return null;
  }
}

/** Remove one override from the shared sheet. A push only upserts, so a
 *  cleared field needs saying explicitly or the row stands and comes back on
 *  the next pull. */
export async function forgetSharedOverride(key: string): Promise<void> {
  try {
    await cmd.pricing_forget(key);
  } catch (e) {
    pushLog("INFO", `shared pricing: delete failed: ${e}`);
  }
}
