import { useMemo, useState } from "react";
import { formatCost, formatUnitPrice } from "../lib/falPrices";
import { pushSharedPricing } from "../lib/sharedPricing";
import { cmd } from "../lib/tauri";
import { DEFAULT_CONFIG } from "../lib/types";
import { usePricesStore } from "../stores/pricesStore";
import type { Config, DerivedPrice, DerivedPricing } from "../lib/types";
import { Btn } from "./Btn";

/**
 * Read a price table back out of what fal actually billed.
 *
 * fal's pricing API has no resolution dimension, so a model that really costs
 * 2× at 1080p reports one number for every tier. Rather than model each
 * vendor's formula, this groups reconciled generations by (endpoint,
 * resolution) and reads the rate off real invoices — which also prices the
 * models no formula can reach (minimax bills GPU time).
 *
 * Nothing is applied without being shown first: a rate standing on one
 * generation looks exactly like a rate standing on forty until you print the
 * sample count, so the count and the spread are the point of this table.
 */

/** Below this, a proposal is a data point rather than a price — shown, but
 *  not selected by default. */
const CONFIDENT_SAMPLES = 3;
/** max/min beyond this means the group is mixing things its key doesn't
 *  separate, so the median is not describing one rate. */
const WIDE_SPREAD = 1.25;

function isWideSpread(p: DerivedPrice): boolean {
  return p.min > 0 && p.max / p.min > WIDE_SPREAD;
}

function isConfident(p: DerivedPrice): boolean {
  return p.samples >= CONFIDENT_SAMPLES && !isWideSpread(p);
}

export function DerivedPricesPanel() {
  const overrides = usePricesStore((s) => s.overrides);
  const [result, setResult] = useState<DerivedPricing | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function derive() {
    if (busy) return;
    setBusy(true);
    setStatus("Reading billed costs…");
    try {
      const data = await cmd.pricing_derive();
      setResult(data);
      // Pre-select only what the evidence supports; everything else is there
      // to be looked at and ticked deliberately.
      setSelected(new Set(data.prices.filter(isConfident).map((p) => p.key)));
      setStatus(
        data.prices.length === 0
          ? `Nothing to derive from. ${data.unreconciled} priced generations aren't reconciled yet — run Reconcile actual first, that's what turns an estimate into a billed figure.`
          : `${data.prices.length} rates from the ${data.source === "remote" ? "team's shared index" : "local project indexes"}.` +
              (data.unreconciled > 0
                ? ` ${data.unreconciled} more generations would count once reconciled.`
                : ""),
      );
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const chosen = useMemo(
    () => (result?.prices ?? []).filter((p) => selected.has(p.key)),
    [result, selected],
  );

  async function apply() {
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      const next = { ...overrides };
      for (const p of chosen) next[p.key] = p.rate;
      usePricesStore.getState().setOverrides(next);

      const onDisk =
        (await cmd.config_load().catch(() => null)) ?? DEFAULT_CONFIG;
      const patch: Config = { ...onDisk, priceOverrides: next };
      await cmd.config_save(patch);
      // Straight onto the team's sheet: a rate derived from the team's own
      // spend is exactly the thing everyone should be pricing from.
      await pushSharedPricing(
        {},
        Object.fromEntries(chosen.map((p) => [p.key, p.rate])),
      );
      setStatus(`Applied ${chosen.length} as overrides and shared them.`);
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Btn disabled={busy} onClick={() => void derive()}>
          {busy ? "Working…" : "Derive from actual spend"}
        </Btn>
        {result && result.prices.length > 0 && (
          <Btn disabled={busy || chosen.length === 0} onClick={() => void apply()}>
            Apply {chosen.length} as overrides
          </Btn>
        )}
      </div>

      <div className="text-xs text-dim">
        {status ??
          "Groups reconciled generations by model and resolution and reads the real rate off what fal billed — the only way to get per-resolution prices, since fal's pricing API reports one number per model. Needs Reconcile actual to have run."}
      </div>

      {result && result.prices.length > 0 && (
        <div className="overflow-y-auto thin-scroll max-h-72">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-dim text-left">
                <th className="font-normal py-1 w-6"></th>
                <th className="font-normal py-1">Model · resolution</th>
                <th className="font-normal py-1 text-right">Rate</th>
                <th className="font-normal py-1 text-right">Samples</th>
                <th className="font-normal py-1 text-right">Spread</th>
                <th className="font-normal py-1 text-right">Billed</th>
              </tr>
            </thead>
            <tbody>
              {result.prices.map((p) => {
                const wide = isWideSpread(p);
                const thin = p.samples < CONFIDENT_SAMPLES;
                const current = overrides[p.key];
                return (
                  <tr key={p.key} className="border-t border-dim/30">
                    <td className="py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(p.key)}
                        onChange={() => toggle(p.key)}
                      />
                    </td>
                    <td className="py-1 pr-2 font-mono">
                      <span className="text-text">{p.endpoint}</span>
                      {p.resolution && (
                        <span className="text-dim"> · {p.resolution}</span>
                      )}
                      {current !== undefined && (
                        <span
                          className="text-dim"
                          title="An override already exists for this key; applying replaces it."
                        >
                          {" "}
                          (now ${formatUnitPrice(current)})
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 font-mono text-right text-text">
                      ${formatUnitPrice(p.rate)}
                      <span className="text-dim">
                        {p.kind === "video" ? "/s" : ""}
                      </span>
                    </td>
                    <td
                      className={`py-1 pr-2 font-mono text-right ${thin ? "text-yellow-500" : "text-dim"}`}
                      title={
                        thin
                          ? `Only ${p.samples} reconciled generation${p.samples === 1 ? "" : "s"} — a data point, not yet a price.`
                          : undefined
                      }
                    >
                      {p.samples}
                    </td>
                    <td
                      className={`py-1 pr-2 font-mono text-right ${wide ? "text-yellow-500" : "text-dim"}`}
                      title={`$${formatUnitPrice(p.min)} – $${formatUnitPrice(p.max)}${
                        wide
                          ? " — too wide to be one rate. Something the model/resolution key doesn't capture is varying."
                          : ""
                      }`}
                    >
                      {p.min > 0 ? `${(p.max / p.min).toFixed(2)}×` : "—"}
                    </td>
                    <td className="py-1 font-mono text-right text-dim">
                      ${formatCost(p.totalCostUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result && result.unusable > 0 && (
        <div className="text-[11px] text-dim">
          {result.unusable} reconciled generation
          {result.unusable === 1 ? "" : "s"} couldn't yield a rate — a video
          whose duration wasn't recorded can't be divided into $/sec.
        </div>
      )}
    </div>
  );
}
