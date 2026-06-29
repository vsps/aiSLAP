import { create } from "zustand";
import type {
  ChainLink,
  Job,
  ModelNode,
  Parameter,
  RefImage,
  RoleAssignment,
} from "../lib/types";
import { classifyMedia } from "../lib/media";
import { isJobTerminal } from "../lib/jobs";

type State = {
  // Source of truth: prompt-chain links. Always >= 1 entry. expandedIdx
  // points at the link the UI panels read/write. null = all-collapsed
  // "submit-ready" view; active-link selectors then fall back to links[0].
  links: ChainLink[];
  expandedIdx: number | null;

  iterations: number;

  /** All in-flight, queued, and recently-finished submissions. Finished
   * entries are pruned on a short tail so the UI can flash success briefly. */
  jobs: Job[];

  errorPopup: string | null;
};

type Actions = {
  selectModel: (model: ModelNode | null) => void;
  setSequencePrompt: (value: string) => void;
  setShotPrompts: (values: string[]) => void;
  setShotPromptAt: (idx: number, value: string) => void;
  addShotPromptAfter: (idx: number) => void;
  removeShotPromptAt: (idx: number) => void;
  setSetting: (key: string, value: unknown) => void;
  setIterations: (n: number) => void;

  setSequencePromptIncluded: (v: boolean) => void;
  setSequenceScriptIncluded: (v: boolean) => void;
  setShotScriptIncluded: (v: boolean) => void;
  setShotPromptIncludedAt: (idx: number, v: boolean) => void;

  addRefs: (paths: string[]) => void;
  removeRef: (path: string) => void;
  removeAllRefs: () => void;
  assignRole: (path: string, role: RoleAssignment | null) => void;
  swapRoleAssignments: (pathA: string, pathB: string) => void;
  reorderRefs: (fromIdx: number, toIdx: number) => void;
  setRefImages: (refs: RefImage[]) => void;
  /**
   * Rewrite refImage paths across every chain link after a sequence/shot
   * rename. Paths starting with `oldPrefix` (or equal to it) are rewritten
   * to use `newPrefix`. No-op when prefixes are equal.
   */
  rewriteRefImagePaths: (oldPrefix: string, newPrefix: string) => void;

  resetGenerationForm: () => void;

  // Chain operations
  addLink: () => void;
  removeLink: (id: string) => void;
  setLinkActive: (id: string, active: boolean) => void;
  setLinkConsumesPrev: (id: string, consumesPrev: boolean) => void;
  moveLink: (fromIdx: number, toIdx: number) => void;
  expandLink: (idx: number | null) => void;
  /** Replace the entire chain (used on bootstrap restore). */
  setChain: (links: ChainLink[], expandedIdx: number | null) => void;

  addJob: (job: Job) => void;
  updateJob: (id: string, patch: Partial<Job>) => void;
  removeJob: (id: string) => void;
  clearFinishedJobs: () => void;
  setError: (msg: string | null) => void;
};

function defaultsFor(params: Parameter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) out[p.api_field] = p.default;
  return out;
}

// Session-only memory of each link's per-model settings, so switching a link's
// model and back restores what was there (disk persistence already covers the
// active settings across reloads). Keyed by link id + model id to avoid bleed
// between chain links.
const settingsCache = new Map<string, Record<string, unknown>>();
const cacheKey = (linkId: string, modelId: string) => `${linkId}::${modelId}`;

// Ensure every element group has exactly one frontal. If none is set, the first
// ref in the group (by panel order) is auto-promoted.
function ensureFrontals(refs: RefImage[]): RefImage[] {
  const hasFrontal = new Map<string, boolean>();
  for (const r of refs) {
    if (r.roleAssignment?.kind === "element" && r.roleAssignment.frontal) {
      hasFrontal.set(r.roleAssignment.groupName, true);
    }
  }
  const promoted = new Set<string>();
  return refs.map((r) => {
    if (r.roleAssignment?.kind === "element") {
      const g = r.roleAssignment.groupName;
      if (!hasFrontal.get(g) && !promoted.has(g)) {
        promoted.add(g);
        return { ...r, roleAssignment: { ...r.roleAssignment, frontal: true } };
      }
    }
    return r;
  });
}

export function makeChainLink(overrides: Partial<ChainLink> = {}): ChainLink {
  return {
    id: crypto.randomUUID(),
    active: true,
    model: null,
    settings: {},
    sequencePrompt: "",
    shotPrompts: [""],
    refImages: [],
    consumesPrev: false,
    ...overrides,
  };
}

// Apply a patch to the active link and return the partial state update.
// No-op when no link is expanded — panels can't render in that state, so
// this guards stray late writes.
function patchActive(
  s: State,
  patch: Partial<ChainLink>,
): Partial<State> {
  if (s.expandedIdx == null) return {};
  const links = s.links.slice();
  links[s.expandedIdx] = { ...links[s.expandedIdx], ...patch };
  return { links };
}

/** Returns the active link or null when nothing is expanded. */
function activeOf(s: State): ChainLink | null {
  if (s.expandedIdx == null) return null;
  return s.links[s.expandedIdx] ?? null;
}

/** Copy of a link's per-shot inclusion flags, defaulting to all-true and
 *  padded to match the current shotPrompts length (older links may lack the
 *  field or have a stale, shorter array). */
function shotPromptIncludes(link: ChainLink): boolean[] {
  const inc = (link.shotPromptsIncluded ?? link.shotPrompts.map(() => true)).slice();
  while (inc.length < link.shotPrompts.length) inc.push(true);
  return inc;
}

export const useGenerationStore = create<State & Actions>((set) => {
  const initialLink = makeChainLink();
  return {
    links: [initialLink],
    expandedIdx: 0,
    iterations: 1,

    jobs: [],
    errorPopup: null,

    selectModel(model) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {};
        // Snapshot the outgoing model's settings so we can restore them later.
        if (link.model) {
          settingsCache.set(cacheKey(link.id, link.model.id), link.settings);
        }
        // Precedence: defaults < cached(this model) < shared keys from the
        // outgoing (visible) settings — so point/box prompts follow the user
        // across SAM nodes, while unrelated models restore their own settings.
        let next: Record<string, unknown> = model ? defaultsFor(model.parameters) : {};
        if (model) {
          const cached = settingsCache.get(cacheKey(link.id, model.id));
          if (cached) next = { ...next, ...cached };
          if (link.model) {
            const fields = new Set(model.parameters.map((p) => p.api_field));
            for (const [k, v] of Object.entries(link.settings)) {
              if (fields.has(k)) next[k] = v;
            }
          }
        }
        return patchActive(s, { model, settings: next });
      });
    },
    setSequencePrompt(value) {
      set((s) => patchActive(s, { sequencePrompt: value }));
    },
    setShotPrompts(values) {
      const next = values.length > 0 ? values : [""];
      set((s) => patchActive(s, { shotPrompts: next, shotPromptsIncluded: next.map(() => true) }));
    },
    setShotPromptAt(idx, value) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        if (idx < 0 || idx >= link.shotPrompts.length)
          return {} as Partial<State>;
        const next = link.shotPrompts.slice();
        next[idx] = value;
        return patchActive(s, { shotPrompts: next });
      });
    },
    addShotPromptAfter(idx) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        const insertAt = Math.max(0, Math.min(link.shotPrompts.length, idx + 1));
        const next = link.shotPrompts.slice();
        next.splice(insertAt, 0, "");
        const inc = shotPromptIncludes(link);
        inc.splice(insertAt, 0, true);
        return patchActive(s, { shotPrompts: next, shotPromptsIncluded: inc });
      });
    },
    removeShotPromptAt(idx) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        if (link.shotPrompts.length <= 1 || idx < 0 || idx >= link.shotPrompts.length) {
          return {} as Partial<State>;
        }
        const next = link.shotPrompts.slice();
        next.splice(idx, 1);
        const inc = shotPromptIncludes(link);
        inc.splice(idx, 1);
        return patchActive(s, { shotPrompts: next, shotPromptsIncluded: inc });
      });
    },
    setSetting(key, value) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        return patchActive(s, { settings: { ...link.settings, [key]: value } });
      });
    },
    setIterations(n) {
      set({ iterations: Math.max(1, Math.floor(n || 1)) });
    },

    setSequencePromptIncluded(v) {
      set((s) => patchActive(s, { sequencePromptIncluded: v }));
    },
    setSequenceScriptIncluded(v) {
      set((s) => patchActive(s, { sequenceScriptIncluded: v }));
    },
    setShotScriptIncluded(v) {
      set((s) => patchActive(s, { shotScriptIncluded: v }));
    },
    setShotPromptIncludedAt(idx, v) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        if (idx < 0 || idx >= link.shotPrompts.length)
          return {} as Partial<State>;
        const next = shotPromptIncludes(link);
        next[idx] = v;
        return patchActive(s, { shotPromptsIncluded: next });
      });
    },

    addRefs(paths) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        const existing = new Set(link.refImages.map((r) => r.path));
        const newPaths = paths.filter((p) => !existing.has(p));
        if (newPaths.length === 0) return {} as Partial<State>;
        const roles = link.model?.ref_roles ?? [];
        const modelHasStart = roles.some((r) => r.role === "start");
        const modelHasEnd = roles.some((r) => r.role === "end");
        let startTaken = link.refImages.some(
          (r) => r.roleAssignment?.kind === "start",
        );
        let endTaken = link.refImages.some(
          (r) => r.roleAssignment?.kind === "end",
        );
        const added = newPaths.map<RefImage>((p) => {
          const isImg = classifyMedia(p) === "image";
          if (isImg && modelHasStart && !startTaken) {
            startTaken = true;
            return { path: p, roleAssignment: { kind: "start" } };
          }
          if (isImg && modelHasEnd && !endTaken) {
            endTaken = true;
            return { path: p, roleAssignment: { kind: "end" } };
          }
          return { path: p, roleAssignment: null };
        });
        return patchActive(s, {
          refImages: [...link.refImages, ...added],
        });
      });
    },
    removeRef(path) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        return patchActive(s, {
          refImages: ensureFrontals(link.refImages.filter((r) => r.path !== path)),
        });
      });
    },
    removeAllRefs() {
      set((s) => patchActive(s, { refImages: [] }));
    },
    reorderRefs(fromIdx, toIdx) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        if (
          fromIdx === toIdx ||
          fromIdx < 0 ||
          toIdx < 0 ||
          fromIdx >= link.refImages.length ||
          toIdx >= link.refImages.length
        ) {
          return {} as Partial<State>;
        }
        const next = link.refImages.slice();
        const [item] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, item);
        return patchActive(s, { refImages: ensureFrontals(next) });
      });
    },
    assignRole(path, role) {
      set((s) => {
        const link = activeOf(s);
        if (!link) return {} as Partial<State>;
        const exclusive =
          role && (role.kind === "start" || role.kind === "end")
            ? role.kind
            : null;
        const next = link.refImages.map((r) => {
          if (r.path === path) return { ...r, roleAssignment: role };
          if (exclusive && r.roleAssignment?.kind === exclusive) {
            return { ...r, roleAssignment: null };
          }
          if (
            role &&
            role.kind === "element" &&
            role.frontal &&
            r.roleAssignment?.kind === "element" &&
            r.roleAssignment.groupName === role.groupName &&
            r.path !== path
          ) {
            return { ...r, roleAssignment: { ...r.roleAssignment, frontal: false } };
          }
          return r;
        });
        return patchActive(s, { refImages: ensureFrontals(next) });
      });
    },
    swapRoleAssignments(pathA, pathB) {
      set((s) => {
        const link = activeOf(s);
        if (!link || pathA === pathB) return {} as Partial<State>;
        const a = link.refImages.find((r) => r.path === pathA);
        const b = link.refImages.find((r) => r.path === pathB);
        if (!a || !b) return {} as Partial<State>;
        const next = link.refImages.map((r) =>
          r.path === pathA
            ? { ...r, roleAssignment: b.roleAssignment }
            : r.path === pathB
              ? { ...r, roleAssignment: a.roleAssignment }
              : r,
        );
        return patchActive(s, { refImages: ensureFrontals(next) });
      });
    },
    setRefImages(refs) {
      set((s) => patchActive(s, { refImages: ensureFrontals(refs) }));
    },
    rewriteRefImagePaths(oldPrefix, newPrefix) {
      if (!oldPrefix || oldPrefix === newPrefix) return;
      const matches = (p: string) =>
        p === oldPrefix || p.startsWith(oldPrefix + "/");
      const rewrite = (p: string) =>
        p === oldPrefix ? newPrefix : newPrefix + p.slice(oldPrefix.length);
      set((s) => {
        let anyChange = false;
        const links = s.links.map((link) => {
          let linkChanged = false;
          const next = link.refImages.map((r) => {
            if (matches(r.path)) {
              linkChanged = true;
              return { ...r, path: rewrite(r.path) };
            }
            return r;
          });
          if (!linkChanged) return link;
          anyChange = true;
          return { ...link, refImages: next };
        });
        if (!anyChange) return {} as Partial<State>;
        return { links };
      });
    },

    resetGenerationForm() {
      set((s) => {
        if (s.expandedIdx == null) return { iterations: 1 };
        const link = s.links[s.expandedIdx];
        const defaults = link.model ? defaultsFor(link.model.parameters) : {};
        // Keep the cache in step so a later switch-back doesn't undo the reset.
        if (link.model) settingsCache.set(cacheKey(link.id, link.model.id), defaults);
        return {
          ...patchActive(s, {
            sequencePrompt: "",
            shotPrompts: [""],
            settings: defaults,
            refImages: [],
          }),
          iterations: 1,
        };
      });
    },

    addLink() {
      set((s) => {
        // Append a new active link. Default consumesPrev=true so its ref
        // panel shows the upstream-output placeholder. Auto-expand the new
        // link so the user can start editing immediately.
        const link = makeChainLink({ consumesPrev: true });
        const links = [...s.links, link];
        const expandedIdx = links.length - 1;
        return { links, expandedIdx };
      });
    },
    removeLink(id) {
      set((s) => {
        if (s.links.length <= 1) return {} as Partial<State>;
        const idx = s.links.findIndex((l) => l.id === id);
        if (idx < 0) return {} as Partial<State>;
        const links = s.links.slice();
        links.splice(idx, 1);
        let expandedIdx = s.expandedIdx;
        if (expandedIdx != null) {
          if (expandedIdx === idx) {
            // Deleted the expanded link — drop back to all-collapsed.
            expandedIdx = null;
          } else if (expandedIdx > idx) {
            expandedIdx -= 1;
          }
        }
        // First link's consumesPrev should be false (no upstream possible).
        if (links[0].consumesPrev) {
          links[0] = { ...links[0], consumesPrev: false };
        }
        return { links, expandedIdx };
      });
    },
    setLinkActive(id, active) {
      set((s) => {
        const idx = s.links.findIndex((l) => l.id === id);
        if (idx < 0) return {} as Partial<State>;
        const links = s.links.slice();
        links[idx] = { ...links[idx], active };
        return { links };
      });
    },
    setLinkConsumesPrev(id, consumesPrev) {
      set((s) => {
        const idx = s.links.findIndex((l) => l.id === id);
        if (idx < 0 || idx === 0) return {} as Partial<State>;
        const links = s.links.slice();
        links[idx] = { ...links[idx], consumesPrev };
        return { links };
      });
    },
    moveLink(fromIdx, toIdx) {
      set((s) => {
        if (
          fromIdx === toIdx ||
          fromIdx < 0 ||
          toIdx < 0 ||
          fromIdx >= s.links.length ||
          toIdx >= s.links.length
        ) {
          return {} as Partial<State>;
        }
        const links = s.links.slice();
        const [item] = links.splice(fromIdx, 1);
        links.splice(toIdx, 0, item);
        // First link must never consume prev.
        if (links[0].consumesPrev) {
          links[0] = { ...links[0], consumesPrev: false };
        }
        let expandedIdx = s.expandedIdx;
        if (expandedIdx != null) {
          if (expandedIdx === fromIdx) expandedIdx = toIdx;
          else if (fromIdx < expandedIdx && toIdx >= expandedIdx) expandedIdx -= 1;
          else if (fromIdx > expandedIdx && toIdx <= expandedIdx) expandedIdx += 1;
        }
        return { links, expandedIdx };
      });
    },
    expandLink(idx) {
      set((s) => {
        if (idx != null && (idx < 0 || idx >= s.links.length)) {
          return {} as Partial<State>;
        }
        return { expandedIdx: idx };
      });
    },
    setChain(links, expandedIdx) {
      // Sanitize: ensure non-empty array, valid expandedIdx, and that the
      // head link never consumes prev.
      const safeLinks = links.length > 0 ? links.slice() : [makeChainLink()];
      if (safeLinks[0].consumesPrev) {
        safeLinks[0] = { ...safeLinks[0], consumesPrev: false };
      }
      let safeIdx: number | null = expandedIdx;
      if (safeIdx != null && (safeIdx < 0 || safeIdx >= safeLinks.length)) {
        safeIdx = safeLinks.length === 1 ? 0 : null;
      }
      set({ links: safeLinks, expandedIdx: safeIdx });
    },

    addJob(job) {
      set((s) => {
        const next = [...s.jobs, job];
        const MAX = 50;
        if (next.length <= MAX) return { jobs: next };
        // Drop oldest *completed* jobs first so active work is never evicted.
        const trimmed = next.slice();
        for (let i = 0; trimmed.length > MAX && i < trimmed.length; ) {
          if (isJobTerminal(trimmed[i].status)) trimmed.splice(i, 1);
          else i++;
        }
        // If still over (>50 active jobs at once — pathological), keep newest.
        return { jobs: trimmed.length > MAX ? trimmed.slice(-MAX) : trimmed };
      });
    },
    updateJob(id, patch) {
      set((s) => ({
        jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      }));
    },
    removeJob(id) {
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    },
    clearFinishedJobs() {
      set((s) => ({
        jobs: s.jobs.filter((j) => !isJobTerminal(j.status)),
      }));
    },
    setError(msg) {
      set({ errorPopup: msg });
    },
  };
});

// ---- Active-link selectors -------------------------------------------------
// The "active" link is what the editor panels read/write: links[expandedIdx],
// falling back to links[0] in the all-collapsed view. Use these instead of
// duplicating the fallback logic at call sites.

export type GenerationState = State & Actions;

// Stable reference: selectors must not fabricate a new array per call or
// useSyncExternalStore's snapshot check loops forever.
const EMPTY_PROMPTS: string[] = [""];

export const selectActiveLink = (s: GenerationState): ChainLink =>
  s.links[s.expandedIdx ?? 0] ?? s.links[0];
export const selectCurrentModel = (s: GenerationState): ModelNode | null =>
  selectActiveLink(s).model;
export const selectSequencePrompt = (s: GenerationState): string =>
  selectActiveLink(s).sequencePrompt;
export const selectShotPrompts = (s: GenerationState): string[] => {
  const sp = selectActiveLink(s).shotPrompts;
  return sp.length > 0 ? sp : EMPTY_PROMPTS;
};
export const selectSettings = (s: GenerationState): Record<string, unknown> =>
  selectActiveLink(s).settings;
export const selectRefImages = (s: GenerationState): RefImage[] =>
  selectActiveLink(s).refImages;
