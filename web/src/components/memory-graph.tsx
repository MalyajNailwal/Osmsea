"use client";

import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

export type MemoryKind = "finding" | "evidence" | "summary" | "decision" | "note";
export type GraphNode = SimulationNodeDatum & { id: string; type: "item" | "source" | "agent"; label: string; kind?: string };
export type GraphEdge = { source: string; target: string; rel: "cites" | "produced_by" };
type SimEdge = SimulationLinkDatum<GraphNode> & { rel: GraphEdge["rel"] };
type Shape = "circle" | "square" | "diamond" | "triangle" | "hexagon";
type View = { k: number; x: number; y: number };

export const KINDS: MemoryKind[] = ["finding", "evidence", "summary", "decision", "note"];
/** Dataviz categorical dark slots, fixed order. All-pairs CVD fails for 5 slots, so shape is the secondary encoding. */
export const KIND_COLOR: Record<string, string> = {
  finding: "#3987e5", evidence: "#d95926", summary: "#199e70", decision: "#c98500", note: "#d55181",
};
export const KIND_SHAPE: Record<string, Shape> = {
  finding: "circle", evidence: "square", summary: "diamond", decision: "triangle", note: "hexagon",
};
export const SOURCE_COLOR = "#898781";
export const AGENT_COLOR = "#9085e9";
const SURFACE = "#080912";

export function shapePath(shape: Shape, r: number): string {
  switch (shape) {
    case "square": { const s = r * 0.88; return `M${-s},${-s}H${s}V${s}H${-s}Z`; }
    case "diamond": { const s = r * 1.2; return `M0,${-s}L${s},0L0,${s}L${-s},0Z`; }
    case "triangle": { const s = r * 1.25; return `M0,${-s}L${s * 0.95},${s * 0.7}L${-s * 0.95},${s * 0.7}Z`; }
    case "hexagon":
      return Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${i ? "L" : "M"}${(r * 1.05 * Math.cos(a)).toFixed(2)},${(r * 1.05 * Math.sin(a)).toFixed(2)}`;
      }).join("") + "Z";
    default:
      return `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  }
}

/** Small legend/list glyph: kind shape + color, or a source/agent marker. */
export function KindGlyph({ kind, size = 12 }: { kind: string; size?: number }) {
  const r = size / 2 - 1.5;
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="shrink-0" aria-hidden>
      {kind === "source" ? <circle r={r * 0.8} fill={SOURCE_COLOR} />
        : kind === "agent" ? <circle r={r} fill={SURFACE} stroke={AGENT_COLOR} strokeWidth={2} />
          : <path d={shapePath(KIND_SHAPE[kind] ?? "circle", r * 0.85)} fill={KIND_COLOR[kind] ?? SOURCE_COLOR} />}
    </svg>
  );
}

function radius(n: GraphNode, degree: Map<string, number>): number {
  if (n.type === "agent") return 10;
  if (n.type === "source") return 4.5;
  return 6 + Math.min(degree.get(n.id) ?? 0, 6) * 0.6;
}

function fitView(nodes: GraphNode[], width: number, height: number): View {
  if (!nodes.length || !width) return { k: 1, x: width / 2, y: height / 2 };
  const xs = nodes.map((n) => n.x ?? 0);
  const ys = nodes.map((n) => n.y ?? 0);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 60;
  const k = Math.min((width - pad * 2) / Math.max(x1 - x0, 1), (height - pad * 2) / Math.max(y1 - y0, 1), 2.2);
  return { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
}

const trunc = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function MemoryGraph({ nodes, edges, selectedId, onSelect, showLabels, fitSignal, zoomSignal, height = 560 }: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showLabels: boolean;
  fitSignal: number;
  zoomSignal?: { n: number; factor: number };
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    }
    return d;
  }, [edges]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [edges]);

  // Layout is computed up front (pre-cooled), so the graph appears settled with no load-time jitter.
  // ponytail: synchronous 300 ticks; move to a web worker if graphs grow past a few thousand nodes.
  const layout = useMemo(() => {
    const ns: GraphNode[] = nodes.map((n) => ({ ...n }));
    const es: SimEdge[] = edges.map((e) => ({ ...e }));
    const sim = forceSimulation(ns)
      .force("link", forceLink<GraphNode, SimEdge>(es).id((d) => d.id).distance((e) => (e.rel === "cites" ? 42 : 70)).strength(0.55))
      .force("charge", forceManyBody<GraphNode>().strength((d) => (d.type === "agent" ? -260 : -80)))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<GraphNode>((d) => radius(d, degree) + 4))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    return { sim, nodes: ns, edges: es };
  }, [nodes, edges, degree]);

  // Live ticks only while a node is dragged; re-render at most once per animation frame.
  useEffect(() => {
    let raf = 0;
    layout.sim.on("tick", () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setFrame((f) => f + 1); });
    });
    return () => { layout.sim.stop(); layout.sim.on("tick", null); cancelAnimationFrame(raf); };
  }, [layout]);

  // Manual pan/zoom is remembered per layout + fit request; otherwise the view auto-fits.
  const fit = useMemo(() => fitView(layout.nodes, width, height), [layout, width, height]);
  const [manual, setManual] = useState<{ layout: unknown; signal: number; view: View } | null>(null);
  const view = manual && manual.layout === layout && manual.signal === fitSignal ? manual.view : fit;
  const live = useRef({ view, layout, fitSignal });
  useEffect(() => { live.current = { view, layout, fitSignal }; });

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const { view: v, layout: l, fitSignal: s } = live.current;
    const k = Math.min(Math.max(v.k * factor, 0.15), 6);
    setManual({ layout: l, signal: s, view: { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k } });
  };

  // Wheel zoom needs a non-passive listener to stop page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [width]);

  const lastZoom = useRef(zoomSignal?.n ?? 0);
  useEffect(() => {
    if (!zoomSignal || zoomSignal.n === lastZoom.current) return;
    lastZoom.current = zoomSignal.n;
    zoomAt(zoomSignal.factor, width / 2, height / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSignal]);

  const drag = useRef<{ mode: "pan" | "node"; node?: GraphNode; sx: number; sy: number; start: View; moved: boolean } | null>(null);

  const onPointerDown = (e: ReactPointerEvent, node?: GraphNode) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode: node ? "node" : "pan", node, sx: e.clientX, sy: e.clientY, start: view, moved: false };
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
      layout.sim.alphaTarget(0.25).restart();
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === "pan") {
      setManual({ layout, signal: fitSignal, view: { ...d.start, x: d.start.x + dx, y: d.start.y + dy } });
    } else if (d.node) {
      const r = svgRef.current!.getBoundingClientRect();
      d.node.fx = (e.clientX - r.left - view.x) / view.k;
      d.node.fy = (e.clientY - r.top - view.y) / view.k;
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.node) {
      d.node.fx = null;
      d.node.fy = null;
      layout.sim.alphaTarget(0);
    }
    if (!d.moved) onSelect(d.node ? d.node.id : null);
  };

  const focus = hover ?? selectedId;
  const near = focus ? new Set([focus, ...(neighbors.get(focus) ?? [])]) : null;
  const hovered = hover ? layout.nodes.find((n) => n.id === hover) : undefined;

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <svg ref={svgRef} width={width} height={height} className="block cursor-grab touch-none active:cursor-grabbing"
        role="img" aria-label={`Knowledge graph with ${nodes.length} nodes and ${edges.length} edges`}
        onPointerDown={(e) => onPointerDown(e)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setHover(null)}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.edges.map((e, i) => {
            const s = e.source as GraphNode;
            const t = e.target as GraphNode;
            const lit = near ? near.has(s.id) && near.has(t.id) : false;
            return (
              <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} strokeWidth={(lit ? 1.6 : 1) / Math.sqrt(view.k)}
                stroke={lit ? "#a99fff" : "rgb(255 255 255)"} strokeOpacity={lit ? 0.75 : near ? 0.05 : 0.14}
                strokeDasharray={e.rel === "produced_by" ? "3 3" : undefined} />
            );
          })}
          {layout.nodes.map((n) => {
            const r = radius(n, degree);
            const dim = near && !near.has(n.id);
            const selected = n.id === selectedId;
            const label = n.type === "agent" || showLabels || (near?.has(n.id) && (n.id === focus || n.type !== "item"));
            return (
              <g key={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`} opacity={dim ? 0.22 : 1}
                className="cursor-pointer" onPointerDown={(e) => onPointerDown(e, n)}
                onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}>
                {selected && <circle r={r + 6} fill="none" stroke="#a99fff" strokeWidth={2} />}
                {n.type === "agent" ? <circle r={r} fill={SURFACE} stroke={AGENT_COLOR} strokeWidth={2.5} />
                  : n.type === "source" ? <circle r={r} fill={SOURCE_COLOR} stroke={SURFACE} strokeWidth={2} />
                    : <path d={shapePath(KIND_SHAPE[n.kind ?? ""] ?? "circle", r)} fill={KIND_COLOR[n.kind ?? ""] ?? SOURCE_COLOR}
                      stroke={SURFACE} strokeWidth={2} />}
                {label && (
                  <text y={r + 11} textAnchor="middle" fontSize={10 / Math.max(view.k, 0.8)}
                    className={n.type === "agent" ? "fill-ink" : "fill-ink-2"}
                    style={{ paintOrder: "stroke", stroke: SURFACE, strokeWidth: 3, strokeLinejoin: "round", pointerEvents: "none" }}>
                    {trunc(n.label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute z-10 max-w-72 rounded-lg border border-line-strong bg-[#0b0d17]/95 px-2.5 py-1.5 text-[11px] shadow-xl"
          style={{ left: Math.min((hovered.x ?? 0) * view.k + view.x + 14, Math.max(width - 290, 0)), top: (hovered.y ?? 0) * view.k + view.y + 14 }}>
          <div className="font-medium text-ink">{hovered.label}</div>
          <div className="text-ink-3">
            {hovered.type === "item" ? hovered.kind : hovered.type} · {degree.get(hovered.id) ?? 0} connection(s)
          </div>
        </div>
      )}
    </div>
  );
}
