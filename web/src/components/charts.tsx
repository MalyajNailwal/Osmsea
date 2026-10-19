"use client";

import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { useEffect, useMemo, useRef, useState } from "react";
import { compact, usd } from "@/lib/format";

/** Status roles from the dataviz status palette. Always rendered with a text label, never color alone. */
export const VIZ = { good: "#0ca30c", bad: "#d03b3b", warn: "#fab219", blue: "#3987e5", muted: "#898781" } as const;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

type Tip = { x: number; y: number; lines: string[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="pointer-events-none absolute z-10 rounded-lg border border-line-strong bg-[#161616]/95 px-2.5 py-1.5 text-[11px] shadow-xl"
      style={{ left: tip.x + 12, top: tip.y + 12 }}>
      {tip.lines.map((l, i) => <div key={i} className={i === 0 ? "font-medium text-ink" : "text-ink-2"}>{l}</div>)}
    </div>
  );
}

// --- Flow (Sankey) -------------------------------------------------------------------------------

export type FlowNode = { id: string; label: string; color: string };
export type FlowLink = { source: string; target: string; value: number };
type N = SankeyNode<FlowNode, FlowLink>;
type L = SankeyLink<FlowNode, FlowLink>;

export function FlowSankey({ nodes, links, height = 290, unit = "workflow" }: {
  nodes: FlowNode[]; links: FlowLink[]; height?: number; unit?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hoverLink, setHoverLink] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (width < 200 || !links.length) return null;
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    // Band thickness follows volume: a handful of workflows should not fill the whole panel.
    const submitted = links.filter((l) => l.source === links[0].source).reduce((s, l) => s + l.value, 0);
    const inner = Math.min(height - 28, Math.max(90, submitted * 28 + 60));
    const top = (height - inner) / 2;
    const gen = sankey<FlowNode, FlowLink>().nodeId((d) => d.id).nodeWidth(12).nodePadding(22).nodeSort(null)
      .extent([[4, top], [width - 170, top + inner]]);
    return gen({ nodes: nodes.filter((n) => used.has(n.id)).map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
  }, [width, nodes, links, height]);

  const total = layout ? Math.max(...layout.nodes.filter((n) => !n.targetLinks?.length).map((n) => n.value ?? 0), 0) : 0;
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const local = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => { setTip(null); setHoverLink(null); }}>
      {layout && (
        <svg width={width} height={height} role="img" aria-label={`Flow of ${plural(total)} through planning, approval and execution`}>
          <defs>
            <filter id="flow-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <g fill="none">
            {(layout.links as L[]).map((link, i) => {
              const target = link.target as N;
              const source = link.source as N;
              return (
                <path key={i} d={sankeyLinkHorizontal()(link) ?? ""} stroke={target.color}
                  strokeOpacity={hoverLink === null ? 0.32 : hoverLink === i ? 0.7 : 0.12}
                  strokeWidth={Math.max(1.5, link.width ?? 1)} style={{ transition: "stroke-opacity 120ms" }}
                  onMouseMove={(e) => {
                    setHoverLink(i);
                    setTip({ ...local(e), lines: [`${source.label} → ${target.label}`, `${plural(link.value)} · ${Math.round((link.value / (total || 1)) * 100)}% of submitted`] });
                  }} />
              );
            })}
          </g>
          {(layout.nodes as N[]).map((node) => {
            const h = Math.max(2, (node.y1 ?? 0) - (node.y0 ?? 0));
            return (
              <g key={node.id} onMouseMove={(e) => setTip({ ...local(e), lines: [node.label, plural(node.value ?? 0)] })}>
                <rect x={node.x0} y={node.y0} width={(node.x1 ?? 0) - (node.x0 ?? 0)} height={h} rx={4} fill={node.color} filter="url(#flow-glow)" />
                <text x={(node.x1 ?? 0) + 8} y={(node.y0 ?? 0) + h / 2} dy="0.35em" className="fill-ink text-[12px]"
                  style={{ paintOrder: "stroke", stroke: "rgba(13,15,26,0.75)", strokeWidth: 3, strokeLinejoin: "round" }}>
                  {node.label}
                  <tspan className="fill-ink-3" dx={6}>{node.value} · {Math.round(((node.value ?? 0) / (total || 1)) * 100)}%</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

// --- Daily usage bars ------------------------------------------------------------------------------

export type UsageDay = { date: string; tokens: number; cost: number | null; runs: number };

export function UsageBars({ days, height = 170 }: { days: UsageDay[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 40, r: 6, t: 8, b: 22 };
  const max = Math.max(...days.map((d) => d.tokens), 1);
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const step = days.length ? iw / days.length : 0;
  const barW = Math.max(2, Math.min(22, step - 4));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const label = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Agent execution tokens per day">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={width - pad.r} y1={y(top * f)} y2={y(top * f)} stroke="#2c2c2a" strokeWidth={1} />
              <text x={pad.l - 6} y={y(top * f)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[10px] tabular">{compact(top * f)}</text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = pad.l + i * step + (step - barW) / 2;
            const h = Math.max(d.tokens ? 2 : 0, pad.t + ih - y(d.tokens));
            const r = Math.min(4, barW / 2, h);
            const yy = pad.t + ih - h;
            const path = h ? `M${x},${pad.t + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${pad.t + ih} Z` : "";
            return (
              <g key={d.date} onMouseEnter={() => setHover(i)}>
                <rect x={pad.l + i * step} y={pad.t} width={step} height={ih} fill="transparent" />
                {path && <path d={path} fill={VIZ.blue} opacity={hover === null || hover === i ? 1 : 0.45} />}
              </g>
            );
          })}
          {days.length > 0 && [0, Math.floor((days.length - 1) / 2), days.length - 1].map((i) => (
            <text key={i} x={pad.l + i * step + step / 2} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[10px]">{label(days[i].date)}</text>
          ))}
        </svg>
      )}
      {hover !== null && days[hover] && (
        <Tooltip tip={{ x: Math.min(pad.l + hover * step, width - 150), y: 0, lines: [
          label(days[hover].date), `${compact(days[hover].tokens)} tokens · ${days[hover].runs} execution(s)`,
          days[hover].cost != null ? `${usd(days[hover].cost)} reported cost` : "cost not reported by provider",
        ] }} />
      )}
    </div>
  );
}

// --- Execution strip (recent outcomes) --------------------------------------------------------------

const OUTCOME_COLOR: Record<string, string> = {
  succeeded: VIZ.good, failed: VIZ.bad, timed_out: VIZ.bad, cancelled: VIZ.muted, abandoned: VIZ.warn,
  running: VIZ.blue, verifying: VIZ.blue,
};

export function OutcomeStrip({ statuses }: { statuses: string[] }) {
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label={`Recent executions: ${statuses.join(", ") || "none"}`}>
      {statuses.map((s, i) => (
        <span key={i} title={s.replace("_", " ")} className="h-4 w-1.5 rounded-sm" style={{ background: OUTCOME_COLOR[s] ?? VIZ.muted }} />
      ))}
      {!statuses.length && <span className="text-[11px] text-ink-3">no runs yet</span>}
    </div>
  );
}
