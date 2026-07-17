import { create } from "zustand";

// Per-endpoint fal price texts (e.g. "$0.005 per request"), keyed by the
// catalog `node.endpoint`. Seeded from config at bootstrap; refreshed via the
// Settings "fetch prices" button (see lib/falPrices.ts for the source).
type State = {
  prices: Record<string, string>;
  fetchedAt: string | null;
  /** Per-endpoint user-entered overrides (any provider), keyed like `prices`.
   *  Seeded from config at bootstrap; edited via Settings -> Costs and
   *  committed on Save (see lib/falPrices.ts's perItemPrice). */
  overrides: Record<string, number>;
};

type Actions = {
  setPrices: (prices: Record<string, string>, fetchedAt: string | null) => void;
  setOverrides: (overrides: Record<string, number>) => void;
};

export const usePricesStore = create<State & Actions>((set) => ({
  prices: {},
  fetchedAt: null,
  overrides: {},
  setPrices(prices, fetchedAt) {
    set({ prices, fetchedAt });
  },
  setOverrides(overrides) {
    set({ overrides });
  },
}));
