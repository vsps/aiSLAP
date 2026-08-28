import { cmd } from "./tauri";
import { joinPath, normalizeDir, relativeTo } from "./paths";
import { applyColors } from "./colors";
import type {
  AppState,
  ChainLink,
  ChainLinkPersisted,
  Config,
  ModelEntry,
  TabPersisted,
} from "./types";
import {
  makeChainLink,
  selectActiveLink,
} from "../stores/generationStore";
import { swallow } from "./errors";
import { loadSystemUsername } from "./systemUser";
import { useModelsStore } from "../stores/modelsStore";
import { usePresetsStore } from "../stores/presetsStore";
import { usePricesStore } from "../stores/pricesStore";
import { useLayoutStore } from "../stores/layoutStore";
import { createTab, useTabsStore, type Tab } from "../stores/tabsStore";

function emptyAppState(): AppState {
  return {
    projectPath: "",
    lastSequence: "",
    lastShot: "",
    lastModel: "",
    sequencePrompt: "",
    shotPrompt: "",
    shotPrompts: [""],
    settings: {},
    refImages: [],
    iterations: 1,
  };
}

function toPersisted(l: ChainLink): ChainLinkPersisted {
  return {
    id: l.id,
    active: l.active,
    modelId: l.model?.id ?? null,
    settings: l.settings,
    sequencePrompt: l.sequencePrompt,
    shotPrompts: l.shotPrompts,
    refImages: l.refImages,
    consumesPrev: l.consumesPrev,
    sequencePromptIncluded: l.sequencePromptIncluded,
    sequenceScriptIncluded: l.sequenceScriptIncluded,
    shotScriptIncluded: l.shotScriptIncluded,
    shotPromptsIncluded: l.shotPromptsIncluded,
  };
}

/** Persisted link -> live link, resolving the model id against the registry.
 *  Shared with RESTORE CHAIN (actions.ts), which overlays its own resolved
 *  refs — one hydrator so the two paths can't drift over which fields they
 *  carry across (the inclusion flags did exactly that). */
export function linkFromPersisted(
  p: ChainLinkPersisted,
  entries: ModelEntry[],
): ChainLink {
  const model = p.modelId
    ? (entries.find((e) => e.node.id === p.modelId)?.node ?? null)
    : null;
  return makeChainLink({
    id: p.id,
    active: p.active,
    model,
    settings: p.settings ?? {},
    sequencePrompt: p.sequencePrompt ?? "",
    shotPrompts:
      Array.isArray(p.shotPrompts) && p.shotPrompts.length > 0
        ? p.shotPrompts
        : [""],
    refImages: Array.isArray(p.refImages) ? p.refImages : [],
    consumesPrev: !!p.consumesPrev,
    sequencePromptIncluded: p.sequencePromptIncluded,
    sequenceScriptIncluded: p.sequenceScriptIncluded,
    shotScriptIncluded: p.shotScriptIncluded,
    shotPromptsIncluded: p.shotPromptsIncluded,
  });
}

/** One tab's slice of the saved state. Paths are stored parent-relative rather
 *  than as bare names: in a native project these *are* the folder names, but a
 *  PRISM project needs the entity-root and `Renders/2dRender/AI` segments to
 *  survive so
 *  `restoreSessionPaths` can rejoin them. */
function tabToPersisted(tab: Tab): TabPersisted {
  const s = tab.stores.session.getState();
  const g = tab.stores.generation.getState();
  return {
    projectPath: s.projectPath ?? "",
    lastSequence: relativeTo(s.projectPath ?? "", s.sequencePath ?? ""),
    lastShot: relativeTo(s.sequencePath ?? "", s.shotPath ?? ""),
    prismEntityType: s.prism ? s.entityType : undefined,
    collapsedVersions: s.collapsedVersions,
    chainLinks: g.links.map(toPersisted),
    chainExpandedIdx: g.expandedIdx,
    iterations: g.iterations,
  };
}

function currentAppState(): AppState {
  const { tabs, activeId } = useTabsStore.getState();
  const activeIdx = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeId),
  );
  const persisted = tabs.map(tabToPersisted);
  const active = persisted[activeIdx];
  const activeGen = tabs[activeIdx].stores.generation.getState();
  const activeLink = selectActiveLink(activeGen);

  return {
    // Everything down to `chainExpandedIdx` mirrors the active tab, so an
    // aiSLAP build predating tabs still reopens the session the user was last
    // looking at. `tabs` at the bottom is the real record.
    projectPath: active.projectPath,
    lastSequence: active.lastSequence,
    lastShot: active.lastShot,
    prismEntityType: active.prismEntityType,
    lastModel: activeLink.model?.id ?? "",
    sequencePrompt: activeLink.sequencePrompt,
    // Keep legacy `shotPrompt` empty — the canonical store is `shotPrompts`.
    shotPrompt: "",
    shotPrompts: activeLink.shotPrompts,
    settings: activeLink.settings,
    refImages: activeLink.refImages,
    iterations: active.iterations,
    chainLinks: active.chainLinks,
    chainExpandedIdx: active.chainExpandedIdx,

    tabs: persisted,
    activeTabIdx: activeIdx,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Promote a pre-tabs saved state to a one-tab set. */
function legacyTab(appState: AppState): TabPersisted {
  return {
    projectPath: appState.projectPath ?? "",
    lastSequence: appState.lastSequence ?? "",
    lastShot: appState.lastShot ?? "",
    prismEntityType: appState.prismEntityType,
    chainLinks: Array.isArray(appState.chainLinks) ? appState.chainLinks : [],
    chainExpandedIdx: appState.chainExpandedIdx ?? 0,
    iterations: appState.iterations ?? 1,
  };
}

/** Rebuild a tab's chain. `chainLinks` is the modern record; a state with none
 *  falls back to the flat single-link fields. That fallback is not just for
 *  ancient files — until the Rust side stopped typing `app-state.json`, serde
 *  dropped `chainLinks` on every save, so every state written before this
 *  version has only the flat fields. */
function hydrateChain(
  tab: Tab,
  persisted: TabPersisted,
  legacy: AppState | null,
  entries: ModelEntry[],
): void {
  const gen = tab.stores.generation.getState();
  if (persisted.chainLinks.length > 0) {
    gen.setChain(
      persisted.chainLinks.map((p) => linkFromPersisted(p, entries)),
      persisted.chainExpandedIdx ?? 0,
    );
  } else if (legacy) {
    const model = legacy.lastModel
      ? (entries.find((e) => e.node.id === legacy.lastModel)?.node ?? null)
      : null;
    if (model) gen.selectModel(model);
    const settings = (legacy.settings ?? {}) as Record<string, unknown>;
    if (model) {
      for (const [k, v] of Object.entries(settings)) gen.setSetting(k, v);
    }
    gen.setSequencePrompt(legacy.sequencePrompt ?? "");
    gen.setShotPrompts(
      Array.isArray(legacy.shotPrompts) && legacy.shotPrompts.length > 0
        ? legacy.shotPrompts
        : legacy.shotPrompt
          ? [legacy.shotPrompt]
          : [""],
    );
    gen.setRefImages(legacy.refImages ?? []);
  }
  gen.setIterations(persisted.iterations ?? 1);
}

export async function bootstrap(): Promise<() => void> {
  // Kick off models + presets load early (independent).
  const modelsPromise = useModelsStore.getState().loadAll();
  const presetsPromise = usePresetsStore.getState().loadAll();

  const [appStateRaw, configRaw] = await Promise.all([
    cmd.app_state_load().catch(() => null),
    cmd.config_load().catch(() => null),
    modelsPromise,
    presetsPromise,
    loadSystemUsername(),
  ]);
  const appState: AppState = isRecord(appStateRaw)
    ? (appStateRaw as unknown as AppState)
    : emptyAppState();
  const config: Config | null = isRecord(configRaw)
    ? (configRaw as unknown as Config)
    : null;

  // Always apply colors at startup so CSS variables are explicit inline values.
  applyColors(config?.colors);

  // Seed cached fal prices (fetched manually via Settings) so cost labels
  // work without re-hitting fal's pricing API.
  usePricesStore
    .getState()
    .setPrices(config?.falPrices ?? {}, config?.falPricesFetchedAt ?? null);
  usePricesStore.getState().setOverrides(config?.priceOverrides ?? {});

  const entries = useModelsStore.getState().entries;

  // ---- Rebuild the tab set -------------------------------------------------
  const savedTabs = appState.tabs;
  const hasTabs = Array.isArray(savedTabs) && savedTabs.length > 0;
  const persistedTabs: TabPersisted[] = hasTabs
    ? savedTabs
    : [legacyTab(appState)];
  // Only the one-tab legacy shape may fall back to the flat fields; a real tab
  // set carries its chain per tab or not at all.
  const legacy = hasTabs ? null : appState;

  // Reuse the tab `tabsStore` created at module load as the first one, so the
  // proxies never see a moment with no tab behind them.
  const tabs: Tab[] = [useTabsStore.getState().tabs[0]];
  for (let i = 1; i < persistedTabs.length; i++) tabs.push(createTab());
  persistedTabs.forEach((p, i) => hydrateChain(tabs[i], p, legacy, entries));

  const activeIdx = Math.min(
    Math.max(0, appState.activeTabIdx ?? 0),
    tabs.length - 1,
  );
  useTabsStore.getState().setTabs(tabs, tabs[activeIdx].id);

  // One-time migration: these used to round-trip through Rust app_state.json;
  // now they live in layoutStore/localStorage. No-ops once localStorage has
  // ever been written (see migrateLegacyPanelSizes).
  if (isRecord(appStateRaw)) {
    const raw = appStateRaw as Record<string, unknown>;
    useLayoutStore.getState().migrateLegacyPanelSizes({
      galleryHeight:
        typeof raw.galleryHeight === "number" ? raw.galleryHeight : undefined,
      thumbColWidth:
        typeof raw.thumbColWidth === "number" ? raw.thumbColWidth : undefined,
      logHeight: typeof raw.logHeight === "number" ? raw.logHeight : undefined,
    });
  }

  // Restore session paths (project/sequence/shot) in the background — this
  // hits the filesystem (potentially a slow/offline network drive) and must
  // not block the UI from becoming interactive. Errors are logged, not
  // thrown: a failed restore just leaves the user with an empty session,
  // which they can fix via the project picker in SessionBar.
  //
  // The front tab goes first and the rest follow one at a time: each restore is
  // a burst of directory walks, and firing N of them at a network drive at once
  // would make the tab the user is actually waiting on the slowest to arrive.
  void (async () => {
    const rest = tabs.map((_, i) => i).filter((i) => i !== activeIdx);
    for (const i of [activeIdx, ...rest]) {
      await restoreSessionPaths(tabs[i], persistedTabs[i]).catch(
        swallow("background session restore"),
      );
    }
  })();

  return installPersistence();
}

// Same normalization setProject() applies internally, so we can tell whether
// the project we just restored is still the current one before proceeding.
const normalizeProjectPath = normalizeDir;

async function restoreSessionPaths(
  tab: Tab,
  persisted: TabPersisted,
): Promise<void> {
  if (!persisted.projectPath) return;
  // Always this tab's own store, never the `useSessionStore` proxy: the user
  // can switch tabs while a background restore is still walking directories.
  const store = tab.stores.session;
  store.getState().setRestoringLastSession(true);
  try {
    // Record the PRISM tree before opening: setProject lists sequences from
    // whichever tree is active. Harmless when the project turns out native.
    if (persisted.prismEntityType) {
      await store.getState().setEntityType(persisted.prismEntityType);
    }
    await store.getState().setProject(persisted.projectPath);
    // Bail if the user has since picked a different project themselves —
    // don't clobber their choice with a stale background restore.
    if (
      store.getState().projectPath !==
      normalizeProjectPath(persisted.projectPath)
    ) {
      return;
    }

    if (!persisted.lastSequence) return;
    const seqPath = joinPath(persisted.projectPath, persisted.lastSequence);
    try {
      // A tab saved with a sequence but no shot is a deliberate state — that's
      // exactly what a fresh tab is — so don't auto-open the latest shot for it.
      await store
        .getState()
        .setSequence(seqPath, { openLastShot: !!persisted.lastShot });
      if (store.getState().sequencePath !== seqPath) return;

      if (!persisted.lastShot) return;
      const shotPath = joinPath(seqPath, persisted.lastShot);
      try {
        await store.getState().setShot(shotPath);
        // After `setShot`, never before: collapse state belongs to `lastShot`,
        // and setShot has just cleared it as a shot move. No await in between,
        // so the shot it landed on is still the one we asked for. Skipped when
        // empty so a restore never rewrites state for nothing.
        if (persisted.collapsedVersions?.length) {
          store.getState().setCollapsedVersions(persisted.collapsedVersions);
        }
      } catch (e) {
        console.warn(`[bootstrap] shot restore failed for ${shotPath}:`, e);
      }
    } catch (e) {
      console.warn(`[bootstrap] sequence restore failed for ${seqPath}:`, e);
    }
  } catch (e) {
    console.warn(
      `[bootstrap] project restore failed for ${persisted.projectPath}:`,
      e,
    );
  } finally {
    store.getState().setRestoringLastSession(false);
  }
}

function installPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSerialized = JSON.stringify(currentAppState());

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const state = currentAppState();
      const serialized = JSON.stringify(state);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      void cmd.app_state_save(state).catch(swallow("app-state save"));
    }, 500);
  };

  // Gate on exactly the fields `tabToPersisted` reads. Subscribing to the whole
  // stores meant every job-progress tick — roughly once a second per in-flight
  // job — and every gallery rescan re-armed the debounce and ended in a full
  // JSON.stringify of the app state, for data that had not moved.
  //
  // Keep this list in sync with `tabToPersisted` above: `lastSerialized` means
  // a *missing* field here shows up as app-state silently not persisting,
  // never as a wrong write.
  //
  // Subscribed per tab and directly, never through the store proxies: a
  // background tab finishing its restore, or being renamed, still has to be
  // written, and a proxy only ever reports the tab in front.
  const perTab = new Map<string, () => void>();

  const subscribeTab = (tab: Tab) => {
    if (perTab.has(tab.id)) return;
    const unsubG = tab.stores.generation.subscribe((s, prev) => {
      if (
        s.links !== prev.links ||
        s.expandedIdx !== prev.expandedIdx ||
        s.iterations !== prev.iterations
      ) {
        schedule();
      }
    });
    const unsubS = tab.stores.session.subscribe((s, prev) => {
      if (
        s.projectPath !== prev.projectPath ||
        s.sequencePath !== prev.sequencePath ||
        s.shotPath !== prev.shotPath ||
        s.prism !== prev.prism ||
        s.entityType !== prev.entityType ||
        s.collapsedVersions !== prev.collapsedVersions
      ) {
        schedule();
      }
    });
    perTab.set(tab.id, () => {
      unsubG();
      unsubS();
    });
  };

  const syncSubscriptions = () => {
    const tabs = useTabsStore.getState().tabs;
    const live = new Set(tabs.map((t) => t.id));
    for (const [id, unsub] of perTab) {
      if (!live.has(id)) {
        unsub();
        perTab.delete(id);
      }
    }
    for (const tab of tabs) subscribeTab(tab);
  };
  syncSubscriptions();

  // The tab set itself is persisted state: opening, closing, reordering and
  // switching all change the file.
  const unsubTabs = useTabsStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) syncSubscriptions();
    if (s.tabs !== prev.tabs || s.activeId !== prev.activeId) schedule();
  });

  return () => {
    unsubTabs();
    for (const unsub of perTab.values()) unsub();
    perTab.clear();
    if (timer) clearTimeout(timer);
  };
}
