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

// Resizable app-chrome panels (gallery/log/timeline/queue heights+widths).
// Previously round-tripped through Rust app_state.json (sessionStore); moved
// here so they're plain localStorage like the other layout prefs, and so
// resizing them no longer triggers a debounced full-app-state Rust write.
type PanelKey =
  | "galleryHeight"
  | "thumbColWidth"
  | "logHeight"
  | "timelineHeight"
  | "queueWidth";

const PANEL_DEFAULTS: Record<PanelKey, number> = {
  galleryHeight: 400,
  thumbColWidth: 80,
  logHeight: 78,
  timelineHeight: 45,
  queueWidth: 400,
};

const PANEL_RANGE: Record<PanelKey, [number, number]> = {
  galleryHeight: [120, 1200],
  thumbColWidth: [80, 500],
  logHeight: [24, 600],
  timelineHeight: [45, 400],
  queueWidth: [120, 1200],
};

const PANEL_STORAGE_KEY = "aislap.panelSizes";

function clampPanel(key: PanelKey, n: number): number {
  const [lo, hi] = PANEL_RANGE[key];
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function loadPanelSizes(): Record<PanelKey, number> {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return { ...PANEL_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<PanelKey, number>>;
    const out = { ...PANEL_DEFAULTS };
    for (const key of Object.keys(PANEL_DEFAULTS) as PanelKey[]) {
      if (typeof parsed[key] === "number") out[key] = clampPanel(key, parsed[key]!);
    }
    return out;
  } catch {
    return { ...PANEL_DEFAULTS };
  }
}

type State = {
  widths: Record<ColumnKey, number>;
  setWidth: (key: ColumnKey, px: number) => void;
  collapsed: Record<CollapsibleKey, boolean>;
  toggleCollapsed: (key: CollapsibleKey) => void;

  panelSizes: Record<PanelKey, number>;
  setGalleryHeight: (n: number) => void;
  setThumbColWidth: (n: number) => void;
  setLogHeight: (n: number) => void;
  setTimelineHeight: (n: number) => void;
  setQueueWidth: (n: number) => void;
  /** One-time migration from the old Rust-backed app_state.json fields.
   *  No-ops if panel sizes have already been persisted to localStorage. */
  migrateLegacyPanelSizes: (legacy: Partial<Record<PanelKey, number>>) => void;
};

function persistPanelSizes(sizes: Record<PanelKey, number>) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    /* swallow — panel-size persistence is best-effort */
  }
}

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

  panelSizes: loadPanelSizes(),
  setGalleryHeight(n) {
    const next = { ...get().panelSizes, galleryHeight: clampPanel("galleryHeight", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setThumbColWidth(n) {
    const next = { ...get().panelSizes, thumbColWidth: clampPanel("thumbColWidth", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setLogHeight(n) {
    const next = { ...get().panelSizes, logHeight: clampPanel("logHeight", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setTimelineHeight(n) {
    const next = { ...get().panelSizes, timelineHeight: clampPanel("timelineHeight", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setQueueWidth(n) {
    const next = { ...get().panelSizes, queueWidth: clampPanel("queueWidth", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  migrateLegacyPanelSizes(legacy) {
    if (localStorage.getItem(PANEL_STORAGE_KEY)) return; // already migrated/persisted
    const next = { ...get().panelSizes };
    for (const key of Object.keys(PANEL_DEFAULTS) as PanelKey[]) {
      const v = legacy[key];
      if (typeof v === "number") next[key] = clampPanel(key, v);
    }
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
}));
