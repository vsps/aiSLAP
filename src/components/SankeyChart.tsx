import { useId, useMemo } from "react";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import { formatCost } from "../lib/falPrices";
import {
  buildNodeColorMap,
  type SankeyLink as CostSankeyLink,
  type SankeyNode as CostSankeyNode,
} from "../lib/costReport";

// Hand-rolled SVG rendering over d3-sankey's layout math — no chart
// component library exists in this app (everything else is hand-built), so
// this mirrors that: d3-sankey only computes node/link positions, all
// drawing is plain SVG styled with the app's existing CSS custom properties
// (var(--color-dim) etc — the same pattern tagsStore.ts already uses for
// UNKNOWN_TAG_COLOR).

type LayoutNode = CostSankeyNode & {
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  value?: number;
};

type LayoutLink = CostSankeyLink & {
  source: LayoutNode;
  target: LayoutNode;
  width?: number;
};

type Props = {
  nodes: CostSankeyNode[];
  links: CostSankeyLink[];
  width?: number;
};

const NODE_WIDTH = 12;
const NODE_PADDING = 10;
const ROW_HEIGHT = 20;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 900;
// Breathing room on all four sides, as a fraction of the canvas. Labels sit
// outside their node's rect, so without it the outer columns' text is clipped.
const MARGIN = 0.05;

export function SankeyChart({ nodes, links, width = 860 }: Props) {
  // Prefixes gradient ids so multiple charts on the same page never collide.
  const idPrefix = useId();

  const layout = useMemo(() => {
    if (nodes.length === 0 || links.length === 0) return null;

    // Height scales with the busiest column (version is usually the most
    // numerous level) so rows stay legible instead of being squeezed flat.
    // The margin is added on top of that plotting height rather than carved
    // out of it, so rows keep their ROW_HEIGHT either way.
    const maxColumnCount = [0, 1, 2, 3]
      .map((level) => nodes.filter((n) => n.level === level).length)
      .reduce((a, b) => Math.max(a, b), 1);
    const plotHeight = Math.min(
      MAX_HEIGHT,
      Math.max(MIN_HEIGHT, maxColumnCount * ROW_HEIGHT),
    );
    const height = Math.round(plotHeight / (1 - 2 * MARGIN));
    const marginX = width * MARGIN;
    const marginY = height * MARGIN;

    const generator = sankey<CostSankeyNode, Record<string, unknown>>()
      .nodeId((d) => d.id)
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .extent([
        [marginX, marginY],
        [width - marginX, height - marginY],
      ]);

    // d3-sankey mutates its input in place — clone so costReport.ts's pure
    // builder output stays untouched (callers may re-render from the same
    // filtered arrays without re-running buildSankeyData).
    const graph = generator({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });

    return { graph, height };
  }, [nodes, links, width]);

  if (!layout) {
    return (
      <div className="text-xs text-dim py-6 text-center border border-border">
        No priced generations match the current filter.
      </div>
    );
  }

  const { graph, height } = layout;
  // Every node gets its own color (hashed from its id — see nodeColor), not
  // just one per sequence, so no two nodes in the diagram look the same.
  const colorByNode = buildNodeColorMap(nodes);
  const pathGen = sankeyLinkHorizontal<CostSankeyNode, Record<string, unknown>>();
  const graphLinks = graph.links as unknown as LayoutLink[];
  const graphNodes = graph.nodes as unknown as LayoutNode[];

  const colorFor = (id: string) => colorByNode.get(id) ?? "var(--color-dim)";
  const gradientId = (i: number) => `${idPrefix}-link-${i}`;

  return (
    <div className="overflow-auto thin-scroll border border-border bg-bg">
      <svg width={width} height={height} className="block">
        <defs>
          {/* objectBoundingBox (the default) maps 0%/100% to each link path's
           *  own bounding box — since a sankey link runs left (source) to
           *  right (target), this fades smoothly from the source node's
           *  color to the target node's color along the flow. */}
          {graphLinks.map((link, i) => (
            <linearGradient key={i} id={gradientId(i)}>
              <stop offset="0%" stopColor={colorFor(link.source.id)} />
              <stop offset="100%" stopColor={colorFor(link.target.id)} />
            </linearGradient>
          ))}
        </defs>
        <g>
          {graphLinks.map((link, i) => {
            const d = pathGen(link as never);
            if (!d) return null;
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={`url(#${gradientId(i)})`}
                strokeOpacity={0.55}
                strokeWidth={Math.max(1, link.width ?? 0)}
              >
                <title>
                  {`${link.source.label} → ${link.target.label}: $${formatCost(link.value)}`}
                </title>
              </path>
            );
          })}
        </g>
        <g>
          {graphNodes.map((node) => {
            const color = colorFor(node.id);
            const x = node.x0 ?? 0;
            const y = node.y0 ?? 0;
            const w = (node.x1 ?? 0) - x;
            const h = Math.max(1, (node.y1 ?? 0) - y);
            const labelOnLeft = node.level === 3;
            return (
              <g key={node.id}>
                <rect x={x} y={y} width={w} height={h} fill={color}>
                  <title>{`${node.label}: $${formatCost(node.value ?? 0)}`}</title>
                </rect>
                <text
                  x={labelOnLeft ? x - 4 : x + w + 4}
                  y={y + h / 2}
                  dy="0.32em"
                  textAnchor={labelOnLeft ? "end" : "start"}
                  className="fill-text text-[10px] font-mono pointer-events-none select-none"
                >
                  {node.label}
                  <tspan dx="6" className="fill-dim">
                    ${formatCost(node.value ?? 0)}
                  </tspan>
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
