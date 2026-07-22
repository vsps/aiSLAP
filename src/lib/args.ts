import type { KlingElement, ModelNode, RefRoleSpec, UploadedRef } from "./types";
import { classifyMedia, type MediaKind } from "./media";

export type PromptParts = {
  sequenceScript: string;
  sequencePrompt: string;
  shotScript: string;
  shotPrompts: string[];
  includes: {
    sequenceScript: boolean;
    sequencePrompt: boolean;
    shotScript: boolean;
    shotPrompts: boolean[];
  };
};

export function combinePromptParts(parts: PromptParts): string {
  const pieces: string[] = [];
  if (parts.includes.sequenceScript && parts.sequenceScript) pieces.push(parts.sequenceScript);
  if (parts.includes.sequencePrompt) pieces.push(parts.sequencePrompt);
  if (parts.includes.shotScript && parts.shotScript) pieces.push(parts.shotScript);
  parts.shotPrompts.forEach((p, i) => {
    if (parts.includes.shotPrompts[i] !== false) pieces.push(p);
  });
  return pieces.map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n");
}

/** Split LLM output into multiple prompts on a `---` delimiter line.
 *  Splits on a line containing only the delimiter, trims each section, and
 *  drops empties. Returns the trimmed whole as a single element when no
 *  delimiter is present. */
export function splitPromptsByDelimiter(text: string, delim = "---"): string[] {
  const re = new RegExp(`^\\s*${delim}\\s*$`, "m");
  return text
    .split(re)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Models that accept a negative_prompt field have no dedicated input for it
 *  (there's nowhere in the settings panel to type one) — instead, a `---`
 *  anywhere in the combined prompt splits it: everything before is the
 *  actual prompt, everything after (to the end) is the negative prompt.
 *  Matches a run of 3+ dashes so "----" etc. doesn't leave a stray dash
 *  behind. No delimiter present → the whole text is the prompt. */
export function splitNegativePrompt(text: string): {
  prompt: string;
  negativePrompt: string;
} {
  const m = text.match(/-{3,}/);
  if (!m || m.index === undefined) return { prompt: text, negativePrompt: "" };
  return {
    prompt: text.slice(0, m.index).trim(),
    negativePrompt: text.slice(m.index + m[0].length).trim(),
  };
}

/** The model's negative_prompt parameter, if it declares one — same lookup
 *  used by buildArgs (to route the split) and buildMetadataRecord (to
 *  persist what was actually sent). */
export function negativePromptParam(node: ModelNode) {
  return node.parameters.find((p) => p.name === "negative_prompt");
}

export function buildArgs(
  node: ModelNode,
  combinedPrompt: string,
  settings: Record<string, unknown>,
  uploaded: UploadedRef[],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(settings)) {
    if (k === "seed" && v === -1) continue;
    // Drop empty arrays (e.g. unused SAM point_prompts/box_prompts) so we don't
    // send empty fields. No model stores non-prompt array settings.
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === "image_size" && typeof v === "string") {
      const m = v.match(/^(\d+)x(\d+)$/);
      if (m) { args[k] = { width: Number(m[1]), height: Number(m[2]) }; continue; }
    }
    args[k] = v;
  }

  // Only inject the shot/sequence prompt text if the node actually declares a
  // "prompt" input. Utility nodes (SAM segmentation, depth extraction, etc.)
  // have no such input — SAM 3 in particular treats `prompt` as a text-based
  // concept filter defaulting to "wheel", so leaking the story prompt in
  // there silently constrains segmentation to match that text, causing
  // spurious "no mask" results even with valid point/box prompts.
  const wantsPrompt = node.inputs.some((i) => i.api_field === "prompt");
  if (wantsPrompt && combinedPrompt.length > 0) {
    const negParam = negativePromptParam(node);
    if (negParam) {
      const { prompt, negativePrompt } = splitNegativePrompt(combinedPrompt);
      args["prompt"] = prompt;
      if (negativePrompt) args[negParam.api_field] = negativePrompt;
    } else {
      args["prompt"] = combinedPrompt;
    }
  }

  // SAM-style geometry-prompt nodes (type "prompts") don't expose a text
  // input, but fal's `prompt` field on those endpoints still defaults to a
  // fixed placeholder concept ("wheel") when omitted. Send an explicit empty
  // string so point/box prompts aren't silently ANDed against that default.
  const hasGeometryPrompts = node.parameters.some((p) => p.type === "prompts");
  if (!wantsPrompt && hasGeometryPrompts) args["prompt"] = "";

  if (node.ref_roles && node.ref_roles.length > 0) {
    const bucket: Record<string, UploadedRef[]> = {};
    const unassigned: UploadedRef[] = [];
    for (const r of uploaded) {
      const a = r.ref.roleAssignment;
      if (!a) {
        unassigned.push(r);
        continue;
      }
      const key =
        a.kind === "element"
          ? `element:${a.groupName}`
          : a.kind === "image"
            ? `image:${a.groupName}`
            : a.kind;
      (bucket[key] ??= []).push(r);
    }

    // Auto-element fallback: if the model supports "element" AND the user
    // assigned no roles to anything, promote each unassigned ref to its own
    // element group. Lets Kling 3 ref2vid accept "just these images" without
    // forcing a role click for every thumb. Crucially, only sweep refs whose
    // media kind matches what the element role expects — otherwise on models
    // that ALSO have a "source" video slot (Kling 3 vid2vid ref) the user's
    // video would get pulled into elements and `video_url` would be left
    // empty, causing fal to error out with "field required".
    const elementRole = node.ref_roles.find((r) => r.role === "element");
    const elementInput = elementRole
      ? node.inputs.find((i) => i.api_field === elementRole.api_field)
      : null;
    const elementKind: MediaKind =
      elementInput?.data_type === "VIDEO"
        ? "video"
        : elementInput?.data_type === "AUDIO"
          ? "audio"
          : "image";
    if (
      elementRole &&
      Object.keys(bucket).length === 0 &&
      unassigned.length > 0
    ) {
      const sweep: UploadedRef[] = [];
      const keep: UploadedRef[] = [];
      for (const u of unassigned) {
        if (classifyMedia(u.ref.path) === elementKind) sweep.push(u);
        else keep.push(u);
      }
      sweep.forEach((u, i) => {
        bucket[`element:${i + 1}`] = [u];
      });
      // Mutate `unassigned` in place so the later selectForRole call sees
      // the filtered list (it's still the same array reference).
      unassigned.length = 0;
      unassigned.push(...keep);
    }

    let sourceConsumed = false;
    for (const role of node.ref_roles) {
      if (role.role === "element") {
        const elements = buildElements(bucket, role.max);
        if (elements.length > 0) args[role.api_field] = elements;
        continue;
      }
      if (role.role === "image") {
        const urls = buildImageArray(bucket, role.max);
        if (urls.length > 0) args[role.api_field] = urls;
        continue;
      }
      const slice = selectForRole(role, bucket, unassigned, sourceConsumed);
      if (slice.length === 0) continue;
      if (role.role === "source") sourceConsumed = true;
      const urls = slice.map((s) => s.url);
      const isScalar = urls.length === 1 && (role.max === 1 || role.exclusive);
      args[role.api_field] = isScalar ? urls[0] : urls;
    }
  } else if (uploaded.length > 0) {
    routeRefsByMediaType(node, uploaded, args);
  }

  for (const input of node.inputs) {
    if (input.api_format === "array" && input.api_field in args) {
      const v = args[input.api_field];
      if (!Array.isArray(v)) args[input.api_field] = [v];
    }
  }

  return args;
}

const DATA_TYPE_TO_KIND: Record<string, MediaKind> = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
};

// Route uploaded refs to the model's media-typed array inputs by classifying
// each ref's file extension. Backwards-compatible: if the only matching input
// is IMAGE (e.g. Happy Horse), every ref lands in image_urls as before.
function routeRefsByMediaType(
  node: ModelNode,
  uploaded: UploadedRef[],
  args: Record<string, unknown>,
): void {
  const slots = new Map<MediaKind, { api_field: string; max?: number }>();
  for (const input of node.inputs) {
    if (input.api_format !== "array") continue;
    const kind = DATA_TYPE_TO_KIND[input.data_type];
    if (!kind) continue;
    if (!slots.has(kind)) slots.set(kind, { api_field: input.api_field, max: input.max });
  }
  if (slots.size === 0) return;

  // Single-IMAGE-only nodes: accept everything into image_urls (legacy).
  const onlyImage = slots.size === 1 && slots.has("image");
  const buckets: Record<MediaKind, string[]> = { image: [], video: [], audio: [], model3d: [] };

  for (const u of uploaded) {
    const kind = onlyImage ? "image" : classifyMedia(u.ref.path);
    if (!kind || !slots.has(kind)) {
      console.warn(`[args] ref ${u.ref.path} has no matching input on ${node.id}; dropped`);
      continue;
    }
    buckets[kind].push(u.url);
  }

  for (const [kind, slot] of slots) {
    const list = buckets[kind];
    if (list.length === 0) continue;
    args[slot.api_field] = slot.max ? list.slice(0, slot.max) : list;
  }
}

function selectForRole(
  role: RefRoleSpec,
  bucket: Record<string, UploadedRef[]>,
  unassigned: UploadedRef[],
  sourceConsumed: boolean,
): UploadedRef[] {
  if (role.exclusive) {
    return (bucket[role.role] ?? []).slice(0, 1);
  }
  let picked = bucket[role.role] ?? [];
  if (picked.length === 0 && role.role === "source" && !sourceConsumed) {
    picked = unassigned;
  }
  return role.max ? picked.slice(0, role.max) : picked;
}

// Emit Kling-shaped elements[] — one entry per element:<groupName> bucket,
// ordered by numeric groupName (user-assigned; gaps collapse at emission time
// since Kling references elements positionally as @Element1..N).
function buildElements(
  bucket: Record<string, UploadedRef[]>,
  max?: number,
): KlingElement[] {
  const keys = Object.keys(bucket)
    .filter((k) => k.startsWith("element:"))
    .sort((a, b) => {
      const na = Number(a.slice(8));
      const nb = Number(b.slice(8));
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });

  const out: KlingElement[] = [];
  for (const key of keys) {
    const refs = bucket[key];
    if (refs.length === 0) continue;

    let frontal: string | undefined;
    const rest: string[] = [];
    for (const r of refs) {
      const a = r.ref.roleAssignment;
      if (a?.kind === "element" && a.frontal && !frontal) frontal = r.url;
      else rest.push(r.url);
    }
    if (!frontal) {
      frontal = refs[0].url;
      rest.shift();
    }
    out.push({
      frontal_image_url: frontal,
      reference_image_urls: rest.length > 0 ? rest : [frontal],
    });
  }
  return max ? out.slice(0, max) : out;
}

function buildImageArray(
  bucket: Record<string, UploadedRef[]>,
  max?: number,
): string[] {
  const keys = Object.keys(bucket)
    .filter((k) => k.startsWith("image:"))
    .sort((a, b) => {
      const na = Number(a.slice(6));
      const nb = Number(b.slice(6));
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  const urls: string[] = [];
  for (const key of keys) {
    for (const r of bucket[key]) urls.push(r.url);
  }
  return max ? urls.slice(0, max) : urls;
}

