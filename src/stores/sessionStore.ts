import { create } from "zustand";
import type {
  GalleryColumn,
  PromptHistoryChannel,
  RefImage,
  SequenceSidecar,
  SequenceStacks,
  ShotSidecar,
  SeqStarredGroup,
} from "../lib/types";
import { cmd } from "../lib/tauri";
import { useTimelineStore } from "./timelineStore";
import { useScriptStore } from "./scriptStore";
import { useGenerationStore } from "./generationStore";
import { basename } from "../lib/paths";
import { inFlightJobs } from "../lib/jobs";
import { swallow } from "../lib/errors";
import { rewriteScriptHeading } from "../lib/script";

type PromptScope = "sequence" | "shot";
type ViewMode = "columns" | "starred" | "stacked";

type State = {
  projectPath: string | null;
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
  imageDrag: { fromPath: string } | null;
  targetVersion: string | null;

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
  starredGroups: SeqStarredGroup[];
  starredLoading: boolean;
  sequenceStacks: SequenceStacks | null;
  sequenceStacksLoading: boolean;

  galleryHeight: number;
  thumbColWidth: number;
  logHeight: number;
  timelineHeight: number;
};

type Actions = {
  setProject: (projectPath: string) => Promise<void>;
  setSequence: (sequencePath: string) => Promise<void>;
  setShot: (shotPath: string) => Promise<void>;
  rescanShot: () => Promise<void>;
  setTargetVersion: (version: string | null) => void;
  createSequence: (name: string) => Promise<void>;
  createShot: (name: string) => Promise<void>;
  renameSequence: (newName: string) => Promise<void>;
  renameShot: (newName: string) => Promise<void>;
  createNextVersion: () => Promise<string>;

  setSelectedImage: (path: string | null) => void;
  setZoomImage: (path: string | null) => void;
  setInfoImage: (path: string | null) => void;
  setZoomInitialMode: (mode: "draw" | "crop" | null) => void;
  setRenameImage: (path: string | null) => void;
  setImageDrag: (drag: State["imageDrag"]) => void;
  setTrace: (state: State["traceActive"]) => void;

  setViewMode: (mode: ViewMode) => void;
  rescanStarred: () => Promise<void>;
  rescanSequenceStacks: () => Promise<void>;

  navigatePromptHistory: (scope: PromptScope, delta: number) => void;
  snapToLive: (scope: PromptScope) => void;

  hydrateSequenceSidecar: (sidecar: SequenceSidecar | null) => void;
  hydrateShotSidecar: (sidecar: ShotSidecar | null) => void;
  /** Set or clear a per-version comment on the current shot; persists to shot.json. */
  setVersionComment: (version: string, comment: string) => Promise<void>;

  setGalleryHeight: (n: number) => void;
  setThumbColWidth: (n: number) => void;
  setLogHeight: (n: number) => void;
  setTimelineHeight: (n: number) => void;
};

const GALLERY_H_MIN = 120;
const GALLERY_H_MAX = 1200;
const THUMB_W_MIN = 154;
const THUMB_W_MAX = 500;
const LOG_H_MIN = 24;
const LOG_H_MAX = 600;
const TIMELINE_H_MIN = 45;
const TIMELINE_H_MAX = 400;
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(n)));

const emptyChannel = (): PromptHistoryChannel => ({ entries: [], cursor: 0 });

function latestVersion(columns: GalleryColumn[]): string | null {
  const vs = columns.filter((c) => !c.isSrc).map((c) => c.version);
  return vs.length ? vs[vs.length - 1] : null;
}

export const useSessionStore = create<State & Actions>((set, get) => ({
  projectPath: null,
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
  imageDrag: null,
  targetVersion: null,

  sequenceHistory: emptyChannel(),
  shotHistory: emptyChannel(),
  versionComments: {},

  traceActive: null,

  viewMode: "columns",
  starredGroups: [],
  starredLoading: false,
  sequenceStacks: null,
  sequenceStacksLoading: false,

  galleryHeight: 400,
  thumbColWidth: THUMB_W_MIN,
  logHeight: 78,
  timelineHeight: TIMELINE_H_MIN,

  async setProject(projectPath) {
    // Rust's list_dirs returns forward-slash paths. Normalize the incoming path
    // the same way so the PROJECT/SEQUENCE/SHOT dropdowns string-match their options.
    const normalized = projectPath.replaceAll("\\", "/").replace(/\/+$/, "");
    const sequences = await cmd.project_open(normalized);
    set({
      projectPath: normalized,
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
      starredGroups: [],
    });
    if (get().viewMode === "starred") {
      void get().rescanStarred();
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
      versionComments: sidecar.versionComments ?? {},
      shotHistory: {
        entries: sidecar.promptHistory,
        cursor: sidecar.promptHistory.length,
      },
    });
  },

  async rescanShot() {
    const { shotPath } = get();
    if (!shotPath) return;
    const columns = await cmd.shot_rescan(shotPath);
    set((s) => ({
      columns,
      targetVersion:
        s.targetVersion && columns.some((c) => c.version === s.targetVersion)
          ? s.targetVersion
          : latestVersion(columns),
    }));
    if (get().viewMode === "starred") {
      void get().rescanStarred();
    } else if (get().viewMode === "stacked") {
      void get().rescanSequenceStacks();
    }
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

  async renameSequence(newName) {
    const { projectPath, sequencePath, shotPath } = get();
    if (!projectPath) throw new Error("no project");
    if (!sequencePath) throw new Error("no sequence to rename");
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("name cannot be empty");

    const oldSeqPath = sequencePath;
    const oldShotPath = shotPath;
    const oldSeqBase = basename(oldSeqPath);

    // Job-safety guard. Refuse if any non-terminal job targets this sequence.
    const inFlight = inFlightJobs(useGenerationStore.getState().jobs, oldSeqPath);
    if (inFlight.length > 0) {
      throw new Error(
        `Cannot rename — ${inFlight.length} job${
          inFlight.length > 1 ? "s are" : " is"
        } running in this sequence.`,
      );
    }

    const newSeqPath = await cmd.sequence_rename(oldSeqPath, trimmed);
    if (newSeqPath === oldSeqPath) return;

    // Keep in-memory mirrors coherent before re-rendering.
    useTimelineStore.getState().renameShotPathPrefix(oldSeqPath, newSeqPath);
    useGenerationStore.getState().rewriteRefImagePaths(oldSeqPath, newSeqPath);

    const sequences = await cmd.project_open(projectPath);
    set({ sequencesInProject: sequences });
    await get().setSequence(newSeqPath);

    // setSequence auto-opens the last shot. Navigate back to the user's shot
    // if it survived the rename (same basename, new parent).
    if (oldShotPath) {
      const targetShotPath = `${newSeqPath}/${basename(oldShotPath)}`;
      if (
        get().shotsInSequence.includes(targetShotPath) &&
        get().shotPath !== targetShotPath
      ) {
        await get().setShot(targetShotPath);
      }
    }

    // script.md heading rewrite (silent no-op when no matching # heading).
    const scriptState = useScriptStore.getState();
    const nextRaw = rewriteScriptHeading(
      scriptState.raw,
      1,
      oldSeqBase,
      trimmed,
    );
    if (nextRaw !== scriptState.raw) {
      await scriptState.save(projectPath, nextRaw).catch(swallow("script heading rewrite"));
    }
  },

  async renameShot(newName) {
    const { projectPath, sequencePath, shotPath } = get();
    if (!projectPath) throw new Error("no project");
    if (!sequencePath) throw new Error("no sequence");
    if (!shotPath) throw new Error("no shot to rename");
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("name cannot be empty");

    const oldShotPath = shotPath;
    const oldShotBase = basename(oldShotPath);

    const inFlight = inFlightJobs(useGenerationStore.getState().jobs, oldShotPath);
    if (inFlight.length > 0) {
      throw new Error(
        `Cannot rename — ${inFlight.length} job${
          inFlight.length > 1 ? "s are" : " is"
        } running in this shot.`,
      );
    }

    const newShotPath = await cmd.shot_rename(oldShotPath, trimmed);
    if (newShotPath === oldShotPath) return;

    useTimelineStore.getState().renameShotPathPrefix(oldShotPath, newShotPath);
    useGenerationStore.getState().rewriteRefImagePaths(oldShotPath, newShotPath);

    const { shots } = await cmd.sequence_open(sequencePath);
    set({ shotsInSequence: shots });
    await get().setShot(newShotPath);

    const scriptState = useScriptStore.getState();
    const nextRaw = rewriteScriptHeading(
      scriptState.raw,
      2,
      oldShotBase,
      trimmed,
    );
    if (nextRaw !== scriptState.raw) {
      await scriptState.save(projectPath, nextRaw).catch(swallow("script heading rewrite"));
    }
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
      if (tl.playing || tl.playheadSec > 0) {
        tl.pause();
        tl.restart();
      }
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

  setInfoImage(path) {
    set({ infoImagePath: path });
  },

  setImageDrag(drag) {
    set({ imageDrag: drag });
  },

  setTrace(state) {
    set({ traceActive: state });
  },

  setViewMode(mode) {
    set({ viewMode: mode });
    if (mode === "starred") {
      void get().rescanStarred();
    } else if (mode === "stacked") {
      void get().rescanSequenceStacks();
    }
  },

  async rescanStarred() {
    const { projectPath } = get();
    if (!projectPath) {
      set({ starredGroups: [], starredLoading: false });
      return;
    }
    set({ starredLoading: true });
    try {
      const groups = await cmd.project_starred_scan(projectPath);
      set({ starredGroups: groups, starredLoading: false });
    } catch (e) {
      set({ starredLoading: false });
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
      const next = Math.max(0, Math.min(ch.entries.length, ch.cursor + delta));
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

  setGalleryHeight(n) {
    set({ galleryHeight: clamp(n, GALLERY_H_MIN, GALLERY_H_MAX) });
  },
  setThumbColWidth(n) {
    set({ thumbColWidth: clamp(n, THUMB_W_MIN, THUMB_W_MAX) });
  },
  setLogHeight(n) {
    set({ logHeight: clamp(n, LOG_H_MIN, LOG_H_MAX) });
  },
  setTimelineHeight(n) {
    set({ timelineHeight: clamp(n, TIMELINE_H_MIN, TIMELINE_H_MAX) });
  },
}));
