import { create } from "zustand";

// Per-endpoint fal price texts (e.g. "$0.005 per request"), keyed by the
// catalog `node.endpoint`. Seeded from config at bootstrap; refreshed via the
// Settings "fetch prices" button (see lib/falPrices.ts for the source).
type State = {
  prices: Record<string, string>;
  fetchedAt: string | null;
};

type Actions = {
  setPrices: (prices: Record<string, string>, fetchedAt: string | null) => void;
};

export const usePricesStore = create<State & Actions>((set) => ({
  prices: {},
  fetchedAt: null,
  setPrices(prices, fetchedAt) {
    set({ prices, fetchedAt });
  },
}));
