// Prompt assembly for generation: combines script segments + sequence/shot
// prompts into the final text sent to the API, honoring inclusion flags.

import { basename } from "../paths";
import { seqShotNames } from "../prism";
import { combinePromptParts } from "../args";
import { findSequenceBody, findShotBody } from "../script";
import { useScriptStore } from "../../stores/scriptStore";
import type { ChainLink } from "../types";

/** Trim each prompt and drop the empties. */
export function nonEmptyTrimmed(prompts: string[]): string[] {
  return prompts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Single-line, 120-char-max snapshot of a shot prompt for the queue checklist. */
export function previewShotPrompt(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function scriptSegmentsFor(
  sequencePath: string | null,
  shotPath: string | null,
): { sequenceScript: string; shotScript: string } {
  const parsed = useScriptStore.getState().parsed;
  // Entity names — a PRISM shot path ends in `Renders/AI`, whose last segments
  // would never match a script heading.
  const seqName = sequencePath ? basename(sequencePath) : "";
  const { shot: shotName } = seqShotNames(shotPath);
  return {
    sequenceScript: seqName ? findSequenceBody(parsed, seqName) : "",
    shotScript:
      seqName && shotName ? findShotBody(parsed, seqName, shotName) : "",
  };
}

/** Inverse of combinePromptParts: which pieces made it into an already-built
 *  combined prompt. RESTORE PROMPT needs this because the flat sidecar records
 *  the pieces and the exact combined string but not the include ticks — and
 *  combinePromptParts joins the trimmed pieces verbatim, so a substring test
 *  is exact. An empty piece (or no combined string, i.e. an older sidecar)
 *  reads as included, matching the "undefined means included" default.
 *
 *  Two accepted imprecisions: a script edited since the generation no longer
 *  matches and so comes back unticked (which does reproduce the recorded
 *  prompt), and a piece that happens to be a substring of another stays
 *  ticked — the same result as not inferring at all. */
export function inferIncludes(
  combined: string,
  parts: {
    sequenceScript: string;
    sequencePrompt: string;
    shotScript: string;
    shotPrompts: string[];
  },
): {
  sequenceScript: boolean;
  sequencePrompt: boolean;
  shotScript: boolean;
  shotPrompts: boolean[];
} {
  const present = (piece: string): boolean => {
    const t = piece.trim();
    if (!combined || !t) return true;
    return combined.includes(t);
  };
  return {
    sequenceScript: present(parts.sequenceScript),
    sequencePrompt: present(parts.sequencePrompt),
    shotScript: present(parts.shotScript),
    shotPrompts: parts.shotPrompts.map(present),
  };
}

/** Build the final combined prompt for a link respecting inclusion flags and
 *  the loaded script segments matched against current sequence/shot folders. */
export function buildCombinedForLink(
  link: ChainLink,
  sequencePath: string | null,
  shotPath: string | null,
): string {
  const { sequenceScript, shotScript } = scriptSegmentsFor(sequencePath, shotPath);
  const shotIncludes = link.shotPromptsIncluded ?? link.shotPrompts.map(() => true);
  return combinePromptParts({
    sequenceScript,
    sequencePrompt: link.sequencePrompt,
    shotScript,
    shotPrompts: link.shotPrompts,
    includes: {
      sequenceScript: link.sequenceScriptIncluded !== false,
      sequencePrompt: link.sequencePromptIncluded !== false,
      shotScript: link.shotScriptIncluded !== false,
      shotPrompts: link.shotPrompts.map((_, i) => shotIncludes[i] !== false),
    },
  });
}

/** Fan a link's shot prompts out into one combined prompt per included,
 *  non-empty shot prompt. Shared parts (sequence script + sequence prompt +
 *  shot script) are prepended to each — respecting their inclusion flags —
 *  exactly like buildCombinedForLink, but only one shot prompt per entry.
 *  When no shot prompt qualifies but a shared header exists, returns a single
 *  header-only entry. Returns [] only when everything is empty. */
export function buildPromptsForLink(
  link: ChainLink,
  sequencePath: string | null,
  shotPath: string | null,
): { combined: string; shotPrompt: string }[] {
  const { sequenceScript, shotScript } = scriptSegmentsFor(sequencePath, shotPath);
  const shotIncludes = link.shotPromptsIncluded ?? link.shotPrompts.map(() => true);
  const headerIncludes = {
    sequenceScript: link.sequenceScriptIncluded !== false,
    sequencePrompt: link.sequencePromptIncluded !== false,
    shotScript: link.shotScriptIncluded !== false,
  };

  const runs: { combined: string; shotPrompt: string }[] = [];
  link.shotPrompts.forEach((sp, i) => {
    if (shotIncludes[i] === false) return;
    if (sp.trim().length === 0) return;
    const combined = combinePromptParts({
      sequenceScript,
      sequencePrompt: link.sequencePrompt,
      shotScript,
      shotPrompts: [sp],
      includes: { ...headerIncludes, shotPrompts: [true] },
    });
    if (combined.length > 0) runs.push({ combined, shotPrompt: sp.trim() });
  });

  if (runs.length === 0) {
    const headerOnly = combinePromptParts({
      sequenceScript,
      sequencePrompt: link.sequencePrompt,
      shotScript,
      shotPrompts: [],
      includes: { ...headerIncludes, shotPrompts: [] },
    });
    if (headerOnly.length > 0) runs.push({ combined: headerOnly, shotPrompt: "" });
  }
  return runs;
}
