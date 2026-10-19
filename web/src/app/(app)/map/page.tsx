"use client";

import { Background, BackgroundVariant, Controls, type Edge, MarkerType, ReactFlow } from "@xyflow/react";
import { Bot, Building2, FolderTree, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  type AgentNodeData, type DeptNodeData, hierarchyEdges, type NodeStatus, nodeTypes, ORG_NODE_ID, type OrgFlowNode, tile,
  treeLayout, useFlowNodes,
} from "@/components/org-graph";
import { useApp } from "@/components/providers";
import { Badge, Banner, Card, EmptyState, PageHeader, Spinner, StatusBadge, Toggle } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { list, obj, str } from "@/lib/spec-md";
import { supabase } from "@/lib/supabase";

const WEEK = 7 * 86_400_000;
const ACTIVE = ["running", "verifying"];

async function loadMap(orgId: string) {
  const since = new Date(Date.now() - WEEK).toISOString();
  const [depts, agents, tasks, handoffs, executions] = await Promise.all([
    supabase.from("departments").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
    supabase.from("agents").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
    supabase.from("tasks").select("id, title, status, agent_id, workflow_id, updated_at, completed_at").eq("org_id", orgId)
      .or(`updated_at.gte.${since},status.in.(queued,running,verifying)`).limit(2000).then(unwrap),
    supabase.from("execution_events").select("data, created_at").eq("org_id", orgId).eq("type", "handoff")
      .gte("created_at", since).limit(1000).then(unwrap),
    supabase.from("agent_executions").select("id, agent_id, status, started_at, workflow_id").eq("org_id", orgId)
      .gte("started_at", since).order("started_at", { ascending: false }).limit(500).then(unwrap),
  ]);
  const ids = agents.map((a) => a.active_version_id).filter((v): v is string => !!v);
  const versions = ids.length ? await supabase.from("agent_versions").select("id, spec, version").in("id", ids).then(unwrap) : [];
  return { depts, agents, tasks, handoffs, executions, versions };
}

function buildView(data: Awaited<ReturnType<typeof loadMap>>, now: number, orgName: string) {
  const cutoff = now - WEEK;
  const versions = new Map(data.versions.map((v) => [v.id, v]));
  const groups = data.depts.map((d) => ({ id: `d:${d.id}`, dept: d, agents: data.agents.filter((a) => a.department_id === d.id).map((a) => `a:${a.id}`) }));
  const agentInfo = new Map(data.agents.map((a) => {
    const mine = data.tasks.filter((t) => t.agent_id === a.id);
    const active = mine.filter((t) => ACTIVE.includes(t.status));
    const recent = mine.filter((t) => t.completed_at && new Date(t.completed_at).getTime() >= cutoff);
    const spec = obj(a.active_version_id ? versions.get(a.active_version_id)?.spec : undefined);
    return [a.id, {
      agent: a, spec, active, queued: mine.filter((t) => t.status === "queued").length,
      completed: recent.filter((t) => t.status === "completed").length, failed: recent.filter((t) => t.status === "failed").length,
      version: a.active_version_id ? versions.get(a.active_version_id)?.version : undefined,
      executions: data.executions.filter((e) => e.agent_id === a.id).slice(0, 6),
    }];
  }));

  // Handoffs: only what the scheduler actually recorded (handoff events), aggregated per agent pair.
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const ev of data.handoffs) {
    const d = obj(ev.data);
    const to = str(d.to_agent);
    for (const from of list(d.from_agents)) {
      if (!from || !to || from === to || !agentInfo.has(from) || !agentInfo.has(to)) continue;
      const k = `${from}>${to}`;
      pairs.set(k, { from, to, count: (pairs.get(k)?.count ?? 0) + 1 });
    }
  }

  const pos = treeLayout(groups, 150);
  const nodes: OrgFlowNode[] = [{
    id: ORG_NODE_ID, type: "org", position: pos[ORG_NODE_ID],
    data: { name: orgName, subtitle: `${data.depts.length} departments · ${data.agents.length} agents` },
  }];
  groups.forEach((g, gi) => {
    const working = g.agents.filter((id) => (agentInfo.get(id.slice(2))?.active.length ?? 0) > 0).length;
    nodes.push({ id: g.id, type: "dept", position: pos[g.id], data: {
      name: g.dept.name, subtitle: `${g.agents.length} agent(s)`, color: gi,
      status: working ? { tone: "accent", text: `${working} agent(s) working`, pulse: true } : { tone: "neutral", text: "Idle" },
    } satisfies DeptNodeData });
    for (const id of g.agents) {
      const info = agentInfo.get(id.slice(2))!;
      const status: NodeStatus = info.agent.status !== "active" ? { tone: "neutral", text: info.agent.status === "disabled" ? "Disabled" : "Draft" }
        : info.active.length ? { tone: "accent", text: `Working · ${info.active[0].status}`, pulse: true }
        : info.queued ? { tone: "info", text: `${info.queued} queued` } : { tone: "neutral", text: "Idle" };
      nodes.push({ id, type: "agent", position: pos[id], data: {
        name: info.agent.name, role: info.agent.role, color: gi, status,
        detail: info.active.length ? `▶ ${info.active[0].title}` : "No current assignment",
        meta: `7d: ${info.completed} completed · ${info.failed} failed`,
      } satisfies AgentNodeData });
    }
  });

  const handoffEdges: Edge[] = [...pairs.values()].map((p) => ({
    id: `h:${p.from}>${p.to}`, source: `a:${p.from}`, sourceHandle: "h-out", target: `a:${p.to}`, targetHandle: "h-in",
    type: "default", animated: true, selectable: false,
    style: { stroke: "#7c6cff", strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: "#7c6cff" },
    label: `${p.count} handoff${p.count === 1 ? "" : "s"}`,
    labelStyle: { fill: "#c3bbff", fontSize: 11 }, labelBgStyle: { fill: "#1f1f1f" }, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6,
  }));
  return { nodes, groups, agentInfo, hierarchy: hierarchyEdges(groups), handoffEdges };
}

type View = ReturnType<typeof buildView>;

export default function MapPage() {
  const { org } = useApp();
  const orgId = org?.id;
  const now = useNow(60_000);
  const [showHandoffs, setShowHandoffs] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, error, loading } = useLive(() => (orgId ? loadMap(orgId) : Promise.resolve(null)), [orgId],
    { orgId, tables: ["agents", "tasks", "execution_events"] });

  const view = useMemo(() => (data ? buildView(data, now, org?.name ?? "Organization") : null), [data, now, org?.name]);

  const { nodes, onNodesChange } = useFlowNodes(view?.nodes ?? [], selected);
  const edges = useMemo(() => view ? [...view.hierarchy, ...(showHandoffs ? view.handoffEdges : [])] : [], [view, showHandoffs]);

  if (!org) return null;

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader title="Organization Map"
        subtitle={<>Live hierarchy of <span className="text-ink">{org.name}</span>: departments, agents, current assignments and recorded task handoffs.</>}
        actions={<>
          <label className="flex items-center gap-2 text-xs text-ink-2">Show handoffs <Toggle label="Show handoffs" checked={showHandoffs} onChange={setShowHandoffs} /></label>
          <Link href="/builder" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-panel-2 px-4 text-sm hover:bg-panel-3">
            <Pencil className="size-4" /> Edit structure
          </Link>
        </>} />
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1"><span className="h-px w-4 bg-ink-3" /> Reporting line</span>
        <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1"><span className="h-0.5 w-4 bg-accent" /> Handoff (last 7 days)</span>
        <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1"><span className="size-1.5 animate-pulse rounded-full bg-accent" /> Working now</span>
        {view && !view.handoffEdges.length && <span className="text-ink-3">No handoffs recorded in the last 7 days. They appear when a task&apos;s output is passed to a dependent task.</span>}
      </div>

      <Card className="flex h-[calc(100vh-15rem)] min-h-[480px] overflow-hidden p-0">
        <div className="dot-grid relative min-w-0 flex-1">
          {loading && !view ? <div className="grid h-full place-items-center"><Spinner className="size-6" /></div>
            : view && !data?.agents.length ? <EmptyState className="h-full" icon={<Bot className="size-5" />} title="No agents yet"
                description="Add departments and agents in the Builder." action={<Link href="/builder" className="text-sm text-[#a99fff] hover:underline">Open Builder →</Link>} />
            : (
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
                onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)}
                fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.3} maxZoom={1.6} nodesConnectable={false} edgesFocusable={false}
                deleteKeyCode={null}>
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.08)" />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            )}
        </div>
        {selected && view && <SidePanel id={selected} view={view} orgName={org.name} orgDescription={org.description} now={now} onSelect={setSelected} onClose={() => setSelected(null)} />}
      </Card>
    </div>
  );
}

function SidePanel({ id, view, orgName, orgDescription, now, onSelect, onClose }: {
  id: string; view: View; orgName: string; orgDescription: string; now: number; onSelect: (id: string) => void; onClose: () => void;
}) {
  const header = (icon: React.ReactNode, title: string, subtitle: string) => (
    <div className="sticky top-0 flex items-center gap-3 border-b border-line bg-panel px-4 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        <div className="truncate text-[11px] text-ink-3">{subtitle}</div>
      </div>
      <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-white/5 hover:text-ink" aria-label="Close"><X className="size-4" /></button>
    </div>
  );
  const section = (title: string, children: React.ReactNode) => (
    <div><div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</div>{children}</div>
  );

  let body: React.ReactNode = null;
  if (id === ORG_NODE_ID) {
    body = <>
      {header(<div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white"><Building2 className="size-4" /></div>, orgName, "Organization")}
      <div className="space-y-4 p-4">
        <p className="text-sm text-ink-2">{orgDescription || "No description."}</p>
        {section("Departments", <div className="space-y-1">{view.groups.map((g) => (
          <button key={g.id} onClick={() => onSelect(g.id)} className="flex w-full justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5">
            {g.dept.name}<span className="text-xs text-ink-3">{g.agents.length} agent(s)</span>
          </button>))}</div>)}
      </div>
    </>;
  } else if (id.startsWith("d:")) {
    const gi = view.groups.findIndex((g) => g.id === id);
    const g = view.groups[gi];
    if (g) body = <>
      {header(<div className="grid size-8 place-items-center rounded-lg text-white" style={{ background: tile(gi) }}><FolderTree className="size-4" /></div>, g.dept.name, `Department · ${g.dept.slug}`)}
      <div className="space-y-4 p-4">
        <p className="text-sm text-ink-2">{g.dept.description || "No description."}</p>
        {section("Agents", <div className="space-y-1">{g.agents.map((aid) => {
          const info = view.agentInfo.get(aid.slice(2));
          return info && (
            <button key={aid} onClick={() => onSelect(aid)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5">
              <span className="truncate">{info.agent.name}</span>
              {info.active.length ? <Badge tone="accent" dot pulse>Working</Badge> : <StatusBadge status={info.agent.status} />}
            </button>
          );
        })}{!g.agents.length && <p className="text-xs text-ink-3">No agents in this department.</p>}</div>)}
      </div>
    </>;
  } else if (id.startsWith("a:")) {
    const info = view.agentInfo.get(id.slice(2));
    const gi = view.groups.findIndex((g) => g.agents.includes(id));
    if (info) body = <>
      {header(<div className="grid size-8 place-items-center rounded-lg text-white" style={{ background: tile(gi) }}><Bot className="size-4" /></div>,
        info.agent.name, `${info.agent.role}${info.version ? ` · v${info.version}` : ""}`)}
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={info.agent.status} />
          {info.active.length > 0 && <Badge tone="accent" dot pulse>Working</Badge>}
          <Badge>7d: {info.completed} completed</Badge>
          {info.failed > 0 && <Badge tone="bad">{info.failed} failed</Badge>}
        </div>
        {section("Mission", <p className="text-sm text-ink-2">{str(info.spec.mission, "—")}</p>)}
        {section("Responsibilities", <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink-2">{list(info.spec.responsibilities).map((r) => <li key={r}>{r}</li>)}</ul>)}
        {section("Requested tools", <div className="flex flex-wrap gap-1.5">{list(info.spec.allowed_tools).map((t) => <Badge key={t} tone="accent">{t}</Badge>)}
          {!list(info.spec.allowed_tools).length && <span className="text-xs text-ink-3">none</span>}</div>)}
        {section("Current assignments", info.active.length ? <div className="space-y-1">{info.active.map((t) => (
          <Link key={t.id} href={`/tasks/${t.workflow_id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
            <span className="truncate">{t.title}</span><StatusBadge status={t.status} />
          </Link>))}</div> : <p className="text-xs text-ink-3">No current assignment{info.queued ? ` · ${info.queued} queued` : ""}.</p>)}
        {section("Recent executions", info.executions.length ? <div className="space-y-1">{info.executions.map((e) => (
          <Link key={e.id} href={`/tasks/${e.workflow_id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
            <StatusBadge status={e.status} /><span className="text-xs text-ink-3">{timeAgo(e.started_at, now)}</span>
          </Link>))}</div> : <p className="text-xs text-ink-3">No executions in the last 7 days.</p>)}
        <Link href={`/agents/${info.agent.id}`} className="inline-block text-sm text-[#a99fff] hover:underline">Open agent →</Link>
      </div>
    </>;
  }

  return <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-line bg-panel">{body}</aside>;
}
