"use client";

import {
  Activity, AlertTriangle, ArrowRight, CheckCircle2, CircleDollarSign, Info, ShieldCheck, Sparkles, Users, XCircle, Zap,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { FlowSankey, type FlowLink, type FlowNode, OutcomeStrip, UsageBars, VIZ } from "@/components/charts";
import { GoalComposer } from "@/components/goal-composer";
import { useApp } from "@/components/providers";
import { Badge, Banner, Button, Card, CardHeader, EmptyState, Segmented, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { compact, pct, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type Workflow, supabase } from "@/lib/supabase";

const DAY = 86_400_000;

function flowFor(workflows: Workflow[]): { nodes: FlowNode[]; links: FlowLink[] } {
  const nodes: FlowNode[] = [
    { id: "submitted", label: "Submitted", color: "#7c6cff" },
    { id: "planning", label: "Planning", color: VIZ.blue },
    { id: "plan_failed", label: "Plan failed", color: VIZ.bad },
    { id: "cancel0", label: "Cancelled", color: VIZ.muted },
    { id: "planned", label: "Planned", color: "#7c6cff" },
    { id: "awaiting", label: "Awaiting approval", color: VIZ.warn },
    { id: "rejected", label: "Rejected", color: VIZ.muted },
    { id: "cancel1", label: "Cancelled", color: VIZ.muted },
    { id: "executing", label: "Approved & executing", color: "#7c6cff" },
    { id: "running", label: "Running", color: VIZ.blue },
    { id: "completed", label: "Completed", color: VIZ.good },
    { id: "failed", label: "Failed", color: VIZ.bad },
    { id: "cancel2", label: "Cancelled", color: VIZ.muted },
  ];
  const paths: string[][] = workflows.map((w) => {
    switch (w.status) {
      case "planning": return ["submitted", "planning"];
      case "plan_failed": return ["submitted", "plan_failed"];
      case "awaiting_approval": return ["submitted", "planned", "awaiting"];
      case "rejected": return ["submitted", "planned", "rejected"];
      case "running": return ["submitted", "planned", "executing", "running"];
      case "completed": return ["submitted", "planned", "executing", "completed"];
      case "failed": return ["submitted", "planned", "executing", "failed"];
      case "cancelled":
        return !w.plan ? ["submitted", "cancel0"] : !w.started_at ? ["submitted", "planned", "cancel1"] : ["submitted", "planned", "executing", "cancel2"];
      default: return ["submitted"];
    }
  });
  const counts = new Map<string, number>();
  for (const p of paths) for (let i = 0; i < p.length - 1; i++) {
    const key = `${p[i]}>${p[i + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { nodes, links: [...counts].map(([k, value]) => { const [source, target] = k.split(">"); return { source, target, value }; }) };
}

export default function CommandCenter() {
  const { org, can, status } = useApp();
  const now = useNow();
  const [composer, setComposer] = useState(false);
  const [range, setRange] = useState<"7" | "30">("30");
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const orgId = org?.id;

  const { data, loading, error } = useLive(async () => {
    if (!orgId) return null;
    const since = new Date(Date.now() - Number(range) * DAY).toISOString();
    const usageSince = new Date(Date.now() - 14 * DAY).toISOString();
    const [workflows, tasks, approvals, executions, events, agents] = await Promise.all([
      supabase.from("workflows").select("*").eq("org_id", orgId).gte("created_at", since).order("created_at", { ascending: false }).limit(500).then(unwrap),
      supabase.from("tasks").select("id, status, agent_id, title, workflow_id, completed_at, updated_at").eq("org_id", orgId)
        .or(`updated_at.gte.${since},status.in.(queued,running,verifying,pending)`).limit(2000).then(unwrap),
      supabase.from("approvals").select("*, workflows(goal, created_by)").eq("org_id", orgId).eq("status", "pending").order("created_at").then(unwrap),
      supabase.from("agent_executions").select("agent_id, status, input_tokens, output_tokens, cost_usd, started_at").eq("org_id", orgId)
        .gte("started_at", usageSince).order("started_at", { ascending: false }).limit(2000).then(unwrap),
      supabase.from("execution_events").select("*").eq("org_id", orgId).order("id", { ascending: false }).limit(14).then(unwrap),
      supabase.from("agents").select("id, name, role, status").eq("org_id", orgId).order("name").then(unwrap),
    ]);
    return { workflows, tasks, approvals, executions, events, agents };
  }, [orgId, range], { orgId, tables: ["workflows", "tasks", "approvals", "agent_executions", "execution_events", "agents"] });

  const view = useMemo(() => {
    if (!data) return null;
    const { workflows, tasks, executions, agents } = data;
    const active = tasks.filter((t) => ["queued", "running", "verifying"].includes(t.status));
    const since = now - Number(range) * DAY;
    const recent = tasks.filter((t) => t.completed_at && new Date(t.completed_at).getTime() >= since);
    const completed = recent.filter((t) => t.status === "completed").length;
    const failed = recent.filter((t) => t.status === "failed").length;
    const spend = workflows.reduce((s, w) => s + Number(w.cost_usd ?? 0), 0);
    const tokens = workflows.reduce((s, w) => s + (w.tokens_used ?? 0), 0);
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now - (13 - i) * DAY);
      return d.toISOString().slice(0, 10);
    });
    const usage = days.map((date) => {
      const rows = executions.filter((e) => e.started_at.slice(0, 10) === date);
      const costs = rows.filter((e) => e.cost_usd != null);
      return { date, runs: rows.length, tokens: rows.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0),
        cost: costs.length ? costs.reduce((s, e) => s + Number(e.cost_usd), 0) : null };
    });
    const health = agents.map((a) => {
      const runs = executions.filter((e) => e.agent_id === a.id);
      const done = runs.filter((e) => ["succeeded", "failed", "timed_out"].includes(e.status));
      const ok = done.filter((e) => e.status === "succeeded").length;
      const busy = tasks.filter((t) => t.agent_id === a.id && ["running", "verifying"].includes(t.status)).length;
      return { ...a, statuses: runs.slice(0, 12).map((e) => e.status).reverse(), rate: done.length ? ok / done.length : null, busy };
    });
    return { active, queued: active.filter((t) => t.status === "queued").length, completed, failed, spend, tokens, usage, health, flow: flowFor(workflows) };
  }, [data, now, range]);

  const decide = async (workflowId: string, approve: boolean) => {
    if (!orgId) return;
    setActing(workflowId);
    setActionError(null);
    try {
      await (approve ? api.approve(orgId, workflowId) : api.reject(orgId, workflowId));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setActing(null);
    }
  };

  if (!org) return null;
  const pending = data?.approvals ?? [];

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight">Agent Organization Command Center</h1>
          <p className="mt-1 text-sm text-ink-2">Monitor plans, approvals, execution, verification and cost for <span className="text-ink">{org.name}</span> in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented options={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }]} value={range} onChange={setRange} />
          <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setComposer(true)} disabled={!can("member")}>
            New goal <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>

      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      {actionError && <Banner tone="bad" className="mb-4">{actionError}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading && !view ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[86px] rounded-2xl" />) : view && <>
          <Stat icon={<Zap className="size-5" />} label="Active tasks" value={view.active.length}
            sub={`${view.queued} queued · ${view.active.length - view.queued} running`} />
          <Stat icon={<CheckCircle2 className="size-5" />} accent="ok" label={`Tasks verified (${range}d)`} value={view.completed}
            sub={`${view.failed} failed · ${pct(view.completed, view.completed + view.failed)} success`} />
          <Stat icon={<ShieldCheck className="size-5" />} accent="warn" label="Pending approvals" value={pending.length}
            sub={pending[0] ? `oldest ${timeAgo(pending[0].created_at, now)}` : "queue is clear"} />
          <Stat icon={<CircleDollarSign className="size-5" />} accent="info" label={`Model spend (${range}d)`} value={usd(view.spend)}
            sub={`${compact(view.tokens)} tokens incl. planning & review`} />
        </>}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader title="Workflow flow" subtitle={`Every goal submitted in the last ${range} days, from planning to verified outcome`}
            actions={<Badge tone="accent" dot pulse>Live</Badge>} />
          <div className="px-4 pb-4">
            {view && view.flow.links.length ? <FlowSankey nodes={view.flow.nodes} links={view.flow.links} /> : loading ? <Skeleton className="h-[290px]" /> : (
              <EmptyState icon={<Activity className="size-5" />} title="No workflows yet" description="Submit a goal to see it move through planning, approval and execution."
                action={<Button variant="primary" onClick={() => setComposer(true)}>Submit a goal</Button>} />
            )}
          </div>
        </Card>

        <Card className="flex flex-col">
          <CardHeader title={<span className="flex items-center gap-2">Approval queue <Badge>{pending.length}</Badge></span>}
            actions={<Link href="/tasks?view=approvals" className="text-xs text-ink-3 hover:text-ink">View all →</Link>} />
          <div className="flex-1 space-y-2 px-4 pb-4">
            {pending.slice(0, 4).map((a) => (
              <div key={a.id} className="rounded-xl border border-line bg-panel-2/60 p-3">
                <Link href={`/tasks/${a.workflow_id}`} className="line-clamp-2 text-sm font-medium text-ink hover:underline">
                  {(a.workflows as { goal?: string } | null)?.goal ?? "Workflow"}
                </Link>
                <div className="mt-1 text-[11px] text-ink-3">{a.summary} · {timeAgo(a.created_at, now)}</div>
                {can("admin") ? (
                  <div className="mt-2.5 flex gap-2">
                    <Button size="sm" variant="success" loading={acting === a.workflow_id} onClick={() => decide(a.workflow_id, true)}>Approve</Button>
                    <Button size="sm" variant="ghost" disabled={acting === a.workflow_id} onClick={() => decide(a.workflow_id, false)}>Reject</Button>
                    <Link href={`/tasks/${a.workflow_id}`} className="ml-auto self-center text-[11px] text-ink-3 hover:text-ink">Review plan →</Link>
                  </div>
                ) : <div className="mt-2 text-[11px] text-ink-3">An admin must approve this plan.</div>}
              </div>
            ))}
            {!pending.length && <EmptyState icon={<ShieldCheck className="size-5" />} title="No plans waiting" description="Plans that need approval appear here." className="py-8" />}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-[1fr_1fr_1.1fr]">
        <Card>
          <CardHeader title="Agent health" subtitle="Last 14 days of executions" icon={<Users className="size-4" />}
            actions={<Link href="/agents" className="text-xs text-ink-3 hover:text-ink">View all →</Link>} />
          <div className="divide-y divide-line px-5 pb-3">
            {view?.health.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="flex items-center gap-3 py-2.5 hover:opacity-90">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{a.name}</div>
                  <div className="truncate text-[11px] text-ink-3">{a.role}</div>
                </div>
                {a.status !== "active" ? <StatusBadge status={a.status} /> : a.busy ? <Badge tone="accent" dot pulse>Working</Badge> :
                  <span className="text-[11px] text-ink-3">{a.rate == null ? "idle" : `${Math.round(a.rate * 100)}% verified`}</span>}
                <OutcomeStrip statuses={a.statuses} />
              </Link>
            ))}
            {view && !view.health.length && <EmptyState title="No agents" className="py-6" />}
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent events" subtitle="Live execution log" icon={<Activity className="size-4" />}
            actions={<Link href="/tasks" className="text-xs text-ink-3 hover:text-ink">View all →</Link>} />
          <div className="max-h-[300px] space-y-1 overflow-y-auto px-4 pb-4">
            {data?.events.map((e) => {
              const Icon = e.level === "error" ? XCircle : e.level === "warning" ? AlertTriangle : Info;
              const color = e.level === "error" ? "text-bad" : e.level === "warning" ? "text-warn" : "text-info";
              return (
                <Link key={e.id} href={e.workflow_id ? `/tasks/${e.workflow_id}` : "/tasks"} className="flex gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[13px] text-ink-2">{e.message}</div>
                    <div className="text-[11px] text-ink-3">{e.type.replaceAll("_", " ")} · {timeAgo(e.created_at, now)}</div>
                  </div>
                </Link>
              );
            })}
            {data && !data.events.length && <EmptyState title="No events yet" description="Execution events stream here in real time." className="py-6" />}
          </div>
        </Card>

        <Card className="lg:col-span-2 2xl:col-span-1">
          <CardHeader title="Resource usage" subtitle="Agent execution tokens per day (14 days)" icon={<CircleDollarSign className="size-4" />}
            actions={<span className="text-[11px] text-ink-3">{status?.llm.configured ? status.llm.model : "no provider"}</span>} />
          <div className="px-4 pb-2">
            {view ? <UsageBars days={view.usage} /> : <Skeleton className="h-[170px]" />}
          </div>
          {view && (
            <div className="grid grid-cols-3 gap-2 border-t border-line px-5 py-3 text-center">
              <div><div className="text-[11px] text-ink-3">Tokens (14d)</div><div className="text-sm font-semibold tabular">{compact(view.usage.reduce((s, d) => s + d.tokens, 0))}</div></div>
              <div><div className="text-[11px] text-ink-3">Executions</div><div className="text-sm font-semibold tabular">{view.usage.reduce((s, d) => s + d.runs, 0)}</div></div>
              <div><div className="text-[11px] text-ink-3">Reported cost</div><div className="text-sm font-semibold tabular">{usd(view.usage.reduce((s, d) => s + (d.cost ?? 0), 0))}</div></div>
            </div>
          )}
        </Card>
      </div>
      <GoalComposer open={composer} onClose={() => setComposer(false)} />
    </div>
  );
}
