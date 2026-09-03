import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import {
  ASSUMED_PREVIEW_FPS,
  effectiveDollarsPerSecond,
  fetchFalPrices,
  formatCost,
} from "../lib/falPrices";
import {
  forgetSharedOverride,
  pullSharedPricing,
  pushSharedPricing,
} from "../lib/sharedPricing";
import { DEFAULT_CONFIG } from "../lib/types";
import { useModelsStore } from "../stores/modelsStore";
import { usePricesStore } from "../stores/pricesStore";
import { DerivedPricesPanel } from "./DerivedPricesPanel";
import { Field } from "./Field";
import type { Config, EnumParam } from "../lib/types";
import { Btn } from "./Btn";

/**
 * Model pricing: the fal price fetch, and a per-model (or per-resolution)
 * override for everything fal's pricing API can't tell us — which is every
 * non-fal provider, since only fal has one.
 *
 * Lives on AUDIT rather than in Settings because it is the input to every
 * number on this page; changing an override and watching the totals move is
 * one action, not two dialogs.
 *
 * Unlike the settings dialogs there is no Cancel/Save pair here, so every edit
 * persists on its own. Each write merges into a *freshly loaded* on-disk config
 * rather than a copy held in state — this component only ever owns three
 * fields, and re-reading before each write is what stops it from clobbering
 * settings edited elsewhere in the meantime.
 */
export function CostSettings() {
  const modelEntries = useModelsStore((s) => s.entries);
  const pricesFetchedAt = usePricesStore((s) => s.fetchedAt);
  const pricesCount = usePricesStore((s) => Object.keys(s.prices).length);
  const prices = usePricesStore((s) => s.prices);
  const overrides = usePricesStore((s) => s.overrides);

  const [pricesBusy, setPricesBusy] = useState(false);
  const [pricesStatus, setPricesStatus] = useState<string | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedStatus, setSharedStatus] = useState<string | null>(null);
  const [costProvider, setCostProvider] = useState<string>("fal");
  const [priceTableHeight, setPriceTableHeight] = useState(256);

  const providers = useMemo<string[]>(() => {
    const set = new Set<string>(
      modelEntries.map((e) => e.node.provider ?? "fal"),
    );
    return [...set].sort();
  }, [modelEntries]);

  useEffect(() => {
    if (providers.length > 0 && !providers.includes(costProvider)) {
      setCostProvider(providers[0]);
    }
  }, [providers, costProvider]);

  const modelsForProvider = useMemo(
    () =>
      modelEntries
        .filter((e) => (e.node.provider ?? "fal") === costProvider)
        .sort((a, b) => a.node.name.localeCompare(b.node.name)),
    [modelEntries, costProvider],
  );

  // One row per model, or one row per resolution option for models whose
  // cost varies by resolution — fal's pricing API only ever returns one flat
  // price per model, so a resolution split only ever affects the override.
  type PriceRow = {
    key: string;
    name: string;
    endpoint: string;
    isVideo: boolean;
    resolution: string | null;
  };
  const priceRows = useMemo<PriceRow[]>(() => {
    const rows: PriceRow[] = [];
    for (const e of modelsForProvider) {
      const resParam = e.node.parameters.find(
        (p): p is EnumParam => p.type === "enum" && p.name === "resolution",
      );
      const isVideo = e.node.kind === "video";
      if (resParam && resParam.options.length > 0) {
        for (const r of resParam.options) {
          rows.push({
            key: `${e.node.id}::${r}`,
            name: e.node.name,
            endpoint: e.node.endpoint,
            isVideo,
            resolution: r,
          });
        }
      } else {
        rows.push({
          key: e.node.id,
          name: e.node.name,
          endpoint: e.node.endpoint,
          isVideo,
          resolution: null,
        });
      }
    }
    return rows;
  }, [modelsForProvider]);

  function overrideKeyFor(row: {
    endpoint: string;
    resolution: string | null;
  }): string {
    return row.resolution ? `${row.endpoint}::${row.resolution}` : row.endpoint;
  }

  /** Read-modify-write against disk, then push the result into `pricesStore`
   *  so RunColumn's estimate and GalleryColumn's badge pick it up without a
   *  reload. Both halves are required: the store is what the rest of the app
   *  reads, the file is what survives a restart. */
  async function patchConfig(patch: Partial<Config>) {
    const onDisk = (await cmd.config_load().catch(() => null)) ?? DEFAULT_CONFIG;
    await cmd.config_save({ ...onDisk, ...patch });
  }

  async function setPriceOverride(overrideKey: string, raw: string) {
    const next = { ...overrides };
    if (raw.trim() === "") {
      delete next[overrideKey];
    } else {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return;
      next[overrideKey] = n;
    }
    // Optimistic: the input is controlled off the store, so it has to move
    // before the round-trip to disk or typing feels stuck.
    usePricesStore.getState().setOverrides(next);
    try {
      await patchConfig({ priceOverrides: next });
    } catch (e) {
      setPricesStatus(`Could not save override: ${String(e)}`);
    }
    // Publish to the team's sheet. One row, not the whole map — see
    // lib/sharedPricing.ts for why a clear has to be its own delete.
    if (overrideKey in next) {
      void pushSharedPricing({}, { [overrideKey]: next[overrideKey] });
    } else {
      void forgetSharedOverride(overrideKey);
    }
  }

  /** Adopt the team's sheet on demand. The same pull runs once at startup;
   *  this is for picking up someone else's edit without a restart. */
  async function syncShared() {
    if (sharedBusy) return;
    setSharedBusy(true);
    setSharedStatus("Syncing…");
    const result = await pullSharedPricing();
    setSharedStatus(
      result.status === "unconfigured"
        ? "No shared database configured — prices are local to this machine."
        : result.status === "error"
          ? `Error: ${result.message}`
          : `${result.prices} prices, ${result.overrides} overrides` +
            (result.updatedBy ? ` · last written by ${result.updatedBy}` : ""),
    );
    setSharedBusy(false);
  }

  async function fetchPrices() {
    if (pricesBusy) return;
    const falKey = await cmd.provider_key_get("fal").catch(() => "");
    if (!falKey.trim()) {
      setPricesStatus("fal API key not configured — set it in Settings → APIs.");
      return;
    }
    setPricesBusy(true);
    setPricesStatus("Fetching…");
    try {
      const falEntries = useModelsStore
        .getState()
        .entries.filter((e) => (e.node.provider ?? "fal") === "fal");
      const unique = [...new Set(falEntries.map((e) => e.node.endpoint))];

      const fetched = await fetchFalPrices(unique, falKey);
      const fetchedAt = new Date().toISOString();
      await patchConfig({ falPrices: fetched, falPricesFetchedAt: fetchedAt });
      usePricesStore.getState().setPrices(fetched, fetchedAt);
      const pricedCount = unique.filter((e) => e in fetched).length;
      // Publish so the rest of the team gets this fetch without re-spending
      // their own API call. Last write wins per endpoint.
      const pushed = await pushSharedPricing(fetched, {});
      setPricesStatus(
        `${pricedCount} of ${unique.length} fal models priced.` +
          (pushed != null ? ` Shared with the team (${pushed} rows).` : ""),
      );
    } catch (e) {
      setPricesStatus(`Error: ${String(e)}`);
    } finally {
      setPricesBusy(false);
    }
  }

  function startPriceTableResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = priceTableHeight;
    function onMove(ev: MouseEvent) {
      setPriceTableHeight(
        Math.min(600, Math.max(120, startHeight + (ev.clientY - startY))),
      );
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="fal.ai prices">
        <div className="flex gap-1 items-center">
          <Btn onClick={() => void fetchPrices()} disabled={pricesBusy}>
            {pricesBusy ? "Fetching…" : "Fetch prices"}
          </Btn>
          <span className="text-xs text-dim">
            {pricesCount > 0
              ? `${pricesCount} cached${
                  pricesFetchedAt
                    ? ` · ${new Date(pricesFetchedAt).toLocaleString()}`
                    : ""
                }`
              : "no prices cached"}
          </span>
        </div>
        <div className="text-xs text-dim mt-1">
          {pricesStatus ??
            "Pulls per-model prices from fal's official pricing API (requires the fal API key, set in Settings → APIs)."}
        </div>
      </Field>

      <Field label="Derived from spend">
        <DerivedPricesPanel />
      </Field>

      <Field label="Shared price sheet">
        <Btn
          className="self-start"
          onClick={() => void syncShared()}
          disabled={sharedBusy}
        >
          {sharedBusy ? "Syncing…" : "Sync from team"}
        </Btn>
        <div className="text-xs text-dim mt-1">
          {sharedStatus ??
            "Prices and overrides are shared through the Turso database, so everyone prices from the same sheet. Pulled at startup and after every fetch or override edit; last write wins per model."}
        </div>
      </Field>

      <Field label="Model prices">
        <div className="flex items-center gap-2">
          <select
            value={costProvider}
            onChange={(e) => setCostProvider(e.currentTarget.value)}
            className="bg-inset px-2 py-1 text-xs font-mono"
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="text-xs text-dim">
            {priceRows.length} row{priceRows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div
          className="overflow-y-auto thin-scroll mt-1"
          style={{ height: priceTableHeight }}
        >
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-dim text-left">
                <th className="font-normal py-1">Model</th>
                <th className="font-normal py-1">Known price</th>
                <th className="font-normal py-1 w-[140px]">Override</th>
              </tr>
            </thead>
            <tbody>
              {priceRows.map((row) => {
                const overrideKey = overrideKeyFor(row);
                return (
                  <tr key={row.key} className="border-t border-dim/30">
                    <td className="py-1 pr-2">
                      <span className="text-text">{row.name}</span>
                      {row.resolution && (
                        <span className="text-dim"> · {row.resolution}</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 font-mono text-dim">
                      {prices[row.endpoint] ?? "—"}
                      {/* A token-billed price ("per units", "per 1000
                          tokens") says nothing you can compare against the
                          $/sec models beside it. Converting at this row's
                          resolution and 24fps makes the column readable — and
                          gives a starting figure for the override input to
                          its right, which is already in $/sec. */}
                      {row.isVideo &&
                        (() => {
                          const perSec = effectiveDollarsPerSecond(
                            prices[row.endpoint] ?? "",
                            row.resolution,
                          );
                          return perSec == null ? null : (
                            <span
                              className="text-accent"
                              title={`Effective rate at ${row.resolution} / ${ASSUMED_PREVIEW_FPS}fps, 16:9. The billed cost uses the delivered file's real dimensions and frame rate.`}
                            >
                              {" "}
                              ≈ ${formatCost(perSec)}/sec
                            </span>
                          );
                        })()}
                    </td>
                    <td className="py-1">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="0.001"
                          min={0}
                          value={overrides[overrideKey] ?? ""}
                          onChange={(e) =>
                            void setPriceOverride(
                              overrideKey,
                              e.currentTarget.value,
                            )
                          }
                          className="bg-inset px-1 py-0.5 w-[80px] font-mono"
                        />
                        <span className="text-dim">
                          {row.isVideo ? "$/sec" : "$"}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {priceRows.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-dim py-2">
                    No models for this provider.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div
          onMouseDown={startPriceTableResize}
          className="h-2 mt-0.5 cursor-row-resize flex items-center justify-center group"
          title="Drag to resize"
        >
          <div className="w-8 h-1 rounded-full bg-dim/40 group-hover:bg-accent" />
        </div>
      </Field>
    </div>
  );
}
