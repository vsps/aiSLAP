import { create } from "zustand";
import type {
  SequenceTimeline,
  ShotLatestMedia,
  TimelineClip,
} from "../lib/types";
import { cmd } from "../lib/tauri";

const DEFAULT_CLIP_DURATION_SEC = 5;
const SAVE_DEBOUNCE_MS = 500;

const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv"] as const;

export function isVideoPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return (VIDEO_EXTS as readonly string[]).includes(ext);
}

type State = {
  seqPath: string | null;
  /** User-curated clips. The auto-pad blank is NOT included here. */
  clips: TimelineClip[];
  totalDurationSec: number;
  shotsLatestMedia: Map<string, ShotLatestMedia>;
  /** path -> natural duration (sec). Filled lazily by HTMLVideoElement probes. */
  videoDurations: Map<string, number>;
  playing: boolean;
  playheadSec: number;
};

type Actions = {
  loadForSequence: (seqPath: string) => Promise<void>;
  reset: () => void;
  saveDebounced: () => void;

  setTotalDuration: (sec: number) => void;
  setBoundary: (innerIdx: number, deltaSec: number) => void;
  moveClip: (fromIdx: number, toIdx: number) => void;
  toggleClipEnabled: (id: string) => void;
  setClipMedia: (id: string, mediaPath: string | null) => void;
  setClipSourceOffset: (id: string, sec: number) => void;
  /**
   * Append a clip for a newly created shot. No-op if the timeline isn't
   * loaded or this shot is already referenced. Mirrors the defaults used
   * by the reconciliation pass in `loadForSequence`.
   */
  appendShotClip: (shotPath: string) => void;
  setShotClipMedia: (
    shotPath: string,
    mediaPath: string | null,
  ) => Promise<void>;
  /**
   * Reset structural edits: restore clip order to disk order, set each clip's
   * duration to total/N, clear sourceOffsetSec and re-enable all clips.
   * Preserves per-clip `mediaPath` overrides (and the shot's `clipMediaPath`,
   * which is per-shot and not touched here).
   */
  resetClips: () => void;

  play: () => void;
  pause: () => void;
  restart: () => void;
  setPlayheadSec: (sec: number) => void;
  /**
   * Record a probed video duration; if a clip still has the default duration
   * (likely never touched) and points to this video, resize it to the probed
   * length.
   */
  recordVideoDuration: (path: string, durSec: number) => void;
};

const MIN_CLIP_DURATION_SEC = 0.5;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useTimelineStore = create<State & Actions>((set, get) => ({
  seqPath: null,
  clips: [],
  totalDurationSec: 0,
  shotsLatestMedia: new Map(),
  videoDurations: new Map(),
  playing: false,
  playheadSec: 0,

  async loadForSequence(seqPath) {
    const { timeline, shotsLatestMedia } = await cmd.timeline_init(seqPath);
    const slmMap = new Map<string, ShotLatestMedia>(
      shotsLatestMedia.map((s) => [s.shotPath, s]),
    );

    const shotPathsInSeq = new Set(shotsLatestMedia.map((s) => s.shotPath));
    const persisted = timeline.clips ?? [];

    // Drop clips referencing shots that no longer exist (blanks pass through).
    let clips: TimelineClip[] = persisted.filter(
      (c) => c.shotPath == null || shotPathsInSeq.has(c.shotPath),
    );

    // Append a default clip for any shot not yet referenced.
    const referenced = new Set(
      clips
        .filter((c) => c.shotPath != null)
        .map((c) => c.shotPath as string),
    );
    for (const sm of shotsLatestMedia) {
      if (!referenced.has(sm.shotPath)) {
        clips.push({
          id: crypto.randomUUID(),
          shotPath: sm.shotPath,
          enabled: true,
          durationSec: DEFAULT_CLIP_DURATION_SEC,
          mediaPath: null,
        });
      }
    }

    // Total duration: respect persisted value if it's >= sum; otherwise extend.
    const sumDur = clips.reduce((s, c) => s + c.durationSec, 0);
    let total = timeline.totalDurationSec ?? 0;
    if (sumDur > total) total = sumDur;
    if (total === 0 && clips.length > 0) total = sumDur;

    set({
      seqPath,
      clips,
      totalDurationSec: total,
      shotsLatestMedia: slmMap,
    });

    // Persist if reconciliation produced a different user-curated set
    // or a new total than what was on disk.
    const changed =
      JSON.stringify(persisted) !== JSON.stringify(clips) ||
      (timeline.totalDurationSec ?? 0) !== total;
    if (changed) {
      await cmd.sequence_timeline_save(seqPath, {
        totalDurationSec: total,
        clips,
      });
    }
  },

  reset() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      seqPath: null,
      clips: [],
      totalDurationSec: 0,
      shotsLatestMedia: new Map(),
      videoDurations: new Map(),
      playing: false,
      playheadSec: 0,
    });
  },

  saveDebounced() {
    const { seqPath } = get();
    if (!seqPath) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const { seqPath: sp, clips, totalDurationSec } = get();
      if (!sp) return;
      const payload: SequenceTimeline = {
        totalDurationSec,
        clips,
      };
      void cmd.sequence_timeline_save(sp, payload);
    }, SAVE_DEBOUNCE_MS);
  },

  setTotalDuration(sec) {
    const target = Math.max(MIN_CLIP_DURATION_SEC, sec);
    set((s) => {
      const sum = s.clips.reduce((a, c) => a + c.durationSec, 0);
      if (sum <= 0) {
        // No content yet — just bump the total.
        return { totalDurationSec: target };
      }
      const factor = target / sum;
      const clips = s.clips.map((c) => ({
        ...c,
        durationSec: Math.max(MIN_CLIP_DURATION_SEC, c.durationSec * factor),
      }));
      return { clips, totalDurationSec: target };
    });
    get().saveDebounced();
  },

  setBoundary(innerIdx, deltaSec) {
    set((s) => {
      if (innerIdx < 0 || innerIdx >= s.clips.length) return s;
      const a = s.clips[innerIdx];
      const newA = a.durationSec + deltaSec;
      if (newA < MIN_CLIP_DURATION_SEC) return s;

      // Boundary between two real user clips → redistribute.
      if (innerIdx < s.clips.length - 1) {
        const b = s.clips[innerIdx + 1];
        const newB = b.durationSec - deltaSec;
        if (newB < MIN_CLIP_DURATION_SEC) return s;
        const clips = s.clips.slice();
        clips[innerIdx] = { ...a, durationSec: newA };
        clips[innerIdx + 1] = { ...b, durationSec: newB };
        return { clips };
      }

      // Boundary between last user clip and the in-memory pad: just resize
      // this clip; the pad shrinks (or, if we exceed the total, the total
      // is bumped so sum >= total stays true).
      const clips = s.clips.slice();
      clips[innerIdx] = { ...a, durationSec: newA };
      const newSum = clips.reduce((acc, c) => acc + c.durationSec, 0);
      const totalDurationSec = Math.max(s.totalDurationSec, newSum);
      return { clips, totalDurationSec };
    });
    get().saveDebounced();
  },

  moveClip(fromIdx, toIdx) {
    set((s) => {
      if (
        fromIdx === toIdx ||
        fromIdx < 0 ||
        fromIdx >= s.clips.length ||
        toIdx < 0 ||
        toIdx >= s.clips.length
      ) {
        return s;
      }
      const clips = s.clips.slice();
      const [moved] = clips.splice(fromIdx, 1);
      clips.splice(toIdx, 0, moved);
      return { clips };
    });
    get().saveDebounced();
  },

  toggleClipEnabled(id) {
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id ? { ...c, enabled: !c.enabled } : c,
      ),
    }));
    get().saveDebounced();
  },

  setClipMedia(id, mediaPath) {
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, mediaPath } : c)),
    }));
    get().saveDebounced();
  },

  setClipSourceOffset(id, sec) {
    const v = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id ? { ...c, sourceOffsetSec: v } : c,
      ),
    }));
    get().saveDebounced();
  },

  appendShotClip(shotPath) {
    const { seqPath } = get();
    if (!seqPath) return;
    set((s) => {
      if (s.clips.some((c) => c.shotPath === shotPath)) return s;
      const clip: TimelineClip = {
        id: crypto.randomUUID(),
        shotPath,
        enabled: true,
        durationSec: DEFAULT_CLIP_DURATION_SEC,
        mediaPath: null,
      };
      const clips = [...s.clips, clip];
      const sum = clips.reduce((a, c) => a + c.durationSec, 0);
      const totalDurationSec = Math.max(s.totalDurationSec, sum);
      const shotsLatestMedia = new Map(s.shotsLatestMedia);
      if (!shotsLatestMedia.has(shotPath)) {
        shotsLatestMedia.set(shotPath, {
          shotPath,
          mediaPath: null,
          isVideo: false,
          clipMediaPath: null,
        });
      }
      return { clips, totalDurationSec, shotsLatestMedia };
    });
    get().saveDebounced();
  },

  resetClips() {
    set((s) => {
      // Disk order = the key-iteration order of `shotsLatestMedia`, which is
      // populated from the Rust scan (alphabetic by shot dir).
      const diskOrder = Array.from(s.shotsLatestMedia.keys());
      const byShot = new Map(
        s.clips
          .filter((c) => c.shotPath != null)
          .map((c) => [c.shotPath as string, c]),
      );
      const ordered: TimelineClip[] = [];
      for (const shotPath of diskOrder) {
        const existing = byShot.get(shotPath);
        if (existing) {
          ordered.push({
            ...existing,
            enabled: true,
            sourceOffsetSec: 0,
            // durationSec set below once N is known
            durationSec: existing.durationSec,
          });
        } else {
          ordered.push({
            id: crypto.randomUUID(),
            shotPath,
            enabled: true,
            durationSec: DEFAULT_CLIP_DURATION_SEC,
            mediaPath: null,
            sourceOffsetSec: 0,
          });
        }
      }
      const n = ordered.length;
      const total =
        s.totalDurationSec > 0
          ? s.totalDurationSec
          : Math.max(DEFAULT_CLIP_DURATION_SEC * n, DEFAULT_CLIP_DURATION_SEC);
      const each =
        n > 0 ? Math.max(MIN_CLIP_DURATION_SEC, total / n) : DEFAULT_CLIP_DURATION_SEC;
      const clips = ordered.map((c) => ({ ...c, durationSec: each }));
      const newTotal = n > 0 ? each * n : total;
      return { clips, totalDurationSec: newTotal };
    });
    get().saveDebounced();
  },

  async setShotClipMedia(shotPath, mediaPath) {
    await cmd.shot_clip_media_set(shotPath, mediaPath);
    set((s) => {
      const next = new Map(s.shotsLatestMedia);
      const existing = next.get(shotPath);
      if (existing) {
        next.set(shotPath, { ...existing, clipMediaPath: mediaPath });
      } else {
        next.set(shotPath, {
          shotPath,
          mediaPath: null,
          isVideo: false,
          clipMediaPath: mediaPath,
        });
      }
      return { shotsLatestMedia: next };
    });
  },

  play() {
    const { totalDurationSec, playheadSec } = get();
    if (totalDurationSec <= 0) return;
    // If we're at (or past) the end, snap back to 0 before resuming.
    const head = playheadSec >= totalDurationSec - 0.001 ? 0 : playheadSec;
    set({ playing: true, playheadSec: head });
  },
  pause() {
    set({ playing: false });
  },
  restart() {
    set({ playheadSec: 0 });
  },
  setPlayheadSec(sec) {
    const { totalDurationSec } = get();
    const clamped = Math.max(0, Math.min(totalDurationSec, sec));
    set({ playheadSec: clamped });
  },

  recordVideoDuration(path, durSec) {
    if (!Number.isFinite(durSec) || durSec <= 0) return;
    set((s) => {
      const videoDurations = new Map(s.videoDurations);
      if (videoDurations.get(path) === durSec) return s;
      videoDurations.set(path, durSec);

      // Auto-resize clips currently using this path AND still at the default
      // duration — keep user-edited durations sticky.
      let touched = false;
      const clips = s.clips.map((c) => {
        const resolved = resolveClipMedia(c, s.shotsLatestMedia);
        if (
          resolved?.path === path &&
          Math.abs(c.durationSec - DEFAULT_CLIP_DURATION_SEC) < 0.001
        ) {
          touched = true;
          return { ...c, durationSec: durSec };
        }
        return c;
      });

      if (!touched) return { videoDurations };
      const sum = clips.reduce((a, c) => a + c.durationSec, 0);
      const totalDurationSec = Math.max(s.totalDurationSec, sum);
      return { videoDurations, clips, totalDurationSec };
    });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const { seqPath, clips, totalDurationSec } = get();
      if (!seqPath) return;
      void cmd.sequence_timeline_save(seqPath, {
        totalDurationSec,
        clips,
      });
    }, SAVE_DEBOUNCE_MS);
  },
}));

export type ResolvedClipMedia = {
  path: string;
  isVideo: boolean;
};

/**
 * Resolve the media path a clip should display:
 *   1. clip.mediaPath (explicit override)
 *   2. shot.clipMediaPath (per-shot exclusive pick)
 *   3. shot's latest version's last image
 * Returns null for blank clips and shots with no resolvable media.
 */
export function resolveClipMedia(
  clip: TimelineClip,
  shotsLatestMedia: Map<string, ShotLatestMedia>,
): ResolvedClipMedia | null {
  if (clip.shotPath == null) return null;
  if (clip.mediaPath) {
    return { path: clip.mediaPath, isVideo: isVideoPath(clip.mediaPath) };
  }
  const sm = shotsLatestMedia.get(clip.shotPath);
  if (!sm) return null;
  if (sm.clipMediaPath) {
    return {
      path: sm.clipMediaPath,
      isVideo: isVideoPath(sm.clipMediaPath),
    };
  }
  if (sm.mediaPath) {
    return { path: sm.mediaPath, isVideo: sm.isVideo };
  }
  return null;
}

/**
 * Returns the ordered list of clips to render in the timeline strip — the
 * user-curated `clips` plus an in-memory blank pad at the end if the user
 * clips underflow `totalDurationSec`. The pad is NOT persisted.
 */
export function getDisplayClips(
  clips: TimelineClip[],
  totalDurationSec: number,
): TimelineClip[] {
  const sum = clips.reduce((s, c) => s + c.durationSec, 0);
  const padDur = Math.max(0, totalDurationSec - sum);
  if (padDur < 0.001) return clips;
  return [
    ...clips,
    {
      id: "__pad__",
      shotPath: null,
      enabled: true,
      durationSec: padDur,
      mediaPath: null,
    },
  ];
}

export type ClipAtPlayhead = {
  clip: TimelineClip;
  startSec: number;
  endSec: number;
  isPad: boolean;
};

export function clipAtPlayhead(
  clips: TimelineClip[],
  totalDurationSec: number,
  playheadSec: number,
): ClipAtPlayhead | null {
  const display = getDisplayClips(clips, totalDurationSec);
  let acc = 0;
  for (let i = 0; i < display.length; i++) {
    const c = display[i];
    const start = acc;
    const end = acc + c.durationSec;
    // Use end-inclusive on the last clip so playhead-at-total still resolves.
    const inside =
      i === display.length - 1
        ? playheadSec >= start && playheadSec <= end
        : playheadSec >= start && playheadSec < end;
    if (inside) {
      return {
        clip: c,
        startSec: start,
        endSec: end,
        isPad: i >= clips.length,
      };
    }
    acc = end;
  }
  return null;
}

export type NextVideoClip = {
  clip: TimelineClip;
  startSec: number;
  resolved: ResolvedClipMedia;
  effOffset: number;
};

/**
 * Find the first enabled video clip strictly after `afterClipId` in display
 * order. Returns its start time on the timeline, resolved media, and the
 * source offset clamped to a valid range against `videoDurations`.
 *
 * Used by the playback preview to preload + pre-seek the upcoming video
 * clip while the current one plays, avoiding seek-hitch at the boundary.
 */
export function nextVideoClipAfter(
  clips: TimelineClip[],
  totalDurationSec: number,
  afterClipId: string | null,
  shotsLatestMedia: Map<string, ShotLatestMedia>,
  videoDurations: Map<string, number>,
): NextVideoClip | null {
  const display = getDisplayClips(clips, totalDurationSec);
  let startSec = 0;
  let passedCurrent = afterClipId == null;
  for (let i = 0; i < display.length; i++) {
    const c = display[i];
    if (!passedCurrent) {
      if (c.id === afterClipId) passedCurrent = true;
      startSec += c.durationSec;
      continue;
    }
    const isPad = i >= clips.length;
    if (!isPad && c.enabled) {
      const resolved = resolveClipMedia(c, shotsLatestMedia);
      if (resolved && resolved.isVideo) {
        const raw = c.sourceOffsetSec ?? 0;
        const srcDur = videoDurations.get(resolved.path);
        const effOffset =
          srcDur != null
            ? Math.min(raw, Math.max(0, srcDur - c.durationSec))
            : raw;
        return { clip: c, startSec, resolved, effOffset };
      }
    }
    startSec += c.durationSec;
  }
  return null;
}
