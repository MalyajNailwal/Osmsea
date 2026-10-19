"use client";

import { Background, BackgroundVariant, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow,
  ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { duration } from "@/lib/format";
import type { Task } from "@/lib/supabase";
import { cx } from "./ui";

const HEADER: Record<string, string> = {
  completed: "bg-[#0f3b2a] text-ok", failed: "bg-[#3d1717] text-bad", blocked: "bg-[#3a2b0c] text-warn",
  running: "bg-[#24205a] text-[#b4abff]", verifying: "bg-[#24205a] text-[#b4abff]", queued: "bg-[#13284a] text-info",
  cancelled: "bg-white/5 text-ink-3", pending: "bg-white/5 text-ink-2", awaiting_approval: "bg-[#3a2b0c] text-warn",
};
const BORDER: Record<string, string> = {
  completed: "border-ok/30", failed: "border-bad/40", blocked: "border-warn/30", running: "border-accent/60",
  verifying: "border-accent/60", queued: "border-info/30",
};

type StepData = { index: number; task: Task; selected: boolean };

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const { task, index, selected } = data;
  const active = task.status === "running" || task.status === "verifying";
  return (
    <div className={cx("w-[210px] overflow-hidden rounded-lg border bg-[#232323] text-left shadow-lg transition-shadow",
      BORDER[task.status] ?? "border-line-strong", selected && "ring-2 ring-accent/70", active && "glow-accent")}>
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-ink-3" />
      <div className={cx("flex items-center justify-between px-2.5 py-1 text-[10.5px] font-medium", HEADER[task.status] ?? "bg-white/5 text-ink-2")}>
        <span>{index} · {task.status.replace("_", " ")}</span>
        <span className="font-mono text-[10px] opacity-80">{task.agent_slug}</span>
      </div>
      <div className="px-2.5 py-2">
        <div className="line-clamp-2 text-[12.5px] font-medium text-ink">{task.title}</div>
        <div className="mt-1 text-[10.5px] text-ink-3">
          {task.started_at ? duration(task.started_at, task.completed_at) : "not started"}
          {task.attempt > 1 && ` · attempt ${task.attempt}`}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-ink-3" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

/** Layered DAG layout: column = longest dependency chain to the task, row = order within the column. */
function layout(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (t: Task, seen = new Set<string>()): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0; // validated plans are acyclic; guard anyway
    seen.add(t.id);
    const d = Math.max(-1, ...t.depends_on.map((id) => (byId.get(id) ? visit(byId.get(id)!, seen) : -1))) + 1;
    depth.set(t.id, d);
    return d;
  };
  tasks.forEach((t) => visit(t));
  const rows = new Map<number, number>();
  return tasks.map((t) => {
    const col = depth.get(t.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { id: t.id, x: col * 260, y: row * 112 };
  });
}

export function PlanDag({ tasks, selectedId, onSelect, height = 300 }: {
  tasks: Task[]; selectedId?: string | null; onSelect?: (id: string) => void; height?: number;
}) {
  const { nodes, edges } = useMemo(() => {
    const pos = new Map(layout(tasks).map((p) => [p.id, p]));
    const nodes: Node<StepData>[] = tasks.map((t, i) => ({
      id: t.id, type: "step", position: { x: pos.get(t.id)!.x, y: pos.get(t.id)!.y },
      data: { index: i + 1, task: t, selected: t.id === selectedId }, draggable: false,
    }));
    const status = new Map(tasks.map((t) => [t.id, t.status]));
    const edges: Edge[] = tasks.flatMap((t) => t.depends_on.filter((d) => status.has(d)).map((d) => ({
      id: `${d}-${t.id}`, source: d, target: t.id, type: "smoothstep",
      animated: t.status === "running" || t.status === "verifying" || t.status === "queued",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#808080" },
      style: { stroke: status.get(d) === "completed" ? "rgba(52,211,153,0.55)" : status.get(d) === "failed" ? "rgba(248,113,113,0.6)" : "rgba(165,171,196,0.4)" },
    })));
    return { nodes, edges };
  }, [tasks, selectedId]);

  return (
    <div style={{ height }} className="w-full">
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          nodesConnectable={false} elementsSelectable onNodeClick={(_, n) => onSelect?.(n.id)}
          minZoom={0.3} maxZoom={1.6}>
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.08)" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
