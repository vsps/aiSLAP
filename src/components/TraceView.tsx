import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineStore } from "../stores/timelineStore";
import { editTagsAt, selectImagePath as selectImageAction } from "../lib/actions";
import { Thumbnail } from "./Thumbnail";
import type { GalleryImage, RefImage } from "../lib/types";
import { dirname } from "../lib/paths";
import { syntheticImage } from "../lib/media";

type Props = {
  onDragStart: (payload: {
    fromPath: string;
    fromColumnVersion: string;
    pointerEvent: React.PointerEvent;
  }) => void;
};

const NODE_WIDTH = 96;
const COL_GAP = 72; // horizontal gap between columns — leaves room for edges
const ROW_GAP = 8;
const PAD = 16;

/** Last two segments of the parent path, e.g. ".../shot_03/v002" — used as a
 *  per-node title tooltip so the user can see which shot/version a node lives
 *  in without taking screen space for a label row. */
function labelFor(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 3
    ? `${parts[parts.length - 3]}/${parts[parts.length - 2]}`
    : parts.slice(0, -1).join("/");
}

// Edge stroke palette keyed by ref roleAssignment.kind. Aligned with the
// ref-role colours used elsewhere in the app where applicable.
const EDGE_COLORS: Record<string, string> = {
  start: "#22c55e",
  end: "#ef4444",
  source: "#3b82f6",
  element: "#f59e0b",
  image: "#a855f7",
  chain_prev: "#14b8a6",
};
const DEFAULT_EDGE = "#6b7280";
function edgeColor(role: string | null): string {
  return (role && EDGE_COLORS[role]) || DEFAULT_EDGE;
}
const PALETTE = Array.from(
  new Set([...Object.values(EDGE_COLORS), DEFAULT_EDGE]),
);
function markerId(color: string): string {
  return `trace-arrow-${color.replace("#", "")}`;
}

type LayoutResult = {
  /** Outer index = depth (column from left). Inner = paths ordered by y-rank. */
  columns: string[][];
  edges: { parent: string; child: string; role: string | null }[];
};

/** Assign each node a depth (max parent depth + 1) and a y-rank inside its
 *  column (mean of parents' y-ranks, tiebroken by path) so each child sits
 *  near its parents. Iterative pass — converges on any DAG; on a stray cycle
 *  the offending nodes settle in the last column instead of looping. */
function computeLayout(
  nodes: Set<string>,
  parentsMap: Map<string, RefImage[]>,
): LayoutResult {
  const parentsByChild = new Map<string, string[]>();
  for (const [child, refs] of parentsMap) {
    parentsByChild.set(
      child,
      refs.map((r) => r.path).filter((p) => nodes.has(p)),
    );
  }
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n, 0);
  let changed = true;
  let iter = 0;
  while (changed && iter < nodes.size + 1) {
    changed = false;
    iter++;
    for (const n of nodes) {
      const ps = parentsByChild.get(n) ?? [];
      const newD =
        ps.length === 0
          ? 0
          : Math.max(...ps.map((p) => depth.get(p) ?? 0)) + 1;
      if ((depth.get(n) ?? 0) !== newD) {
        depth.set(n, newD);
        changed = true;
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of nodes) columns[depth.get(n) ?? 0].push(n);

  const yRank = new Map<string, number>();
  columns.forEach((col, d) => {
    const sorted =
      d === 0
        ? col.slice().sort()
        : col.slice().sort((a, b) => {
            const ap = parentsByChild.get(a) ?? [];
            const bp = parentsByChild.get(b) ?? [];
            const am = ap.length
              ? ap.reduce((s, p) => s + (yRank.get(p) ?? 0), 0) / ap.length
              : 0;
            const bm = bp.length
              ? bp.reduce((s, p) => s + (yRank.get(p) ?? 0), 0) / bp.length
              : 0;
            return am - bm || a.localeCompare(b);
          });
    columns[d] = sorted;
    sorted.forEach((p, i) => yRank.set(p, i));
  });

  const edges: LayoutResult["edges"] = [];
  for (const [child, refs] of parentsMap) {
    if (!nodes.has(child)) continue;
    for (const r of refs) {
      if (!nodes.has(r.path)) continue;
      edges.push({
        parent: r.path,
        child,
        role: r.roleAssignment?.kind ?? null,
      });
    }
  }
  return { columns, edges };
}

export function TraceView({ onDragStart }: Props) {
  const traceActive = useSessionStore((s) => s.traceActive);
  const selectedImagePath = useSessionStore((s) => s.selectedImagePath);
  const galleryColumns = useSessionStore((s) => s.columns);
  const shotsLatestMedia = useTimelineStore((s) => s.shotsLatestMedia);
  const setShotClipMedia = useTimelineStore((s) => s.setShotClipMedia);

  const layout = useMemo(
    () =>
      traceActive
        ? computeLayout(traceActive.traceSet, traceActive.parents)
        : null,
    [traceActive],
  );

  const layoutRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setNodeRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) nodeRefs.current.set(path, el);
      else nodeRefs.current.delete(path);
    },
    [],
  );

  const [edgePaths, setEdgePaths] = useState<{ d: string; color: string }[]>(
    [],
  );
  const [size, setSize] = useState({ w: 0, h: 0 });

  const recompute = useCallback(() => {
    const layoutEl = layoutRef.current;
    if (!layoutEl || !layout) return;
    const rect = layoutEl.getBoundingClientRect();
    const pos = new Map<
      string,
      { x: number; y: number; w: number; h: number }
    >();
    for (const [p, el] of nodeRefs.current) {
      const r = el.getBoundingClientRect();
      pos.set(p, {
        x: r.left - rect.left,
        y: r.top - rect.top,
        w: r.width,
        h: r.height,
      });
    }
    const paths: { d: string; color: string }[] = [];
    for (const e of layout.edges) {
      const p = pos.get(e.parent);
      const c = pos.get(e.child);
      if (!p || !c) continue;
      const px = p.x + p.w;
      const py = p.y + p.h / 2;
      const cx = c.x;
      const cy = c.y + c.h / 2;
      const dx = Math.max(32, Math.abs(cx - px) * 0.5);
      paths.push({
        d: `M ${px},${py} C ${px + dx},${py} ${cx - dx},${cy} ${cx},${cy}`,
        color: edgeColor(e.role),
      });
    }
    setEdgePaths(paths);
    setSize({ w: layoutEl.scrollWidth, h: layoutEl.scrollHeight });
  }, [layout]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const layoutEl = layoutRef.current;
    if (!layoutEl) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(layoutEl);
    return () => ro.disconnect();
  }, [recompute]);

  // Resolve a traced path to its scanned gallery image when available so the
  // visibility star reflects real state; fall back to a synthetic image for
  // paths outside the current shot's scan.
  const imageFor = (p: string): GalleryImage =>
    galleryColumns.flatMap((c) => c.images).find((i) => i.path === p) ??
    syntheticImage(p);

  if (!traceActive || !layout || layout.columns.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-dim">
        No traced images.
      </div>
    );
  }

  const seed = traceActive.imagePath;

  return (
    <div className="flex-1 min-h-0 overflow-auto thin-scroll bg-surface">
      <div
        ref={layoutRef}
        className="relative inline-flex items-start"
        style={{ gap: `${COL_GAP}px`, padding: `${PAD}px` }}
      >
        {layout.columns.map((col, d) => (
          <div
            key={d}
            className="flex flex-col items-stretch"
            style={{ gap: `${ROW_GAP}px`, width: `${NODE_WIDTH}px` }}
          >
            {col.map((p) => {
              const img = imageFor(p);
              const traceShotPath = dirname(dirname(p));
              const knownShot = shotsLatestMedia.has(traceShotPath);
              const clipSelected =
                knownShot &&
                shotsLatestMedia.get(traceShotPath)?.clipMediaPath === p;
              const isSeed = p === seed;
              return (
                <div
                  key={p}
                  ref={setNodeRef(p)}
                  className={
                    isSeed
                      ? "outline outline-2 outline-accent outline-offset-2"
                      : ""
                  }
                  title={labelFor(p)}
                >
                  <Thumbnail
                    image={img}
                    selected={selectedImagePath === p}
                    columnVersion={labelFor(p)}
                    onSelect={selectImageAction}
                    onEditTags={editTagsAt}
                    onDragStart={onDragStart}
                    clipMediaSelected={clipSelected}
                    onToggleClipMedia={
                      knownShot
                        ? () =>
                            void setShotClipMedia(
                              traceShotPath,
                              clipSelected ? null : p,
                            )
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        ))}
        {size.w > 0 && (
          <svg
            className="absolute top-0 left-0 pointer-events-none"
            width={size.w}
            height={size.h}
            style={{ width: size.w, height: size.h }}
          >
            <defs>
              {PALETTE.map((c) => (
                <marker
                  key={c}
                  id={markerId(c)}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill={c} />
                </marker>
              ))}
            </defs>
            {edgePaths.map((ep, i) => (
              <path
                key={i}
                d={ep.d}
                stroke={ep.color}
                strokeWidth={1.5}
                fill="none"
                opacity={0.75}
                markerEnd={`url(#${markerId(ep.color)})`}
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
