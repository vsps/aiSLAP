import { cmd } from "./tauri";
import { joinPath, normalizeDir, relativeTo } from "./paths";
import { applyColors } from "./colors";
import type {
  AppState,
  ChainLink,
  ChainLinkPersisted,
  Config,
  ModelEntry,
} from "./types";
import {
  makeChainLink,
  selectActiveLink,
  useGenerationStore,
} from "../stores/generationStore";
import { swallow } from "./errors";
import { useModelsStore } from "../stores/modelsStore";
import { usePresetsStore } from "../stores/presetsStore";
import { usePricesStore } from "../stores/pricesStore";
import { useSessionStore } from "../stores/sessionStore";
import { useLayoutStore } from "../stores/layoutStore";

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

function currentAppState(): AppState {
  const g = useGenerationStore.getState();
  const s = useSessionStore.getState();
  const active = selectActiveLink(g);
  return {
    projectPath: s.projectPath ?? "",
    // Parent-relative rather than bare names: in a native project these *are*
    // the folder names, but a PRISM project needs the entity-root and
    // `Renders/AI` segments to survive so restoreSessionPaths can rejoin them.
    lastSequence: relativeTo(s.projectPath ?? "", s.sequencePath ?? ""),
    lastShot: relativeTo(s.sequencePath ?? "", s.shotPath ?? ""),
    prismEntityType: s.prism ? s.entityType : undefined,
    lastModel: active.model?.id ?? "",
    sequencePrompt: active.sequencePrompt,
    // Keep legacy `shotPrompt` empty — the canonical store is `shotPrompts`.
    shotPrompt: "",
    shotPrompts: active.shotPrompts,
    settings: active.settings,
    refImages: active.refImages,
    iterations: g.iterations,
    chainLinks: g.links.map(toPersisted),
    chainExpandedIdx: g.expandedIdx,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  const gen = useGenerationStore.getState();

  if (Array.isArray(appState.chainLinks) && appState.chainLinks.length > 0) {
    // New-format chain: restore the full link array.
    const links = appState.chainLinks.map((p) => linkFromPersisted(p, entries));
    gen.setChain(links, appState.chainExpandedIdx ?? 0);
  } else {
    // Legacy single-link state: rebuild a one-link chain from flat fields.
    const persistedModel = appState.lastModel
      ? (entries.find((e) => e.node.id === appState.lastModel)?.node ?? null)
      : null;
    if (persistedModel) gen.selectModel(persistedModel);
    const persistedSettings = (appState.settings ?? {}) as Record<string, unknown>;
    if (
      persistedModel &&
      persistedSettings &&
      typeof persistedSettings === "object"
    ) {
      for (const [k, v] of Object.entries(persistedSettings)) {
        gen.setSetting(k, v);
      }
    }
    gen.setSequencePrompt(appState.sequencePrompt ?? "");
    const persistedShotPrompts =
      Array.isArray(appState.shotPrompts) && appState.shotPrompts.length > 0
        ? appState.shotPrompts
        : appState.shotPrompt
          ? [appState.shotPrompt]
          : [""];
    gen.setShotPrompts(persistedShotPrompts);
    gen.setRefImages(appState.refImages ?? []);
  }
  gen.setIterations(appState.iterations ?? 1);

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
  void restoreSessionPaths(appState).catch(
    swallow("background session restore"),
  );

  return installPersistence();
}

// Same normalization setProject() applies internally, so we can tell whether
// the project we just restored is still the current one before proceeding.
const normalizeProjectPath = normalizeDir;

async function restoreSessionPaths(appState: AppState): Promise<void> {
  if (!appState.projectPath) return;
  const session = useSessionStore.getState();
  session.setRestoringLastSession(true);
  try {
    // Record the PRISM tree before opening: setProject lists sequences from
    // whichever tree is active. Harmless when the project turns out native.
    if (appState.prismEntityType) {
      await session.setEntityType(appState.prismEntityType);
    }
    await session.setProject(appState.projectPath);
    // Bail if the user has since picked a different project themselves —
    // don't clobber their choice with a stale background restore.
    if (
      useSessionStore.getState().projectPath !==
      normalizeProjectPath(appState.projectPath)
    ) {
      return;
    }

    if (!appState.lastSequence) return;
    const seqPath = joinPath(appState.projectPath, appState.lastSequence);
    try {
      await useSessionStore.getState().setSequence(seqPath);
      if (useSessionStore.getState().sequencePath !== seqPath) return;

      if (!appState.lastShot) return;
      const shotPath = joinPath(seqPath, appState.lastShot);
      try {
        await useSessionStore.getState().setShot(shotPath);
      } catch (e) {
        console.warn(`[bootstrap] shot restore failed for ${shotPath}:`, e);
      }
    } catch (e) {
      console.warn(`[bootstrap] sequence restore failed for ${seqPath}:`, e);
    }
  } catch (e) {
    console.warn(
      `[bootstrap] project restore failed for ${appState.projectPath}:`,
      e,
    );
  } finally {
    session.setRestoringLastSession(false);
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

  // Gate on exactly the fields `currentAppState` reads. Subscribing to the
  // whole stores meant every job-progress tick — roughly once a second per
  // in-flight job — and every gallery rescan re-armed the debounce and ended
  // in a full JSON.stringify of the app state, for data that had not moved.
  //
  // Keep this list in sync with `currentAppState` above: `lastSerialized`
  // means a *missing* field here shows up as app-state silently not
  // persisting, never as a wrong write.
  const unsubG = useGenerationStore.subscribe((s, prev) => {
    if (
      s.links !== prev.links ||
      s.expandedIdx !== prev.expandedIdx ||
      s.iterations !== prev.iterations
    ) {
      schedule();
    }
  });
  const unsubS = useSessionStore.subscribe((s, prev) => {
    if (
      s.projectPath !== prev.projectPath ||
      s.sequencePath !== prev.sequencePath ||
      s.shotPath !== prev.shotPath ||
      s.prism !== prev.prism ||
      s.entityType !== prev.entityType
    ) {
      schedule();
    }
  });

  return () => {
    unsubG();
    unsubS();
    if (timer) clearTimeout(timer);
  };
}
