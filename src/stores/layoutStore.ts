import { create } from "zustand";

// User-adjustable widths (px) for the resizable editor columns. The preview
// column (LatestImageColumn) is flex-1 and absorbs the remaining space, so it
// grows/shrinks automatically as these change. Model options stay fixed.
export type ColumnKey = "seqPrompt" | "shotPrompt" | "refImages";

const DEFAULTS: Record<ColumnKey, number> = {
  seqPrompt: 300,
  shotPrompt: 300,
  refImages: 381,
};

export const COLUMN_MIN_WIDTH = 180;
export const COLUMN_MAX_WIDTH = 900;
const STORAGE_KEY = "aislap.columnWidths";

function clamp(px: number): number {
  return Math.max(COLUMN_MIN_WIDTH, Math.min(COLUMN_MAX_WIDTH, Math.round(px)));
}

function loadWidths(): Record<ColumnKey, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, number>>;
    return {
      seqPrompt: clamp(parsed.seqPrompt ?? DEFAULTS.seqPrompt),
      shotPrompt: clamp(parsed.shotPrompt ?? DEFAULTS.shotPrompt),
      refImages: clamp(parsed.refImages ?? DEFAULTS.refImages),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

type State = {
  widths: Record<ColumnKey, number>;
  setWidth: (key: ColumnKey, px: number) => void;
};

export const useLayoutStore = create<State>((set, get) => ({
  widths: loadWidths(),
  setWidth(key, px) {
    const next = { ...get().widths, [key]: clamp(px) };
    set({ widths: next });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* swallow — width persistence is best-effort */
    }
  },
}));
