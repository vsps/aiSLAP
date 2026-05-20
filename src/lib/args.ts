import type { KlingElement, ModelNode, RefRoleSpec, UploadedRef } from "./types";
import { classifyMedia, type MediaKind } from "./media";

export function buildArgs(
  node: ModelNode,
  sequencePrompt: string,
  shotPrompt: string,
  settings: Record<string, unknown>,
  uploaded: UploadedRef[],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(settings)) {
    if (k === "seed" && v === -1) continue;
    if (k === "image_size" && typeof v === "string") {
      const m = v.match(/^(\d+)x(\d+)$/);
      if (m) { args[k] = { width: Number(m[1]), height: Number(m[2]) }; continue; }
    }
    args[k] = v;
  }

  const combined = [sequencePrompt, shotPrompt]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (combined.length > 0) args["prompt"] = combined;

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
    // forcing a role click for every thumb.
    const hasElementRole = node.ref_roles.some((r) => r.role === "element");
    if (
      hasElementRole &&
      Object.keys(bucket).length === 0 &&
      unassigned.length > 0
    ) {
      unassigned.forEach((u, i) => {
        bucket[`element:${i + 1}`] = [u];
      });
      unassigned.length = 0;
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
  const buckets: Record<MediaKind, string[]> = { image: [], video: [], audio: [] };

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

export function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
