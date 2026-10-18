"use client";

import { ListChecks, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { GoalComposer } from "@/components/goal-composer";
import { useApp } from "@/components/providers";
import { Banner, Button, Card, EmptyState, Input, PageHeader, Skeleton, StatusBadge, Tabs } from "@/components/ui";
import { compact, duration, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

type View = "all" | "approvals" | "active" | "completed" | "failed";
const ACTIVE = ["planning", "running"];
const FAILED = ["failed", "plan_failed", "cancelled", "rejected"];

export default function TasksPage() {
  const { org, can } = useApp();
  const now = useNow(10_000);
  // Pages render only on the client (the shell waits for the session), so reading the URL here is safe.
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    return v === "approvals" || v === "active" || v === "completed" || v === "failed" ? v : "all";
  });
  const [q, setQ] = useState("");
  const [composer, setComposer] = useState(false);
  const orgId = org?.id;

  const { data, loading, error } = useLive(async () => {
    if (!orgId) return null;
    const workflows = await supabase.from("workflows").select("*").eq("org_id", orgId)
      .order("created_at", { ascending: false }).limit(200).then(unwrap);
    const ids = workflows.map((w) => w.id);
    const tasks = ids.length
      ? await supabase.from("tasks").select("workflow_id, status, agent_slug").in("workflow_id", ids).then(unwrap)
      : [];
    return { workflows, tasks };
  }, [orgId], { orgId, tables: ["workflows", "tasks"] });

  const rows = useMemo(() => {
    if (!data) return [];
    return data.workflows.map((w) => {
      const tasks = data.tasks.filter((t) => t.workflow_id === w.id);
      return { ...w, total: tasks.length, done: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length, agents: [...new Set(tasks.map((t) => t.agent_slug))] };
    });
  }, [data]);

  const counts = {
    all: rows.length,
    approvals: rows.filter((r) => r.status === "awaiting_approval").length,
    active: rows.filter((r) => ACTIVE.includes(r.status)).length,
    completed: rows.filter((r) => r.status === "completed").length,
    failed: rows.filter((r) => FAILED.includes(r.status)).length,
  };
  const term = q.trim().toLowerCase();
  const visible = rows.filter((r) => (view === "all" || (view === "approvals" && r.status === "awaiting_approval")
    || (view === "active" && ACTIVE.includes(r.status)) || (view === "completed" && r.status === "completed")
    || (view === "failed" && FAILED.includes(r.status))) && (!term || r.goal.toLowerCase().includes(term)));

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Tasks & Execution Center"
        subtitle="Every goal, its plan, approvals, execution and verified results."
        actions={<Button variant="primary" icon={<Sparkles className="size-4" />} disabled={!can("member")} onClick={() => setComposer(true)}>New goal</Button>} />
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-2">
          <Tabs value={view} onChange={setView} className="border-0" tabs={[
            { id: "all", label: "All", count: counts.all }, { id: "approvals", label: "Awaiting approval", count: counts.approvals },
            { id: "active", label: "Active", count: counts.active }, { id: "completed", label: "Completed", count: counts.completed },
            { id: "failed", label: "Failed / stopped", count: counts.failed },
          ]} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by goal…" className="max-w-xs" />
        </div>
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-5 py-3 font-medium">Goal</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Progress</th>
                <th className="px-3 py-3 font-medium">Agents</th>
                <th className="px-3 py-3 font-medium">Tokens · cost</th>
                <th className="px-3 py-3 font-medium">Duration</th>
                <th className="px-5 py-3 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading && !data && Array.from({ length: 4 }, (_, i) => (
                <tr key={i}><td colSpan={7} className="px-5 py-3"><Skeleton className="h-6" /></td></tr>
              ))}
              {visible.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.02]">
                  <td className="max-w-md px-5 py-3">
                    <Link href={`/tasks/${r.id}`} className="line-clamp-2 font-medium text-ink hover:underline">{r.goal}</Link>
                    {r.error && FAILED.includes(r.status) && <div className="mt-0.5 line-clamp-1 text-[11px] text-bad/90">{r.error}</div>}
                  </td>
                  <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-3">
                    {r.total ? (
                      <div className="w-32">
                        <div className="flex h-1.5 overflow-hidden rounded-full bg-white/8">
                          <div className="bg-ok" style={{ width: `${(r.done / r.total) * 100}%` }} />
                          <div className="bg-bad" style={{ width: `${(r.failed / r.total) * 100}%` }} />
                        </div>
                        <div className="mt-1 text-[11px] text-ink-3">{r.done}/{r.total} verified{r.failed ? ` · ${r.failed} failed` : ""}</div>
                      </div>
                    ) : <span className="text-[11px] text-ink-3">—</span>}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">{r.agents.map((a) => <span key={a} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{a}</span>)}</div>
                  </td>
                  <td className="px-3 py-3 tabular text-ink-2">{compact(r.tokens_used)} · {usd(Number(r.cost_usd))}</td>
                  <td className="px-3 py-3 tabular text-ink-2">{r.started_at ? duration(r.started_at, r.completed_at, now) : "—"}</td>
                  <td className="px-5 py-3 text-ink-3">{timeAgo(r.created_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !visible.length && (
            <EmptyState icon={<ListChecks className="size-5" />} title={rows.length ? "Nothing in this view" : "No workflows yet"}
              description={rows.length ? "Try another filter." : "Submit a goal; the planner proposes tasks for your agents."}
              action={!rows.length && can("member") ? <Button variant="primary" onClick={() => setComposer(true)}>Submit a goal</Button> : undefined} />
          )}
        </div>
      </Card>
      <GoalComposer open={composer} onClose={() => setComposer(false)} />
    </div>
  );
}
