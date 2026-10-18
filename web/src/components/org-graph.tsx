"use client";

import { type Edge, Handle, type Node, type NodeChange, type NodeProps, Position, type XYPosition } from "@xyflow/react";
import { Bot, Building2, FolderTree } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { cx } from "./ui";

/** Shared org-chart nodes for the Builder (editable) and the Org Map (live, read-only). */

export type Tone = "ok" | "warn" | "bad" | "neutral" | "accent" | "info";
export type NodeStatus = { tone: Tone; text: string; pulse?: boolean };

export type OrgNodeData = { name: string; subtitle: string };
export type DeptNodeData = { name: string; subtitle: string; color: number; status?: NodeStatus };
export type AgentNodeData = { name: string; role: string; color: number; status: NodeStatus; detail?: string; meta?: string };

export type OrgFlowNode = Node<OrgNodeData, "org"> | Node<DeptNodeData, "dept"> | Node<AgentNodeData, "agent">;

// Decorative identity tiles per department (not data encoding), echoing the reference canvas.
const TILES = [
  "linear-gradient(135deg,#2dd4bf,#0891b2)",
  "linear-gradient(135deg,#60a5fa,#4f46e5)",
  "linear-gradient(135deg,#fb923c,#e11d48)",
  "linear-gradient(135deg,#a78bfa,#7c3aed)",
  "linear-gradient(135deg,#f472b6,#db2777)",
  "linear-gradient(135deg,#facc15,#ea580c)",
];
export const tile = (i: number) => TILES[((i % TILES.length) + TILES.length) % TILES.length];

const TONE: Record<Tone, string> = {
  ok: "text-ok border-ok/25 bg-ok/[0.07]",
  warn: "text-warn border-warn/25 bg-warn/[0.07]",
  bad: "text-bad border-bad/25 bg-bad/[0.07]",
  neutral: "text-ink-3 border-white/10 bg-white/[0.03]",
  accent: "text-[#b4abff] border-accent/30 bg-accent/10",
  info: "text-info border-info/25 bg-info/[0.07]",
};

const hidden = "!h-2 !w-2 !min-w-0 !border-0 !bg-transparent";

function StatusPill({ status }: { status: NodeStatus }) {
  return (
    <div className={cx("mt-1.5 flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px]", TONE[status.tone])}>
      <span className={cx("size-1.5 shrink-0 rounded-full bg-current", status.pulse && "animate-pulse")} />
      <span className="truncate">{status.text}</span>
    </div>
  );
}

function OrgNode({ data, selected }: NodeProps<Node<OrgNodeData, "org">>) {
  return (
    <div className={cx("w-[250px] rounded-xl border bg-[#0f1222] px-3.5 py-3 shadow-lg transition-colors",
      selected ? "border-accent glow-accent" : "border-line-strong")}>
      <div className="flex items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white"><Building2 className="size-[18px]" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">{data.name}</div>
          <div className="truncate text-[11px] text-ink-3">{data.subtitle}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} id="out" className={hidden} isConnectable={false} />
    </div>
  );
}

function DeptNode({ data, selected }: NodeProps<Node<DeptNodeData, "dept">>) {
  return (
    <div className="w-[240px]">
      <div className={cx("rounded-xl border bg-[#0d1020] px-3 py-2.5 shadow-lg transition-colors",
        selected ? "border-accent glow-accent" : "border-line-strong")}>
        <div className="flex items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg text-white" style={{ background: tile(data.color) }}><FolderTree className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-ink">{data.name}</span>
              <span className="rounded border border-white/10 px-1 text-[9px] uppercase tracking-wide text-ink-3">Dept</span>
            </div>
            <div className="truncate text-[11px] text-ink-3">{data.subtitle}</div>
          </div>
        </div>
      </div>
      {data.status && <StatusPill status={data.status} />}
      <Handle type="target" position={Position.Left} id="in" className={hidden} isConnectable={false} style={{ top: 26 }} />
      <Handle type="source" position={Position.Right} id="out" className={hidden} isConnectable={false} style={{ top: 26 }} />
    </div>
  );
}

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData, "agent">>) {
  return (
    <div className="w-[260px]">
      <div className={cx("rounded-xl border bg-[#0d1020] px-3 py-2.5 shadow-lg transition-colors",
        selected ? "border-accent glow-accent" : "border-line-strong")}>
        <div className="flex items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg text-white" style={{ background: tile(data.color) }}><Bot className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-ink">{data.name}</span>
              <span className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1 text-[9px] font-medium text-[#b4abff]">Agent</span>
            </div>
            <div className="truncate text-[11px] text-ink-3">{data.role}</div>
          </div>
        </div>
        {data.detail && <div className="mt-2 truncate border-t border-line pt-1.5 text-[11px] text-ink-2" title={data.detail}>{data.detail}</div>}
        {data.meta && <div className="mt-1 truncate text-[10.5px] text-ink-3">{data.meta}</div>}
      </div>
      <StatusPill status={data.status} />
      <Handle type="target" position={Position.Left} id="in" className={hidden} isConnectable={false} style={{ top: 26 }} />
      <Handle type="source" position={Position.Right} id="h-out" className={hidden} isConnectable={false} style={{ top: 18 }} />
      <Handle type="target" position={Position.Right} id="h-in" className={hidden} isConnectable={false} style={{ top: 38 }} />
    </div>
  );
}

export const nodeTypes = { org: OrgNode, dept: DeptNode, agent: AgentNode };

export const ORG_NODE_ID = "org";

/** Left-to-right tree: org → departments → agents, departments centered on their agents. */
export function treeLayout(depts: { id: string; agents: string[] }[], rowHeight = 112): Record<string, XYPosition> {
  const pos: Record<string, XYPosition> = {};
  let y = 0;
  for (const d of depts) {
    const n = Math.max(1, d.agents.length);
    d.agents.forEach((a, i) => { pos[a] = { x: 620, y: y + i * rowHeight }; });
    pos[d.id] = { x: 320, y: y + ((n - 1) * rowHeight) / 2 };
    y += n * rowHeight + 32;
  }
  pos[ORG_NODE_ID] = { x: 0, y: Math.max(0, (y - 32 - rowHeight) / 2) };
  return pos;
}

export function hierarchyEdges(depts: { id: string; agents: string[] }[]): Edge[] {
  const style = { stroke: "rgba(165,171,196,0.35)", strokeWidth: 1.5 };
  return depts.flatMap((d) => [
    { id: `e-org-${d.id}`, source: ORG_NODE_ID, sourceHandle: "out", target: d.id, targetHandle: "in", type: "smoothstep", style, selectable: false },
    ...d.agents.map((a) => ({ id: `e-${d.id}-${a}`, source: d.id, sourceHandle: "out", target: a, targetHandle: "in", type: "smoothstep", style, selectable: false })),
  ]);
}

/**
 * Derived nodes + the bits xyflow must own (measured size, dragged position). React Flow only knows a
 * controlled node's size if we hand it back, so we cache `dimensions` changes instead of syncing state.
 */
export function useFlowNodes(base: OrgFlowNode[], selectedId: string | null) {
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const [moved, setMoved] = useState<Record<string, XYPosition>>({});
  const nodes = useMemo(
    () => base.map((n) => ({ ...n, position: moved[n.id] ?? n.position, measured: dims[n.id], selected: n.id === selectedId })) as OrgFlowNode[],
    [base, dims, moved, selectedId],
  );
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const d: Record<string, { width: number; height: number }> = {};
    const m: Record<string, XYPosition> = {};
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) d[c.id] = c.dimensions;
      if (c.type === "position" && c.position) m[c.id] = c.position;
    }
    if (Object.keys(d).length) setDims((p) => ({ ...p, ...d }));
    if (Object.keys(m).length) setMoved((p) => ({ ...p, ...m }));
  }, []);
  const resetLayout = useCallback(() => setMoved({}), []);
  return { nodes, onNodesChange, resetLayout };
}
