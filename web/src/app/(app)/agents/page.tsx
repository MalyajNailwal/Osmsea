"use client";

import { Bot, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { OutcomeStrip } from "@/components/charts";
import { useApp } from "@/components/providers";
import { Badge, Banner, Card, EmptyState, Input, PageHeader, Skeleton, StatusBadge } from "@/components/ui";
import type { AgentSpec, OrgSettings } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

const DAY = 86_400_000;

export default function AgentsPage() {
  const { org, catalog, status } = useApp();
  const now = useNow();
  const [q, setQ] = useState("");
  const orgId = org?.id;

  const { data, loading, error } = useLive(async () => {
    if (!orgId) return null;
    const since = new Date(Date.now() - 14 * DAY).toISOString();
    const [agents, departments, executions] = await Promise.all([
      supabase.from("agents").select("*").eq("org_id", orgId).order("name").then(unwrap),
      supabase.from("departments").select("id, name").eq("org_id", orgId).then(unwrap),
      supabase.from("agent_executions").select("agent_id, status, started_at").eq("org_id", orgId)
        .gte("started_at", since).order("started_at", { ascending: false }).limit(2000).then(unwrap),
    ]);
    const versionIds = agents.map((a) => a.active_version_id).filter((v): v is string => !!v);
    const versions = versionIds.length
      ? await supabase.from("agent_versions").select("id, version, spec").in("id", versionIds).then(unwrap)
      : [];
    return { agents, departments, executions, versions };
  }, [orgId], { orgId, tables: ["agents", "agent_executions"] });

  const rows = useMemo(() => {
    if (!data) return [];
    const settings = (org?.settings ?? {}) as Partial<OrgSettings>;
    const providers = new Set(status?.providers ?? []);
    return data.agents.map((a) => {
      const version = data.versions.find((v) => v.id === a.active_version_id);
      const spec = version?.spec as AgentSpec | undefined;
      // Display mirror of registry.effective_tools (spec ∩ policy ∩ integrations); the backend enforces it.
      const tools = (spec?.allowed_tools ?? []).filter((t) => {
        const needs = catalog?.tools.find((c) => c.name === t)?.integrations ?? [];
        return settings.tool_policy?.[t]?.enabled !== false && (!needs.length || needs.some((p) => providers.has(p)));
      });
      const runs = data.executions.filter((e) => e.agent_id === a.id);
      const finished = runs.filter((e) => ["succeeded", "failed", "timed_out"].includes(e.status));
      return {
        ...a, version: version?.version, tools, requested: spec?.allowed_tools.length ?? 0,
        department: data.departments.find((d) => d.id === a.department_id)?.name ?? "—",
        runs: runs.length, rate: finished.length ? finished.filter((e) => e.status === "succeeded").length / finished.length : null,
        statuses: runs.slice(0, 12).map((e) => e.status).reverse(), last: runs[0]?.started_at ?? null,
      };
    });
  }, [data, org?.settings, status?.providers, catalog]);

  const term = q.trim().toLowerCase();
  const visible = rows.filter((r) => !term || [r.name, r.role, r.department, r.slug].some((s) => s.toLowerCase().includes(term)));

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader eyebrow="Agents / Inventory" title="Agents"
        subtitle="Every agent in this organization, its validated specification version, effective tools and recent verified results."
        actions={
          <div className="relative w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input className="pl-9" placeholder="Search agents…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        } />
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                <th className="px-5 py-3">Agent</th>
                <th className="px-3 py-3">Department</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Version</th>
                <th className="px-3 py-3">Effective tools</th>
                <th className="px-3 py-3">Executions (14d)</th>
                <th className="px-5 py-3">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading && !data && Array.from({ length: 3 }, (_, i) => (
                <tr key={i}><td colSpan={7} className="px-5 py-3"><Skeleton className="h-9" /></td></tr>
              ))}
              {visible.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.02]">
                  <td className="px-5 py-3">
                    <Link href={`/agents/${r.id}`} className="flex items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ok/25 bg-ok/10 text-ok"><Bot className="size-4" /></span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink hover:underline">{r.name}</span>
                        <span className="block truncate text-[11px] text-ink-3">{r.role}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-ink-2">{r.department}</td>
                  <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-3">{r.version ? <Badge>v{r.version}</Badge> : <Badge tone="bad">no version</Badge>}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.tools.map((t) => <span key={t} className="rounded-md bg-white/6 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{t}</span>)}
                      {!r.tools.length && <span className="text-[11px] text-ink-3">none</span>}
                      {r.requested > r.tools.length && (
                        <span className="text-[11px] text-warn" title="Some requested tools are disabled or missing an integration">
                          +{r.requested - r.tools.length} unavailable
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      <OutcomeStrip statuses={r.statuses} />
                      <span className="text-[11px] text-ink-3 tabular">
                        {r.runs} run{r.runs === 1 ? "" : "s"}{r.rate != null && ` · ${Math.round(r.rate * 100)}% verified`}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[12px] text-ink-3">{timeAgo(r.last, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !visible.length && (
          <EmptyState icon={<Bot className="size-5" />} title={term ? "No agents match your search" : "No agents yet"}
            description={term ? undefined : "Add agents in the Org Builder."} />
        )}
      </Card>
    </div>
  );
}
