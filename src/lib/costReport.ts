// Pure client-side aggregation over a ProjectCostReport's flat per-image
// lines (from cmd.project_cost_lines) — no React, no IPC. This is what makes
// the Reports UI's user/model filtering instant: fetch the flat list once,
// then filter/aggregate/rebuild the Sankey entirely in memory.

import type { CostReportLine } from "./types";

export type CostReportFilter = {
  /** Matches `generatedBy` exactly (case-sensitive — values come straight
   *  from the OS username, not user-typed text). null = all users. */
  user: string | null;
  /** Matches `modelId` exactly. null = all models. */
  modelId: string | null;
};

export const EMPTY_FILTER: CostReportFilter = { user: null, modelId: null };

export function discoverUsers(lines: CostReportLine[]): string[] {
  const names = new Set<string>();
  for (const l of lines) if (l.generatedBy) names.add(l.generatedBy);
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function discoverModels(
  lines: CostReportLine[],
): { modelId: string; label: string }[] {
  const labels = new Map<string, string>();
  for (const l of lines) {
    if (!l.modelId) continue;
    if (!labels.has(l.modelId)) labels.set(l.modelId, l.model || l.modelId);
  }
  return [...labels.entries()]
    .map(([modelId, label]) => ({ modelId, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function applyFilter(
  lines: CostReportLine[],
  filter: CostReportFilter,
): CostReportLine[] {
  if (!filter.user && !filter.modelId) return lines;
  return lines.filter(
    (l) =>
      (!filter.user || l.generatedBy === filter.user) &&
      (!filter.modelId || l.modelId === filter.modelId),
  );
}

export type CostSummary = {
  totalCostUsd: number;
  knownCount: number;
  unknownCount: number;
};

export function summarize(lines: CostReportLine[]): CostSummary {
  let totalCostUsd = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const l of lines) {
    if (typeof l.costUsd === "number") {
      totalCostUsd += l.costUsd;
      knownCount += 1;
    } else {
      unknownCount += 1;
    }
  }
  return { totalCostUsd, knownCount, unknownCount };
}

export type CostBucket = {
  key: string;
  label: string;
  costUsd: number;
  count: number;
};

const UNATTRIBUTED = "(unattributed)";

function bucketBy(
  lines: CostReportLine[],
  keyOf: (l: CostReportLine) => string | undefined,
  labelOf: (l: CostReportLine) => string | undefined,
): CostBucket[] {
  const buckets = new Map<string, CostBucket>();
  for (const l of lines) {
    const key = keyOf(l) ?? UNATTRIBUTED;
    const label = key === UNATTRIBUTED ? UNATTRIBUTED : (labelOf(l) ?? key);
    const existing = buckets.get(key);
    const costUsd = typeof l.costUsd === "number" ? l.costUsd : 0;
    if (existing) {
      existing.costUsd += costUsd;
      existing.count += 1;
    } else {
      buckets.set(key, { key, label, costUsd, count: 1 });
    }
  }
  return [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export function costByModel(lines: CostReportLine[]): CostBucket[] {
  return bucketBy(
    lines,
    (l) => l.modelId,
    (l) => l.model,
  );
}

export function costByUser(lines: CostReportLine[]): CostBucket[] {
  return bucketBy(
    lines,
    (l) => l.generatedBy,
    (l) => l.generatedBy,
  );
}

// ---------- Sankey ----------

export type SankeyNode = {
  id: string;
  label: string;
  level: 0 | 1 | 2 | 3;
  /** The ancestor sequence name — even for shot/version nodes. Not used for
   *  color (every node gets its own color, see nodeColor) but kept for any
   *  future grouping/labeling use. */
  sequence: string;
};

export type SankeyLink = {
  source: string;
  target: string;
  value: number;
};

export type SankeyData = {
  nodes: SankeyNode[];
  links: SankeyLink[];
};

const ROOT_ID = "total";

/** Total -> sequence -> shot -> version, aggregated from per-image lines.
 *  Only lines with a known costUsd contribute flow — unpriced images are
 *  already surfaced via summarize()'s unknownCount, not silently dropped,
 *  just not flow-charted (a Sankey link needs a numeric value). Node ids are
 *  namespaced by level plus the line's own shotKey/version so two sequences
 *  that happen to share a shot or version name never collide. */
export function buildSankeyData(lines: CostReportLine[]): SankeyData {
  const nodeLabels = new Map<string, { label: string; level: 0 | 1 | 2 | 3; sequence: string }>();
  const linkValues = new Map<string, number>();

  nodeLabels.set(ROOT_ID, { label: "Total", level: 0, sequence: "" });

  const addLink = (source: string, target: string, value: number) => {
    const key = `${source} ${target}`;
    linkValues.set(key, (linkValues.get(key) ?? 0) + value);
  };

  for (const l of lines) {
    if (typeof l.costUsd !== "number") continue;

    const seqId = `seq:${l.sequence}`;
    const shotId = `shot:${l.shotKey}`;
    const versionId = `version:${l.shotKey}/${l.version}`;

    if (!nodeLabels.has(seqId)) {
      nodeLabels.set(seqId, { label: l.sequence, level: 1, sequence: l.sequence });
    }
    if (!nodeLabels.has(shotId)) {
      nodeLabels.set(shotId, { label: l.shot, level: 2, sequence: l.sequence });
    }
    if (!nodeLabels.has(versionId)) {
      nodeLabels.set(versionId, { label: l.version, level: 3, sequence: l.sequence });
    }

    addLink(ROOT_ID, seqId, l.costUsd);
    addLink(seqId, shotId, l.costUsd);
    addLink(shotId, versionId, l.costUsd);
  }

  const nodes: SankeyNode[] = [...nodeLabels.entries()].map(([id, v]) => ({ id, ...v }));
  const links: SankeyLink[] = [...linkValues.entries()].map(([key, value]) => {
    const [source, target] = key.split(" ");
    return { source, target, value };
  });

  return { nodes, links };
}

/** Deterministic string hash (FNV-1a, 32-bit) — used to derive a node's hue
 *  purely from its own id, not its position among siblings. That's what
 *  makes colors stable under filtering: a node's color never changes just
 *  because other nodes were added/removed around it. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Every distinct id gets its own hue, spread via the golden angle so
 *  adjacent hash values (e.g. "version:a/b/v001" vs "v002") don't cluster
 *  next to each other on the color wheel. Fixed saturation/lightness tuned
 *  to sit alongside the app's existing accent colors on its dark surface. */
export function nodeColor(id: string): string {
  const hue = (fnv1a(id) * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}deg 75% 60%)`;
}

/** Per-node color map for a Sankey's node set — every node (including the
 *  root) gets its own distinct color via nodeColor(). */
export function buildNodeColorMap(nodes: SankeyNode[]): Map<string, string> {
  return new Map(nodes.map((n) => [n.id, nodeColor(n.id)]));
}

const CSV_COLUMNS = [
  "Sequence",
  "Shot",
  "Version",
  "Provider",
  "ModelId",
  "Model",
  "GeneratedBy",
  "CostUsd",
] as const;

/** RFC4180-ish quoting: only quote a field that needs it (contains a comma,
 *  quote, or newline), doubling any internal quotes. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize report lines to CSV — one row per image, in the same shape as
 *  the Reports tab (whatever's passed in should already be filtered, so the
 *  export matches what's on screen). costUsd is blank, not 0, for an unpriced
 *  image — a real $0 charge and "unknown" are different things. */
export function linesToCsv(lines: CostReportLine[]): string {
  const rows = lines.map((l) =>
    [
      l.sequence,
      l.shot,
      l.version,
      l.provider ?? "",
      l.modelId ?? "",
      l.model ?? "",
      l.generatedBy ?? "",
      typeof l.costUsd === "number" ? l.costUsd.toString() : "",
    ]
      .map(csvField)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n");
}
