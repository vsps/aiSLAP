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

// Editor columns that can be collapsed to a narrow vertical-label bar to free
// up room for the preview panel. Model settings has no resizable width (fixed
// column), so it's tracked separately from ColumnKey.
export type CollapsibleKey = "modelSettings" | ColumnKey;

const COLLAPSE_DEFAULTS: Record<CollapsibleKey, boolean> = {
  modelSettings: false,
  seqPrompt: false,
  shotPrompt: false,
  refImages: false,
};

const COLLAPSE_STORAGE_KEY = "aislap.columnCollapsed";

function loadCollapsed(): Record<CollapsibleKey, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return { ...COLLAPSE_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<CollapsibleKey, boolean>>;
    return {
      modelSettings: !!parsed.modelSettings,
      seqPrompt: !!parsed.seqPrompt,
      shotPrompt: !!parsed.shotPrompt,
      refImages: !!parsed.refImages,
    };
  } catch {
    return { ...COLLAPSE_DEFAULTS };
  }
}

type State = {
  widths: Record<ColumnKey, number>;
  setWidth: (key: ColumnKey, px: number) => void;
  collapsed: Record<CollapsibleKey, boolean>;
  toggleCollapsed: (key: CollapsibleKey) => void;
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
  collapsed: loadCollapsed(),
  toggleCollapsed(key) {
    const next = { ...get().collapsed, [key]: !get().collapsed[key] };
    set({ collapsed: next });
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* swallow — collapse-state persistence is best-effort */
    }
  },
}));
