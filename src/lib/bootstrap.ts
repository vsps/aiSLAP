import { cmd } from "./tauri";
import { basename, joinPath } from "./paths";
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
import { useSessionStore } from "../stores/sessionStore";

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
    galleryHeight: 400,
    thumbColWidth: 120,
    logHeight: 78,
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

function fromPersisted(p: ChainLinkPersisted, entries: ModelEntry[]): ChainLink {
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
    lastSequence: basename(s.sequencePath),
    lastShot: basename(s.shotPath),
    lastModel: active.model?.id ?? "",
    sequencePrompt: active.sequencePrompt,
    // Keep legacy `shotPrompt` empty — the canonical store is `shotPrompts`.
    shotPrompt: "",
    shotPrompts: active.shotPrompts,
    settings: active.settings,
    refImages: active.refImages,
    iterations: g.iterations,
    galleryHeight: s.galleryHeight,
    thumbColWidth: s.thumbColWidth,
    logHeight: s.logHeight,
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

  const entries = useModelsStore.getState().entries;
  const gen = useGenerationStore.getState();

  if (Array.isArray(appState.chainLinks) && appState.chainLinks.length > 0) {
    // New-format chain: restore the full link array.
    const links = appState.chainLinks.map((p) => fromPersisted(p, entries));
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

  // Restore UI layout prefs (clamped by store setters).
  if (typeof appState.galleryHeight === "number") {
    useSessionStore.getState().setGalleryHeight(appState.galleryHeight);
  }
  if (typeof appState.thumbColWidth === "number") {
    useSessionStore.getState().setThumbColWidth(appState.thumbColWidth);
  }
  if (typeof appState.logHeight === "number") {
    useSessionStore.getState().setLogHeight(appState.logHeight);
  }

  // Restore session paths.
  const session = useSessionStore.getState();
  if (appState.projectPath) {
    try {
      await session.setProject(appState.projectPath);
      if (appState.lastSequence) {
        const seqPath = joinPath(appState.projectPath, appState.lastSequence);
        try {
          await useSessionStore.getState().setSequence(seqPath);
          if (appState.lastShot) {
            const sp = useSessionStore.getState().sequencePath;
            if (sp) {
              const shotPath = joinPath(sp, appState.lastShot);
              try {
                await useSessionStore.getState().setShot(shotPath);
              } catch (e) {
                console.warn(
                  `[bootstrap] shot restore failed for ${shotPath}:`,
                  e,
                );
              }
            }
          }
        } catch (e) {
          console.warn(
            `[bootstrap] sequence restore failed for ${seqPath}:`,
            e,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[bootstrap] project restore failed for ${appState.projectPath}:`,
        e,
      );
    }
  }

  return installPersistence();
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

  const unsubG = useGenerationStore.subscribe(schedule);
  const unsubS = useSessionStore.subscribe(schedule);

  return () => {
    unsubG();
    unsubS();
    if (timer) clearTimeout(timer);
  };
}
