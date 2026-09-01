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
  | "queueWidth"
  | "deliverPreviewHeight"
  | "deliverEditHeight";

/** Deliver-mode panels are seeded as a fraction of the window rather than a
 *  fixed pixel count: the edit strip is specified as a quarter of the window
 *  height, and a hard-coded default would be that only on one screen size.
 *  Read once at module load; after the first resize the stored value wins.
 *
 *  `deliverEditHeight` is the timeline strip's own height — `Timeline` reads it
 *  directly. It replaced a separate `timelineHeight` key when the strip moved
 *  out of the generate stack and onto DELIVER; two keys for one panel was one
 *  too many. */
function windowFraction(f: number, fallback: number): number {
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  return h > 0 ? Math.round(h * f) : fallback;
}

const PANEL_DEFAULTS: Record<PanelKey, number> = {
  galleryHeight: 400,
  thumbColWidth: 80,
  logHeight: 78,
  queueWidth: 400,
  deliverPreviewHeight: windowFraction(0.3, 300),
  deliverEditHeight: windowFraction(0.25, 250),
};

/** Thumbnail-tile width bounds. Shared by the global slider (`thumbColWidth`)
 *  and the per-gallery-column overrides below, so the two stay comparable. */
export const THUMB_WIDTH_RANGE: [number, number] = [80, 500];

const PANEL_RANGE: Record<PanelKey, [number, number]> = {
  galleryHeight: [120, 1200],
  thumbColWidth: THUMB_WIDTH_RANGE,
  logHeight: [24, 600],
  queueWidth: [120, 1200],
  deliverPreviewHeight: [120, 1600],
  deliverEditHeight: [45, 800],
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

// Per-gallery-column tile-width overrides, keyed by column version name
// ("v003", "SHOT SRC", …) rather than by shot: a column you widened stays
// that width wherever it turns up, and the map can't grow without bound the
// way a shot-keyed one would. A column with no entry follows the global
// `thumbColWidth` slider.
const GALLERY_COL_STORAGE_KEY = "aislap.galleryColumnWidths";

function clampGalleryColWidth(px: number): number {
  const [lo, hi] = THUMB_WIDTH_RANGE;
  return Math.max(lo, Math.min(hi, Math.round(px)));
}

function loadGalleryColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(GALLERY_COL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        out[k] = clampGalleryColWidth(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Gallery display mode: thumbnails (default) or filenames only. A display
// preference, not a `ViewMode` — it composes with the columns view rather than
// replacing it, and switching it must not trigger the rescans setViewMode does.
const GALLERY_LIST_STORAGE_KEY = "aislap.galleryListMode";

function loadGalleryListMode(): boolean {
  try {
    return localStorage.getItem(GALLERY_LIST_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Which top-level surface the window is showing. App-global on purpose: a
 *  mode is a choice about what you are doing, not about which session you are
 *  in, so it does not belong in the per-tab state that rides in app-state.json
 *  (see `lib/bootstrap.ts` — adding a field there means editing `tabToPersisted`
 *  and the `installPersistence` change gate in lockstep). Tabs and modes are
 *  orthogonal: switching mode leaves the active tab alone, and vice versa. */
export type AppMode = "generate" | "deliver" | "audit";

const MODE_STORAGE_KEY = "aislap.activeMode";

const APP_MODES: readonly AppMode[] = ["generate", "deliver", "audit"];

function loadMode(): AppMode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    return APP_MODES.includes(raw as AppMode) ? (raw as AppMode) : "generate";
  } catch {
    return "generate";
  }
}

type State = {
  widths: Record<ColumnKey, number>;
  setWidth: (key: ColumnKey, px: number) => void;
  collapsed: Record<CollapsibleKey, boolean>;
  toggleCollapsed: (key: CollapsibleKey) => void;

  galleryColumnWidths: Record<string, number>;
  setGalleryColumnWidth: (version: string, px: number) => void;
  /** Drop the override so the column tracks the global slider again. */
  clearGalleryColumnWidth: (version: string) => void;

  galleryListMode: boolean;
  toggleGalleryListMode: () => void;

  mode: AppMode;
  setMode: (m: AppMode) => void;

  panelSizes: Record<PanelKey, number>;
  setGalleryHeight: (n: number) => void;
  setThumbColWidth: (n: number) => void;
  setLogHeight: (n: number) => void;
  setQueueWidth: (n: number) => void;
  setDeliverPreviewHeight: (n: number) => void;
  setDeliverEditHeight: (n: number) => void;
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

function persistGalleryColumnWidths(widths: Record<string, number>) {
  try {
    localStorage.setItem(GALLERY_COL_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    /* swallow — column-width persistence is best-effort */
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

  galleryColumnWidths: loadGalleryColumnWidths(),
  setGalleryColumnWidth(version, px) {
    const next = {
      ...get().galleryColumnWidths,
      [version]: clampGalleryColWidth(px),
    };
    set({ galleryColumnWidths: next });
    persistGalleryColumnWidths(next);
  },
  clearGalleryColumnWidth(version) {
    const next = { ...get().galleryColumnWidths };
    delete next[version];
    set({ galleryColumnWidths: next });
    persistGalleryColumnWidths(next);
  },

  galleryListMode: loadGalleryListMode(),
  toggleGalleryListMode() {
    const next = !get().galleryListMode;
    set({ galleryListMode: next });
    try {
      localStorage.setItem(GALLERY_LIST_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* swallow — list-mode persistence is best-effort */
    }
  },

  mode: loadMode(),
  setMode(m) {
    if (get().mode === m) return;
    set({ mode: m });
    try {
      localStorage.setItem(MODE_STORAGE_KEY, m);
    } catch {
      /* swallow — mode persistence is best-effort */
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
  setQueueWidth(n) {
    const next = { ...get().panelSizes, queueWidth: clampPanel("queueWidth", n) };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setDeliverPreviewHeight(n) {
    const next = {
      ...get().panelSizes,
      deliverPreviewHeight: clampPanel("deliverPreviewHeight", n),
    };
    set({ panelSizes: next });
    persistPanelSizes(next);
  },
  setDeliverEditHeight(n) {
    const next = {
      ...get().panelSizes,
      deliverEditHeight: clampPanel("deliverEditHeight", n),
    };
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
