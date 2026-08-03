import { create } from "zustand";
import type {
  GalleryColumn,
  PromptHistoryChannel,
  RefImage,
  SequenceSidecar,
  SequenceStacks,
  ShotSidecar,
  SeqTaggedGroup,
} from "../lib/types";
import { cmd } from "../lib/tauri";
import { useTimelineStore } from "./timelineStore";
import { useScriptStore } from "./scriptStore";
import { useTagsStore } from "./tagsStore";
import { swallow } from "../lib/errors";
import { normalizeDir } from "../lib/paths";
import { coalesceAsync } from "../lib/coalesce";
import { pushLog } from "./logStore";

type PromptScope = "sequence" | "shot";
type ViewMode = "columns" | "tagged" | "stacked";

type State = {
  projectPath: string | null;
  /** Stable identity UUID for the open project — minted on first open, then
   *  persisted to project.json. The join key for a future central asset
   *  index; also stamped into every output's sidecar + embedded media tag. */
  projectId: string | null;
  sequencePath: string | null;
  shotPath: string | null;

  sequencesInProject: string[]; // absolute paths
  shotsInSequence: string[]; // absolute paths

  columns: GalleryColumn[];
  selectedImagePath: string | null;
  zoomImagePath: string | null;
  infoImagePath: string | null;
  zoomInitialMode: "draw" | "crop" | null;
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
  setSequence: (sequencePath: string) => Promise<void>;
  setShot: (shotPath: string) => Promise<void>;
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
  setZoomInitialMode: (mode: "draw" | "crop" | null) => void;
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

export const useSessionStore = create<State & Actions>((set, get) => {
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
    sequencePath: null,
    shotPath: null,

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
      const sequences = await cmd.project_open(normalized);
      set({
        projectPath: normalized,
        projectId: null,
        sequencesInProject: sequences,
        sequencePath: null,
        shotPath: null,
        shotsInSequence: [],
        columns: [],
        targetVersion: null,
        selectedImagePath: null,
        sequenceHistory: emptyChannel(),
        shotHistory: emptyChannel(),
        versionComments: {},
      });
      useTimelineStore.getState().reset();
      void useScriptStore.getState().loadFor(normalized);
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
        await useTagsStore.getState().loadDefs(normalized);
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
      void cmd.db_sync_outbox(normalized).catch(swallow("turso outbox sync"));
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

    async setSequence(sequencePath) {
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
      const timelineLoad = useTimelineStore
        .getState()
        .loadForSequence(sequencePath)
        .catch(swallow("timeline init"));
      if (shots.length > 0) {
        await get().setShot(shots[shots.length - 1]);
      }
      await timelineLoad;
    },

    async setShot(shotPath) {
      const { columns, sidecar } = await cmd.shot_open(shotPath);
      set({
        shotPath,
        columns,
        targetVersion: latestVersion(columns),
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
      const sequences = await cmd.project_open(projectPath);
      set({ sequencesInProject: sequences });
      await get().setSequence(seqPath);
    },

    async createShot(name) {
      const { sequencePath } = get();
      if (!sequencePath) throw new Error("no sequence");
      const shotPath = await cmd.shot_create(sequencePath, name);
      const { shots } = await cmd.sequence_open(sequencePath);
      set({ shotsInSequence: shots });
      const tl = useTimelineStore.getState();
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
        const tl = useTimelineStore.getState();
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
      const { activeFilter, filterMode } = useTagsStore.getState();
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
