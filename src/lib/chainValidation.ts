import type { ChainLink, ModelInput, ModelNode } from "./types";

export type ProblemSeverity = "error" | "warn";

export type LinkProblem = {
  linkId: string;
  severity: ProblemSeverity;
  message: string;
};

/** Output media type of a link's model. Image/video. */
function outputKindOf(model: ModelNode | null): "IMAGE" | "VIDEO" | null {
  if (!model) return null;
  const first = model.outputs?.[0]?.data_type;
  if (first === "IMAGE" || first === "VIDEO") return first;
  // Fall back to ModelKind when outputs aren't declared.
  if (model.kind === "image") return "IMAGE";
  if (model.kind === "video") return "VIDEO";
  return null;
}

/** Required media inputs (IMAGE/VIDEO) of a model. */
function requiredMediaInputs(model: ModelNode): ModelInput[] {
  return (model.inputs ?? []).filter(
    (i) => i.required && (i.data_type === "IMAGE" || i.data_type === "VIDEO"),
  );
}

/** Any media input slot (required or not) of the given type. */
function hasMediaSlotOfType(
  model: ModelNode,
  type: "IMAGE" | "VIDEO",
): boolean {
  return (model.inputs ?? []).some(
    (i) => i.data_type === type,
  );
}

/** Combined prompt text — same join used at submit. */
function combinedPrompt(link: ChainLink): string {
  return (link.sequencePrompt + link.shotPrompts.join("")).trim();
}

/**
 * Validate the chain. Returns a flat list of problems keyed by link id.
 * Inactive links are skipped (they pass through; their input/output is
 * ignored). Type checks compare each active link's required IMAGE/VIDEO
 * inputs against the previous active link's output kind.
 */
export function preflightChain(links: ChainLink[]): LinkProblem[] {
  const problems: LinkProblem[] = [];
  let prevOutput: "IMAGE" | "VIDEO" | null = null;
  let isHead = true;

  for (const link of links) {
    if (!link.active) continue;

    // Basic completeness checks.
    if (!link.model) {
      problems.push({
        linkId: link.id,
        severity: "error",
        message: "No model selected",
      });
      // Can't reason further about this link's types.
      isHead = false;
      prevOutput = null;
      continue;
    }
    if (combinedPrompt(link).length === 0) {
      problems.push({
        linkId: link.id,
        severity: "error",
        message: "Prompt is empty",
      });
    }

    // Chain-wiring checks (skip on the head).
    if (!isHead && link.consumesPrev) {
      if (prevOutput == null) {
        problems.push({
          linkId: link.id,
          severity: "warn",
          message: "No upstream output to consume",
        });
      } else if (!hasMediaSlotOfType(link.model, prevOutput)) {
        problems.push({
          linkId: link.id,
          severity: "error",
          message: `Model has no ${prevOutput} input but receives ${prevOutput} from previous link`,
        });
      }
    }

    // Required media inputs not covered (skip the prev slot it'd fill).
    const reqs = requiredMediaInputs(link.model);
    if (reqs.length > 0) {
      const userRefTypes = new Set<string>(
        link.refImages.map((r) => extToType(r.path)).filter(Boolean) as string[],
      );
      const prevContrib =
        !isHead && link.consumesPrev && prevOutput ? prevOutput : null;
      for (const r of reqs) {
        const covered =
          userRefTypes.has(r.data_type) || prevContrib === r.data_type;
        if (!covered) {
          problems.push({
            linkId: link.id,
            severity: "error",
            message: `Required ${r.data_type} input (${r.name}) has no source`,
          });
        }
      }
    }

    prevOutput = outputKindOf(link.model);
    isHead = false;
  }

  return problems;
}

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "avi"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function extToType(path: string): "IMAGE" | "VIDEO" | null {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return null;
  if (VIDEO_EXTS.has(ext)) return "VIDEO";
  if (IMAGE_EXTS.has(ext)) return "IMAGE";
  return null;
}

export function problemsByLinkId(
  problems: LinkProblem[],
): Map<string, LinkProblem[]> {
  const m = new Map<string, LinkProblem[]>();
  for (const p of problems) {
    const arr = m.get(p.linkId);
    if (arr) arr.push(p);
    else m.set(p.linkId, [p]);
  }
  return m;
}

export function worstSeverity(
  problems: LinkProblem[],
): ProblemSeverity | null {
  if (problems.length === 0) return null;
  return problems.some((p) => p.severity === "error") ? "error" : "warn";
}
