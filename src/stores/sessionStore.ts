import { createStore } from "zustand";
import type {
  GalleryColumn,
  GalleryImage,
  PrismEntityType,
  PrismInfo,
  PromptHistoryChannel,
  RefImage,
  SequenceSidecar,
  SequenceStacks,
  ShotSidecar,
  SeqTaggedGroup,
} from "../lib/types";
import { cmd } from "../lib/tauri";
import { tabScoped } from "./tabScoped";
import type { TabStores } from "./tabStores";
import { swallow } from "../lib/errors";
import { basename, normalizeDir } from "../lib/paths";
import { entityFor } from "../lib/prism";
import { coalesceAsync } from "../lib/coalesce";
import { reportOutboxSync } from "../lib/outboxSync";
import { pushLog } from "./logStore";

type PromptScope = "sequence" | "shot";
type ViewMode = "columns" | "tagged" | "stacked";

type State = {
  projectPath: string | null;
  /** Stable identity UUID for the open project — minted on first open, then
   *  persisted to project.json. The join key for a future central asset
   *  index; also stamped into every output's sidecar + embedded media tag. */
  projectId: string | null;
  /** Read-only derived project name — PRISM's pipeline.json name, else the
   *  folder name. Display only; there is no setter. */
  projectTitle: string | null;
  sequencePath: string | null;
  /** Where this shot's media lives. In a PRISM project that's the
   *  `<entity>/Renders/AI` media root, not the entity folder — everything
   *  downstream (version columns, SRC, sidecars, tags) keys off it. */
  shotPath: string | null;
  /** PRISM only: the entity folder `shotPath` belongs to, for the dropdown and
   *  for labels. Null in a native project, where the entity *is* the shot. */
  shotEntityPath: string | null;

  /** PRISM layout for the open project, or null for a plain aiSLAP project. */
  prism: PrismInfo | null;
  /** Which PRISM entity tree is being browsed. Ignored when `prism` is null. */
  entityType: PrismEntityType;

  sequencesInProject: string[]; // absolute paths
  shotsInSequence: string[]; // absolute paths (entity folders under PRISM)

  columns: GalleryColumn[];
  selectedImagePath: string | null;
  zoomImagePath: string | null;
  infoImagePath: string | null;
  zoomInitialMode: "draw" | "crop" | "trim" | null;
  renameImagePath: string | null;
  /** Image whose tag editor is open, plus where to anchor the popover
   *  (null anchor = centered, for invocations with no on-screen origin such
   *  as the context menu). */
  tagEditor: { path: string; anchor: { x: number; y: number } | null } | null;
  imageDrag: { fromPath: string } | null;
  targetVersion: string | null;

  /** Preview compare mode — wipe/flicker A vs B. Ephemeral, reset per shot. */
  compareMode: boolean;
  compareA: string | null;
  compareB: string | null;

  sequenceHistory: PromptHistoryChannel;
  shotHistory: PromptHistoryChannel;
  /** Per-version short comments for the current shot, keyed by version dir name. */
  versionComments: Record<string, string>;

  /** Active trace: the seed image, the full ancestor set, and the parent
   *  refs captured during traversal (used to draw the dependency edges). */
  traceActive: {
    imagePath: string;
    traceSet: Set<string>;
    parents: Map<string, RefImage[]>;
  } | null;

  viewMode: ViewMode;
  taggedGroups: SeqTaggedGroup[];
  taggedLoading: boolean;
  sequenceStacks: SequenceStacks | null;
  sequenceStacksLoading: boolean;

  /** Gallery thumbnails render nothing (a "click to load" placeholder instead)
   *  until the user opts in — avoids flooding a slow/network project dir with
   *  reads the moment the app starts. Resets every launch (not persisted). */
  thumbnailsEnabled: boolean;
  /** True while bootstrap is restoring the last-used project/sequence/shot in
   *  the background (see lib/bootstrap.ts) — surfaced as a status hint since
   *  it no longer blocks the UI from becoming interactive. */
  restoringLastSession: boolean;
};

type Actions = {
  setProject: (projectPath: string) => Promise<void>;
  /** `openLastShot` defaults to true — picking a sequence lands you on its
   *  most recent shot. A newly opened tab passes false: it inherits the
   *  sequence but deliberately starts with no shot selected. */
  setSequence: (
    sequencePath: string,
    opts?: { openLastShot?: boolean },
  ) => Promise<void>;
  /** Accepts a PRISM entity folder or an AI media root — either resolves to
   *  the media root, creating it on first visit. */
  setShot: (shotPath: string) => Promise<void>;
  /** PRISM only: switch between the shot and asset trees. Re-lists sequences
   *  and clears the current selection. */
  setEntityType: (entityType: PrismEntityType) => Promise<void>;
  rescanShot: () => Promise<void>;
  setTargetVersion: (version: string | null) => void;
  createSequence: (name: string) => Promise<void>;
  createShot: (name: string) => Promise<void>;
  setSequencesInProject: (paths: string[]) => void;
  setShotsInSequence: (paths: string[]) => void;
  createNextVersion: () => Promise<string>;

  setSelectedImage: (path: string | null) => void;
  setZoomImage: (path: string | null) => void;
  setInfoImage: (path: string | null) => void;
  setZoomInitialMode: (mode: "draw" | "crop" | "trim" | null) => void;
  setRenameImage: (path: string | null) => void;
  setTagEditor: (
    path: string | null,
    anchor?: { x: number; y: number } | null,
  ) => void;
  setImageDrag: (drag: State["imageDrag"]) => void;
  setTrace: (state: State["traceActive"]) => void;

  setCompareMode: (enabled: boolean) => void;
  setCompareSlot: (slot: "a" | "b", path: string | null) => void;

  setViewMode: (mode: ViewMode) => void;
  rescanTagged: () => Promise<void>;
  rescanSequenceStacks: () => Promise<void>;

  navigatePromptHistory: (scope: PromptScope, delta: number) => void;
  snapToLive: (scope: PromptScope) => void;

  hydrateSequenceSidecar: (sidecar: SequenceSidecar | null) => void;
  hydrateShotSidecar: (sidecar: ShotSidecar | null) => void;
  /** Set or clear a per-version comment on the current shot; persists to shot.json. */
  setVersionComment: (version: string, comment: string) => Promise<void>;

  enableThumbnails: () => void;
  setRestoringLastSession: (v: boolean) => void;
};

const emptyChannel = (): PromptHistoryChannel => ({ entries: [], cursor: 0 });

/** Read the project's identity UUID, minting and persisting one via
 *  crypto.randomUUID() on first touch — keeps id generation on the TS side,
 *  consistent with every other id (job, chain, ref) in the app. */
async function ensureProjectId(projectPath: string): Promise<string> {
  const existing = await cmd.project_id_get(projectPath);
  if (existing) return existing;
  const minted = crypto.randomUUID();
  await cmd.project_id_set(projectPath, minted);
  return minted;
}

function latestVersion(columns: GalleryColumn[]): string | null {
  const vs = columns.filter((c) => !c.isSrc).map((c) => c.version);
  return vs.length ? vs[vs.length - 1] : null;
}

/** Everything that has to be dropped when the sequence list changes under us —
 *  picking a project, or flipping the PRISM entity tree. */
function clearedSelection() {
  return {
    sequencePath: null,
    shotPath: null,
    shotEntityPath: null,
    shotsInSequence: [],
    columns: [],
    targetVersion: null,
    selectedImagePath: null,
    sequenceHistory: emptyChannel(),
    shotHistory: emptyChannel(),
    versionComments: {},
  };
}

// ---------- path -> image lookup ----------
//
// Seven call sites independently did `columns.flatMap(c => c.images).find(...)`.
// One of them (TraceView) ran it once per traced node *inside* the render, so a
// 40-node trace over a 500-image shot flattened 20,000 entries and allocated 40
// throwaway arrays every paint.
//
// Cached on the identity of the source array, which is exactly the granularity
// the store already updates at: a rescan or a tag patch produces a new array and
// invalidates the index; anything else reuses it. Returning a stable reference
// also makes these safe to use directly as zustand selectors without
// `useShallow`.
//
// The two views are cached separately on purpose — a single shared entry would
// alternate between `columns` and `taggedGroups` and never hit.

let columnsIndexSrc: unknown = null;
let columnsIndex: Map<string, GalleryImage> = new Map();
let taggedIndexSrc: unknown = null;
let taggedIndex: Map<string, GalleryImage> = new Map();

/** Path -> image across every loaded column, `images` taking precedence over
 *  `srcImages` (the order the callers this replaced searched in).
 *
 *  Pass the raw `columns` array only. A derived array — a filtered view, or one
 *  carrying pending placeholders — is rebuilt every render and would thrash the
 *  single-entry cache into uselessness. Placeholder paths (`pending://…`) are
 *  therefore absent by design, so callers keep their `?? syntheticImage(path)`
 *  fallback. */
export function imageIndexOf(
  columns: GalleryColumn[],
): Map<string, GalleryImage> {
  if (columns !== columnsIndexSrc) {
    const next = new Map<string, GalleryImage>();
    for (const c of columns) for (const i of c.images) next.set(i.path, i);
    for (const c of columns)
      for (const i of c.srcImages ?? [])
        if (!next.has(i.path)) next.set(i.path, i);
    columnsIndex = next;
    columnsIndexSrc = columns;
  }
  return columnsIndex;
}

/** Same, for the project-wide tag view. */
export function taggedImageIndexOf(
  taggedGroups: SeqTaggedGroup[],
): Map<string, GalleryImage> {
  if (taggedGroups !== taggedIndexSrc) {
    const next = new Map<string, GalleryImage>();
    for (const g of taggedGroups)
      for (const sh of g.shots) for (const i of sh.images) next.set(i.path, i);
    taggedIndex = next;
    taggedIndexSrc = taggedGroups;
  }
  return taggedIndex;
}

/** Stable-reference selectors, safe to use directly without `useShallow`. */
export const selectImageByPath = (s: State) => imageIndexOf(s.columns);
export const selectTaggedImageByPath = (s: State) =>
  taggedImageIndexOf(s.taggedGroups);

/** Look a path up in either loaded view. */
export function findLoadedImage(path: string): GalleryImage | undefined {
  const s = useSessionStore.getState();
  return selectImageByPath(s).get(path) ?? selectTaggedImageByPath(s).get(path);
}

export type SessionState = State & Actions;

/**
 * Per-tab: this is the tab's identity — which project, sequence and shot it is
 * pointed at, and everything the gallery loaded for it.
 *
 * `tab` is this tab's own bundle, so the cross-store reaches below (timeline
 * reset on project change, script load, tag vocabulary) hit *this* tab's
 * siblings. Going through the `useTimelineStore` proxy instead would land on
 * whichever tab happened to be in front, which breaks the moment bootstrap
 * restores a background tab or a rename runs while the user is elsewhere.
 */
export function createSessionStore(tab: TabStores) {
  const timeline = () => tab.timeline.getState();
  const script = () => tab.script.getState();
  const tags = () => tab.tags.getState();

  return createStore<SessionState>()((set, get) => {
  const coalescedRescanShot = coalesceAsync(async () => {
    const { shotPath } = get();
    if (!shotPath) return;
    const columns = await cmd.shot_rescan(shotPath);
    // The user may have navigated to a different shot while this was
    // in flight — discard rather than clobber `columns` with stale data.
    if (get().shotPath !== shotPath) return;
    set((s) => ({
      columns,
      targetVersion:
        s.targetVersion && columns.some((c) => c.version === s.targetVersion)
          ? s.targetVersion
          : latestVersion(columns),
    }));
    if (get().viewMode === "tagged") {
      void get().rescanTagged();
    } else if (get().viewMode === "stacked") {
      void get().rescanSequenceStacks();
    }
  });

  return {
    projectPath: null,
    projectId: null,
    projectTitle: null,
    sequencePath: null,
    shotPath: null,
    shotEntityPath: null,

    prism: null,
    entityType: "shot",

    sequencesInProject: [],
    shotsInSequence: [],

    columns: [],
    selectedImagePath: null,
    zoomImagePath: null,
    infoImagePath: null,
    zoomInitialMode: null,
    renameImagePath: null,
    tagEditor: null,
    imageDrag: null,
    targetVersion: null,

    compareMode: false,
    compareA: null,
    compareB: null,

    sequenceHistory: emptyChannel(),
    shotHistory: emptyChannel(),
    versionComments: {},

    traceActive: null,

    viewMode: "columns",
    taggedGroups: [],
    taggedLoading: false,
    sequenceStacks: null,
    sequenceStacksLoading: false,

    thumbnailsEnabled: false,
    restoringLastSession: false,

    async setProject(projectPath) {
      // Rust's list_dirs returns forward-slash paths. Normalize the incoming path
      // the same way so the PROJECT/SEQUENCE/SHOT dropdowns string-match their options.
      const normalized = normalizeDir(projectPath);
      // A PRISM project keeps its entities under 03_Production/Shots|Assets, so
      // the layout has to be known before sequences can be listed.
      const prism = await cmd.prism_detect(normalized).catch(() => null);
      // Log it: which layout is in play decides where every output lands, and
      // the only other signal is whether the SHOT/ASSET toggle appeared.
      pushLog(
        "INFO",
        prism
          ? `PRISM project${prism.projectName ? ` ${prism.projectName}` : ""} — entities under ${prism.shotsRoot.slice(normalized.length + 1)}, versions v${"0".repeat(Math.max(0, prism.versionPadding - 1))}1`
          : `aiSLAP project (no 00_Pipeline/pipeline.json) — ${normalized}`,
      );
      const entityType = get().entityType;
      const sequences = await cmd.project_open(
        normalized,
        prism ? entityType : undefined,
      );
      set({
        projectPath: normalized,
        projectId: null,
        // PRISM's pipeline.json name when set, else the folder name — same
        // rule the Rust side uses for the title it mirrors into the DB
        // index (see project_title_for in commands/session.rs).
        projectTitle: prism?.projectName || basename(normalized),
        prism,
        sequencesInProject: sequences,
        ...clearedSelection(),
      });
      timeline().reset();
      void script().loadFor(normalized);
      // One-shot conversion of the old star list + SEL folders into tags,
      // then load the vocabulary. Awaited (unlike reconcile below) because
      // the gallery renders tags immediately and this is cheap — it only
      // touches files the conversion actually applies to, once per project.
      void (async () => {
        try {
          const report = await cmd.project_tags_migrate(normalized);
          if (report.ran && (report.starred || report.selects)) {
            pushLog(
              "INFO",
              `Tags: migrated ${report.starred} starred, ${report.selects} selects`,
            );
          }
        } catch (e) {
          swallow("tag migration")(e);
        }
        await tags().loadDefs(normalized);
        if (get().projectPath === normalized) void get().rescanShot();
      })();
      // Best-effort: a project with no id yet gets one minted and persisted.
      // Failure just leaves projectId null — asset embedding degrades to an
      // empty project tag rather than blocking project open.
      void ensureProjectId(normalized)
        .then((id) => {
          if (get().projectPath === normalized) set({ projectId: id });
        })
        .catch(swallow("project id mint"));
      // Flush anything queued from a prior offline/no-Turso-configured
      // session. Best-effort and fire-and-forget — never blocks opening.
      void cmd
        .db_sync_outbox(normalized)
        .then(reportOutboxSync)
        .catch(swallow("turso outbox sync"));
      // Self-heal the asset index in the background: assigns ids to
      // anything generated before Phase 1, relinks files moved outside the
      // app since the last scan. Fire-and-forget — hashing every media file
      // can take a while on a large project; the app stays interactive.
      void (async () => {
        const config = await cmd.config_load().catch(() => null);
        const report = await cmd
          .project_reconcile(normalized, config?.ffmpegPath ?? "")
          .catch(() => null);
        if (!report) return;
        if (
          report.sidecarBackfilled ||
          report.dbIngested ||
          report.relinked ||
          report.tagsSynced
        ) {
          pushLog(
            "INFO",
            `Asset index: ${report.sidecarBackfilled} backfilled, ${report.dbIngested} ingested, ${report.relinked} relinked, ${report.tagsSynced} tags synced`,
          );
        }
      })();
    },

    async setSequence(sequencePath, opts) {
      const openLastShot = opts?.openLastShot ?? true;
      const { shots, sidecar } = await cmd.sequence_open(sequencePath);
      set({
        sequencePath,
        shotsInSequence: shots,
        shotPath: null,
        columns: [],
        targetVersion: null,
        selectedImagePath: null,
        sequenceHistory: {
          entries: sidecar.promptHistory,
          cursor: sidecar.promptHistory.length,
        },
        shotHistory: emptyChannel(),
        versionComments: {},
        taggedGroups: [],
      });
      if (get().viewMode === "tagged") {
        void get().rescanTagged();
      } else if (get().viewMode === "stacked") {
        void get().rescanSequenceStacks();
      }
      // Kick the timeline load in parallel with the shot load — they're independent.
      const timelineLoad = timeline()
        .loadForSequence(sequencePath)
        .catch(swallow("timeline init"));
      if (openLastShot && shots.length > 0) {
        await get().setShot(shots[shots.length - 1]);
      }
      await timelineLoad;
    },

    async setEntityType(entityType) {
      if (get().entityType === entityType) return;
      set({ entityType });
      const { projectPath, prism } = get();
      // No project open yet (bootstrap sets the persisted type first), or a
      // native project where the switch has no meaning — nothing to re-list.
      if (!projectPath || !prism) return;
      const sequences = await cmd.project_open(projectPath, entityType);
      set({ sequencesInProject: sequences, ...clearedSelection() });
      timeline().reset();
    },

    async setShot(shotPath) {
      // PRISM: media lives in `<entity>/Renders/AI`. Accept either the entity
      // folder (from the dropdown) or a media root (from session restore), and
      // create the folder on first visit — it's an output dir inside an entity
      // PRISM already made, not a pipeline entity.
      const { prism, shotPath: prevShotPath, targetVersion: prevTargetVersion } =
        get();
      let resolved = shotPath;
      let entityPath: string | null = null;
      if (prism) {
        entityPath = entityFor(shotPath) ?? normalizeDir(shotPath);
        resolved = await cmd.prism_media_root_ensure(entityPath);
      }
      const { columns, sidecar } = await cmd.shot_open(resolved);
      // Re-opening the shot that's already active (e.g. re-clicking it in
      // StackedView, or another collaborator adding a version elsewhere)
      // must not clobber an explicit local selection — only a genuine
      // switch to a different shot, or a selection whose version no longer
      // exists, falls back to "latest on disk".
      const sameShot = prevShotPath === resolved;
      const targetVersion =
        sameShot &&
        prevTargetVersion &&
        columns.some((c) => c.version === prevTargetVersion)
          ? prevTargetVersion
          : latestVersion(columns);
      set({
        shotPath: resolved,
        shotEntityPath: entityPath,
        columns,
        targetVersion,
        selectedImagePath: null,
        compareMode: false,
        compareA: null,
        compareB: null,
        versionComments: sidecar.versionComments ?? {},
        shotHistory: {
          entries: sidecar.promptHistory,
          cursor: sidecar.promptHistory.length,
        },
      });
    },

    async rescanShot() {
      if (!get().shotPath) return;
      await coalescedRescanShot();
    },

    setTargetVersion(version) {
      set({ targetVersion: version });
    },

    async createSequence(name) {
      const { projectPath } = get();
      if (!projectPath) throw new Error("no project");
      const seqPath = await cmd.sequence_create(projectPath, name);
      const sequences = await cmd.project_open(projectPath, get().entityType);
      set({ sequencesInProject: sequences });
      await get().setSequence(seqPath);
    },

    async createShot(name) {
      const { sequencePath } = get();
      if (!sequencePath) throw new Error("no sequence");
      const shotPath = await cmd.shot_create(sequencePath, name);
      const { shots } = await cmd.sequence_open(sequencePath);
      set({ shotsInSequence: shots });
      const tl = timeline();
      if (tl.seqPath === sequencePath) tl.appendShotClip(shotPath);
      await get().setShot(shotPath);
    },

    setSequencesInProject(paths) {
      set({ sequencesInProject: paths });
    },
    setShotsInSequence(paths) {
      set({ shotsInSequence: paths });
    },

    async createNextVersion() {
      const { shotPath } = get();
      if (!shotPath) throw new Error("no shot");
      const version = await cmd.version_create_next(shotPath);
      await get().rescanShot();
      set({ targetVersion: version });
      return version;
    },

    setSelectedImage(path) {
      if (path !== null) {
        const tl = timeline();
        if (tl.timelineActive) tl.deactivate();
      }
      set({ selectedImagePath: path });
    },

    setZoomImage(path) {
      set({ zoomImagePath: path });
    },

    setZoomInitialMode(mode) {
      set({ zoomInitialMode: mode });
    },

    setRenameImage(path) {
      set({ renameImagePath: path });
    },

    setTagEditor(path, anchor = null) {
      set({ tagEditor: path ? { path, anchor } : null });
    },

    setInfoImage(path) {
      set({ infoImagePath: path });
    },

    setImageDrag(drag) {
      set({ imageDrag: drag });
    },

    setTrace(state) {
      set({ traceActive: state });
    },

    setCompareMode(enabled) {
      set({ compareMode: enabled });
    },

    setCompareSlot(slot, path) {
      set(slot === "a" ? { compareA: path } : { compareB: path });
    },

    setViewMode(mode) {
      set({ viewMode: mode });
      if (mode === "tagged") {
        void get().rescanTagged();
      } else if (mode === "stacked") {
        void get().rescanSequenceStacks();
      }
    },

    async rescanTagged() {
      const { projectPath } = get();
      if (!projectPath) {
        set({ taggedGroups: [], taggedLoading: false });
        return;
      }
      const { activeFilter, filterMode } = tags();
      set({ taggedLoading: true });
      try {
        const groups = await cmd.project_tag_scan(
          projectPath,
          activeFilter,
          filterMode,
        );
        set({ taggedGroups: groups, taggedLoading: false });
      } catch (e) {
        set({ taggedLoading: false });
        throw e;
      }
    },

    async rescanSequenceStacks() {
      const { sequencePath } = get();
      if (!sequencePath) {
        set({ sequenceStacks: null, sequenceStacksLoading: false });
        return;
      }
      set({ sequenceStacksLoading: true });
      try {
        const stacks = await cmd.sequence_stacks_scan(sequencePath);
        set({ sequenceStacks: stacks, sequenceStacksLoading: false });
      } catch (e) {
        set({ sequenceStacksLoading: false });
        throw e;
      }
    },

    navigatePromptHistory(scope, delta) {
      set((s) => {
        const ch = scope === "sequence" ? s.sequenceHistory : s.shotHistory;
        const next = Math.max(
          0,
          Math.min(ch.entries.length, ch.cursor + delta),
        );
        const patch = { ...ch, cursor: next };
        return scope === "sequence"
          ? { sequenceHistory: patch }
          : { shotHistory: patch };
      });
    },

    snapToLive(scope) {
      set((s) => {
        const ch = scope === "sequence" ? s.sequenceHistory : s.shotHistory;
        if (ch.cursor === ch.entries.length) return {} as Partial<State>;
        const patch = { ...ch, cursor: ch.entries.length };
        return scope === "sequence"
          ? { sequenceHistory: patch }
          : { shotHistory: patch };
      });
    },

    hydrateSequenceSidecar(sidecar) {
      const entries = sidecar?.promptHistory ?? [];
      set({ sequenceHistory: { entries, cursor: entries.length } });
    },
    hydrateShotSidecar(sidecar) {
      const entries = sidecar?.promptHistory ?? [];
      set({
        shotHistory: { entries, cursor: entries.length },
        versionComments: sidecar?.versionComments ?? {},
      });
    },

    async setVersionComment(version, comment) {
      const shotPath = get().shotPath;
      if (!shotPath) return;
      const trimmed = comment.trim();
      try {
        await cmd.shot_version_comment_set(shotPath, version, trimmed || null);
      } catch (e) {
        console.error("[versionComment] save failed", e);
        throw e;
      }
      set((s) => {
        const next = { ...s.versionComments };
        if (trimmed) next[version] = trimmed;
        else delete next[version];
        return { versionComments: next };
      });
    },

    enableThumbnails() {
      set({ thumbnailsEnabled: true });
    },
    setRestoringLastSession(v) {
      set({ restoringLastSession: v });
    },
  };
  });
}

export const useSessionStore = tabScoped((t) => t.session);
