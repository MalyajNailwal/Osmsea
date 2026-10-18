"use client";

import { Activity, CheckCircle2, Download, RefreshCw, Search, ShieldAlert, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { MembersSection } from "@/components/members";
import { useApp } from "@/components/providers";
import {
  Badge, Banner, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, StatusBadge, Tabs,
  Textarea, Toggle, download,
} from "@/components/ui";
import { api, errorMessage, type OrgSettings } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

type TabId = "audit" | "limits" | "policy" | "members";
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

function countOf(res: { count: number | null; error: { message: string } | null }): number {
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describe(action: string): string {
  const [resource, verb = ""] = action.split(".");
  return verb === "denied" ? `${cap(resource)} denied` : `${cap(verb)} ${resource}`;
}

function operation(action: string, outcome: string): { label: string; tone: Tone } {
  if (outcome === "denied") return { label: "Denied", tone: "warn" };
  const verb = action.split(".").pop() ?? "";
  if (verb === "create") return { label: "Create", tone: "info" };
  if (["update", "configure", "enable", "disable"].includes(verb)) return { label: "Update", tone: "warn" };
  if (["delete", "remove"].includes(verb)) return { label: "Delete", tone: "bad" };
  if (verb === "approve") return { label: "Approve", tone: "ok" };
  return { label: cap(verb), tone: "neutral" };
}

const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

const LIMITS: { key: keyof OrgSettings; label: string; min: number; max: number; hint: string }[] = [
  { key: "max_concurrent_tasks", label: "Max concurrent tasks", min: 1, max: 10, hint: "Tasks this organization may run at the same time." },
  { key: "task_timeout_seconds", label: "Task timeout (seconds)", min: 30, max: 1800, hint: "Upper bound per attempt; an agent spec may set a lower one." },
  { key: "max_attempts", label: "Max attempts per task", min: 1, max: 5, hint: "Retries after errors, timeouts or failed verification." },
  { key: "workflow_token_budget", label: "Token budget per workflow", min: 1000, max: 5_000_000, hint: "Planning, execution and review combined. Exceeding it fails the task." },
  { key: "max_tasks_per_plan", label: "Max tasks per plan", min: 1, max: 20, hint: "Larger plans are rejected during validation." },
];

export default function GovernancePage() {
  const { org, can, catalog, status, reloadOrgs } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const isAdmin = can("admin");
  // Pages render only on the client (the shell waits for the session), so reading the URL here is safe.
  const [tab, setTab] = useState<TabId>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "limits" || t === "policy" || t === "members" ? t : "audit";
  });
  const [q, setQ] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [orgDraft, setOrgDraft] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data, loading, error, reload } = useLive(async () => {
    if (!orgId) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const base = () => supabase.from("audit_events").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    const [rows, total, todayCount, failed, members] = await Promise.all([
      supabase.from("audit_events").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(500).then(unwrap),
      base().then(countOf),
      base().gte("created_at", today.toISOString()).then(countOf),
      base().in("outcome", ["failure", "denied"]).then(countOf),
      supabase.from("organization_members").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
    ]);
    return { rows, total, todayCount, failed, members };
  }, [orgId]);

  const activeUsers = useMemo(() => {
    // ponytail: counted from the latest 500 events; use a SQL count(distinct) RPC if 7-day volume exceeds that.
    const since = now - 7 * 86_400_000;
    return new Set((data?.rows ?? []).filter((r) => r.actor_type === "user" && r.actor_id && new Date(r.created_at).getTime() >= since)
      .map((r) => r.actor_id)).size;
  }, [data, now]);

  const actions = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.action))].sort(), [data]);
  const term = q.trim().toLowerCase();
  const visible = (data?.rows ?? []).filter((r) =>
    (!outcomeFilter || r.outcome === outcomeFilter) && (!actionFilter || r.action === actionFilter)
    && (!term || [r.actor_label, r.action, r.resource_name, r.resource_type].some((s) => (s ?? "").toLowerCase().includes(term))));

  const merged: OrgSettings | null = catalog ? { ...catalog.default_settings, ...((org?.settings ?? {}) as Partial<OrgSettings>) } : null;
  const settings = draft ?? merged;

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      await reloadOrgs();
      setMessage({ tone: "ok", text });
      void reload();
    } catch (e) {
      setMessage({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = () => settings && act("limits", async () => {
    await api.updateSettings(orgId!, settings);
    setDraft(null);
    return "Execution limits saved. They apply to tasks scheduled from now on.";
  });
  const saveOrg = () => orgDraft && act("org", async () => {
    await api.updateOrg(orgId!, orgDraft);
    setOrgDraft(null);
    return "Organization updated.";
  });
  const setPolicy = (tool: string, patch: Partial<{ enabled: boolean; requires_approval: boolean }>) => merged && act(`policy-${tool}`, async () => {
    const current = merged.tool_policy[tool] ?? { enabled: true, requires_approval: false };
    await api.updateSettings(orgId!, { ...merged, tool_policy: { ...merged.tool_policy, [tool]: { ...current, ...patch } } });
    return `Policy for ${tool} updated.`;
  });

  const exportCsv = () => {
    const header = ["time", "actor", "actor_type", "action", "resource_type", "resource_name", "outcome", "details"];
    const lines = visible.map((r) => [r.created_at, r.actor_label, r.actor_type, r.action, r.resource_type, r.resource_name,
      r.outcome, JSON.stringify(r.details)].map(csvCell).join(","));
    download(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, [header.join(","), ...lines].join("\n"), "text/csv");
  };

  if (!org) return null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Governance" subtitle="Audit events, execution limits, tool permissions and members for this organization."
        actions={tab === "audit" && <Button icon={<RefreshCw className="size-4" />} onClick={() => void reload()}>Refresh</Button>} />
      <Tabs className="mb-5" value={tab} onChange={(t) => { setTab(t); setMessage(null); }} tabs={[
        { id: "audit", label: "Audit log", count: data?.total },
        { id: "limits", label: "Execution limits" },
        { id: "policy", label: "Tool policy" },
        { id: "members", label: "Members", count: data?.members.length },
      ]} />
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      {message && <Banner tone={message.tone} className="mb-4">{message.text}</Banner>}

      {tab === "audit" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={<Activity className="size-5" />} label="Total logs" value={data?.total ?? "—"} sub="All time records" />
            <Stat icon={<CheckCircle2 className="size-5" />} accent="ok" label="Today's logs" value={data?.todayCount ?? "—"} sub="Records today" />
            <Stat icon={<ShieldAlert className="size-5" />} accent="bad" label="Failed / denied operations" value={data?.failed ?? "—"} sub="Failures and authorization denials" />
            <Stat icon={<Users className="size-5" />} accent="info" label="Active users" value={data ? activeUsers : "—"} sub="Last 7 days" />
          </div>

          <Card className="mt-4">
            <CardHeader title="Audit logs" subtitle="Configuration changes, approvals and security denials, written by the backend." />
            <div className="flex flex-wrap gap-2 px-5 pb-4">
              <div className="relative min-w-64 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input className="pl-9" placeholder="Search by actor, action or resource name…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Select className="w-44" value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)} aria-label="Filter by outcome">
                <option value="">Filter by outcome</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
                <option value="denied">Denied</option>
              </Select>
              <Select className="w-52" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} aria-label="Filter by action">
                <option value="">Filter by action</option>
                {actions.map((a) => <option key={a} value={a}>{describe(a)}</option>)}
              </Select>
              <Button icon={<Download className="size-4" />} onClick={exportCsv} disabled={!visible.length}>Export CSV</Button>
            </div>
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="px-5 py-3 font-medium">Time</th>
                    <th className="px-3 py-3 font-medium">Actor</th>
                    <th className="px-3 py-3 font-medium">Action</th>
                    <th className="px-3 py-3 font-medium">Resource type</th>
                    <th className="px-3 py-3 font-medium">Resource name</th>
                    <th className="px-3 py-3 font-medium">Operation</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {loading && !data && <tr><td colSpan={7} className="px-5 py-4"><Skeleton className="h-24" /></td></tr>}
                  {visible.map((r) => {
                    const op = operation(r.action, r.outcome);
                    return (
                      <tr key={r.id} className="hover:bg-white/[0.02]" title={Object.keys(r.details ?? {}).length ? JSON.stringify(r.details) : undefined}>
                        <td className="px-5 py-3 whitespace-nowrap text-ink-2 tabular">{dateTime(r.created_at)}</td>
                        <td className="px-3 py-3">
                          <div className="max-w-52 truncate text-ink">{r.actor_label || r.actor_type}</div>
                          {r.actor_type !== "user" && <div className="text-[11px] text-ink-3">{r.actor_type}</div>}
                        </td>
                        <td className="px-3 py-3 text-ink">{describe(r.action)}</td>
                        <td className="px-3 py-3 text-ink-2">{r.resource_type}</td>
                        <td className="px-3 py-3"><div className="max-w-64 truncate text-ink-2">{r.resource_name ?? "—"}</div></td>
                        <td className="px-3 py-3"><Badge tone={op.tone}>{op.label}</Badge></td>
                        <td className="px-5 py-3"><StatusBadge status={r.outcome} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data && !visible.length && <EmptyState title={data.rows.length ? "No events match these filters" : "No audit events yet"} />}
            </div>
          </Card>
        </>
      )}

      {tab === "limits" && (
        <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Card>
            <CardHeader title="Organization" />
            <div className="space-y-4 px-5 pb-5">
              <Field label="Name">
                <Input value={orgDraft?.name ?? org.name} disabled={!isAdmin} maxLength={120}
                  onChange={(e) => setOrgDraft({ name: e.target.value, description: orgDraft?.description ?? org.description })} />
              </Field>
              <Field label="Description">
                <Textarea rows={4} value={orgDraft?.description ?? org.description} disabled={!isAdmin} maxLength={2000}
                  onChange={(e) => setOrgDraft({ name: orgDraft?.name ?? org.name, description: e.target.value })} />
              </Field>
              {isAdmin && <Button variant="primary" loading={busy === "org"} disabled={!orgDraft} onClick={saveOrg}>Save organization</Button>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Execution limits" subtitle="Validated by the backend and enforced by the scheduler for every task." />
            {!settings ? <div className="px-5 pb-5"><Skeleton className="h-64" /></div> : (
              <div className="px-5 pb-5">
                <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-line bg-panel-2/50 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-ink">Require plan approval</div>
                    <div className="text-xs text-ink-3">Every proposed plan waits for an admin before any task runs.</div>
                  </div>
                  <Toggle label="Require plan approval" checked={settings.require_plan_approval} disabled={!isAdmin}
                    onChange={(v) => setDraft({ ...settings, require_plan_approval: v })} />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {LIMITS.map((l) => (
                    <Field key={l.key} label={l.label} hint={`${l.hint} (${l.min.toLocaleString()}–${l.max.toLocaleString()})`}>
                      <Input type="number" min={l.min} max={l.max} disabled={!isAdmin} value={String(settings[l.key] ?? "")}
                        onChange={(e) => setDraft({ ...settings, [l.key]: Number(e.target.value) })} />
                    </Field>
                  ))}
                  <Field label="Default model" hint="Optional. Used when an agent spec does not set a model. Overrides the integration default.">
                    <Input value={settings.default_model ?? ""} disabled={!isAdmin} placeholder={status?.llm.model ?? "provider default"}
                      onChange={(e) => setDraft({ ...settings, default_model: e.target.value.trim() || null })} />
                  </Field>
                </div>

                <h4 className="mt-7 text-sm font-semibold text-ink">Evaluation gate</h4>
                <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-panel-2/50 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-ink">Require a passing evaluation before activation</div>
                    <div className="text-xs text-ink-3">New agent versions (manual edits and accepted proposals) must pass at least as many recorded cases as before.</div>
                  </div>
                  <Toggle label="Require evaluation for activation" checked={settings.require_eval_for_activation} disabled={!isAdmin}
                    onChange={(v) => setDraft({ ...settings, require_eval_for_activation: v })} />
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label="Minimum pass rate (%)" hint="Floor applied in addition to the recorded baseline (0–100).">
                    <Input type="number" min={0} max={100} disabled={!isAdmin} value={String(Math.round(settings.eval_min_pass_rate * 100))}
                      onChange={(e) => setDraft({ ...settings, eval_min_pass_rate: Number(e.target.value) / 100 })} />
                  </Field>
                  <Field label="Cases per evaluation" hint="Most recent cases replayed per run (1–50).">
                    <Input type="number" min={1} max={50} disabled={!isAdmin} value={String(settings.eval_max_cases)}
                      onChange={(e) => setDraft({ ...settings, eval_max_cases: Number(e.target.value) })} />
                  </Field>
                </div>

                <h4 className="mt-7 text-sm font-semibold text-ink">Model routing</h4>
                <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-panel-2/50 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-ink">Auto-route to the cheapest model that meets the bar</div>
                    <div className="text-xs text-ink-3">Per agent, from verified runs and evaluations. Models pinned in an agent spec always win; otherwise the default model is used until a candidate has enough evidence.</div>
                  </div>
                  <Toggle label="Auto model routing" checked={settings.model_routing === "auto"} disabled={!isAdmin}
                    onChange={(v) => setDraft({ ...settings, model_routing: v ? "auto" : "fixed" })} />
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label="Candidate models" hint="Comma-separated model ids (up to 8)." className="md:col-span-2">
                    <Input disabled={!isAdmin} value={settings.routing_models.join(", ")} placeholder="openai/gpt-oss-20b:free, meta-llama/llama-3.3-70b-instruct:free"
                      onChange={(e) => setDraft({ ...settings, routing_models: e.target.value.split(",").map((m) => m.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label="Minimum verified runs" hint="Evidence needed before a model is eligible (1–100).">
                    <Input type="number" min={1} max={100} disabled={!isAdmin} value={String(settings.routing_min_runs)}
                      onChange={(e) => setDraft({ ...settings, routing_min_runs: Number(e.target.value) })} />
                  </Field>
                  <Field label="Target pass rate (%)" hint="Models below this are never chosen.">
                    <Input type="number" min={0} max={100} disabled={!isAdmin} value={String(Math.round(settings.routing_target_pass_rate * 100))}
                      onChange={(e) => setDraft({ ...settings, routing_target_pass_rate: Number(e.target.value) / 100 })} />
                  </Field>
                </div>
                {isAdmin ? (
                  <div className="mt-5 flex gap-2">
                    <Button variant="primary" loading={busy === "limits"} disabled={!draft} onClick={saveSettings}>Save limits</Button>
                    {draft && <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>}
                  </div>
                ) : <p className="mt-4 text-xs text-ink-3">Only admins can change execution limits.</p>}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "policy" && (
        <Card>
          <CardHeader title="Tool policy" subtitle="Organization-wide switches. Agents only receive tools that are requested by their spec and allowed here." />
          <div className="px-5 pb-2">
            <Banner tone="warn">Tools marked <strong>Requires approval</strong> force plan approval for any workflow that uses them, even when general plan approval is turned off.</Banner>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-5 py-3 font-medium">Tool</th>
                  <th className="px-3 py-3 font-medium">Integration</th>
                  <th className="px-3 py-3 font-medium">Enabled</th>
                  <th className="px-5 py-3 font-medium">Requires approval</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!catalog && <tr><td colSpan={4} className="px-5 py-4"><Skeleton className="h-20" /></td></tr>}
                {catalog?.tools.map((t) => {
                  const policy = merged?.tool_policy[t.name] ?? { enabled: true, requires_approval: false };
                  const configured = t.integrations.some((p) => status?.providers.includes(p));
                  const locked = !isAdmin || busy === `policy-${t.name}`;
                  return (
                    <tr key={t.name}>
                      <td className="px-5 py-3.5">
                        <div className="font-mono text-[13px] text-ink">{t.name}</div>
                        <div className="max-w-md text-[11px] text-ink-3">{t.description}</div>
                      </td>
                      <td className="px-3 py-3.5">
                        {!t.integrations.length ? <span className="text-xs text-ink-3">Not needed</span>
                          : configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="warn">Missing: {t.integrations.join(" or ")}</Badge>}
                      </td>
                      <td className="px-3 py-3.5">
                        <Toggle label={`Enable ${t.name}`} checked={policy.enabled} disabled={locked} onChange={(v) => setPolicy(t.name, { enabled: v })} />
                      </td>
                      <td className="px-5 py-3.5">
                        <Toggle label={`Require approval for ${t.name}`} checked={policy.requires_approval} disabled={locked}
                          onChange={(v) => setPolicy(t.name, { requires_approval: v })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!isAdmin && <p className="px-5 py-3 text-xs text-ink-3">Only admins can change tool policy.</p>}
        </Card>
      )}

      {tab === "members" && <MembersSection />}
    </div>
  );
}
