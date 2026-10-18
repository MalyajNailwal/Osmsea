"use client";

import { Bot, Check, ChevronRight, History, Lock, Pencil, Power, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useApp } from "@/components/providers";
import {
  Badge, Banner, Button, Card, CardHeader, CodeBlock, cx, EmptyState, Field, Input, Modal, Skeleton, StatusBadge, Tabs,
  Textarea,
} from "@/components/ui";
import { type AgentSpec, ApiError, api, errorMessage, type OrgSettings, type Validation } from "@/lib/api";
import { compact, duration, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type AgentVersion, supabase } from "@/lib/supabase";

type TabId = "overview" | "permissions" | "activity" | "instructions" | "versions";
type CheckResult = { name: string; passed: boolean; detail: string };

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed so drafts and messages reset when navigating between agents.
  return <AgentView key={id} id={id} />;
}

function Pill({ kind, children, title }: { kind: "allowed" | "blocked" | "approval" | "muted"; children: ReactNode; title?: string }) {
  const style = {
    allowed: "border-ok/35 bg-ok/10 text-ok",
    blocked: "border-bad/30 bg-bad/[0.06] text-bad",
    approval: "border-warn/70 bg-warn/10 text-warn",
    muted: "border-white/10 bg-white/[0.03] text-ink-3",
  }[kind];
  const Icon = kind === "allowed" ? Check : kind === "blocked" ? X : kind === "approval" ? Lock : null;
  return (
    <span title={title} className={cx("inline-flex h-8 min-w-[118px] items-center gap-2 rounded-lg border px-3 text-[13px] font-medium", style)}>
      {Icon && <Icon className="size-3.5" />}
      {children}
    </span>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-sm text-ink-3">None</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((i) => <li key={i} className="flex gap-2 text-sm text-ink-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />{i}</li>)}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="px-5 pb-5">{children}</div>
    </Card>
  );
}

function AgentView({ id }: { id: string }) {
  const { org, can, catalog, status } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const [tab, setTab] = useState<TabId>("overview");
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string; errors?: string[] } | null>(null);
  const [viewing, setViewing] = useState<AgentVersion | null>(null);

  const { data, loading, error, reload } = useLive(async () => {
    if (!orgId) return null;
    const agent = (await supabase.from("agents").select("*").eq("org_id", orgId).eq("id", id).then(unwrap))[0];
    if (!agent) return { agent: null } as const;
    const [departments, versions, executions] = await Promise.all([
      supabase.from("departments").select("id, name, description").eq("id", agent.department_id).then(unwrap),
      supabase.from("agent_versions").select("*").eq("agent_id", id).order("version", { ascending: false }).then(unwrap),
      supabase.from("agent_executions").select("*").eq("agent_id", id).order("started_at", { ascending: false }).limit(50).then(unwrap),
    ]);
    const taskIds = [...new Set(executions.map((e) => e.task_id))];
    const tasks = taskIds.length
      ? await supabase.from("tasks").select("id, title, key, workflow_id, status").in("id", taskIds).then(unwrap)
      : [];
    return { agent, department: departments[0] ?? null, versions, executions, tasks,
      active: versions.find((v) => v.id === agent.active_version_id) ?? null };
  }, [orgId, id], { orgId, tables: ["agents", "agent_executions", "tasks"] });

  const active = data?.agent ? data.active : null;
  const source = active?.source_md ?? "";
  const settings = (org?.settings ?? {}) as Partial<OrgSettings>;
  const providersKey = (status?.providers ?? []).join(",");
  const settingsKey = JSON.stringify(settings.tool_policy ?? {});

  // Effective tools come from the backend's own computation, not a client-side guess.
  const { data: effective, error: effectiveError } = useLive(async () => {
    if (!orgId || !source) return null;
    return (await api.validateAgent(orgId, source)).effective_tools ?? null;
  }, [orgId, source, providersKey, settingsKey]);

  if (!org) return null;
  if (loading && !data) return <div className="mx-auto max-w-[1300px] space-y-4"><Skeleton className="h-24" /><Skeleton className="h-96" /></div>;
  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!data?.agent) {
    return <EmptyState icon={<Bot className="size-5" />} title="Agent not found" description="It may belong to another organization or have been removed."
      action={<Link href="/agents"><Button>Back to agents</Button></Link>} />;
  }

  const { agent, department, versions, executions, tasks } = data;
  const spec = active?.spec as AgentSpec | undefined;
  const isAdmin = can("admin");
  const editorValue = draft ?? source;
  const lastActivity = executions[0]?.started_at ?? null;
  const allowedCount = effective?.allowed.length ?? 0;
  const approvalTools = (catalog?.tools ?? []).filter((t) => spec?.allowed_tools.includes(t.name) && settings.tool_policy?.[t.name]?.requires_approval);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ tone: "ok", text });
      await reload();
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof ApiError ? e.message : errorMessage(e), errors: e instanceof ApiError ? e.errors : undefined });
    } finally {
      setBusy(null);
    }
  };

  const validate = () => run("validate", async () => {
    const v = await api.validateAgent(org.id, editorValue);
    setValidation(v);
  });
  const save = () => run("save", async () => {
    const res = await api.updateAgent(org.id, agent.id, editorValue, note.trim());
    setDraft(null);
    setNote("");
    setValidation(null);
    return `Saved and activated v${res.version}. Running tasks keep the version they were pinned to.`;
  });
  const restore = (v: AgentVersion) => run(`restore-${v.id}`, async () => {
    const res = await api.updateAgent(org.id, agent.id, v.source_md, `restore v${v.version}`);
    return `Restored v${v.version} as v${res.version}.`;
  });
  const toggleStatus = () => run("status", async () => {
    await api.setAgentStatus(org.id, agent.id, agent.status === "active" ? "disabled" : "active");
    return agent.status === "active" ? "Agent disabled. It will not be assigned to new plans." : "Agent enabled.";
  });

  const finished = executions.filter((e) => ["succeeded", "failed", "timed_out"].includes(e.status));
  const succeeded = finished.filter((e) => e.status === "succeeded").length;

  return (
    <div className="mx-auto max-w-[1300px]">
      <nav className="mb-5 flex items-center gap-2 text-sm text-ink-3">
        <Link href="/agents" className="hover:text-ink">Agents</Link>
        <ChevronRight className="size-3.5" />
        <span className="text-ink">{agent.name}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="grid size-16 place-items-center rounded-2xl border border-ok/25 bg-ok/10 text-ok"><Bot className="size-7" /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[28px] font-semibold tracking-tight">{agent.name}</h1>
              <StatusBadge status={agent.status} />
              <Badge tone="ok">No write tools</Badge>
              {active && <Badge>v{active.version}</Badge>}
            </div>
            <p className="mt-1 text-sm text-ink-3">
              {department?.name ?? "—"} · {agent.role || spec?.role} · Last activity {timeAgo(lastActivity, now)}
            </p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button icon={<Pencil className="size-4" />} onClick={() => setTab("instructions")}>Edit instructions</Button>
            <Button variant={agent.status === "active" ? "danger" : "success"} icon={<Power className="size-4" />}
              loading={busy === "status"} onClick={toggleStatus}>
              {agent.status === "active" ? "Disable" : "Enable"}
            </Button>
          </div>
        )}
      </div>

      {message && (
        <Banner tone={message.tone} className="mb-4">
          {message.text}
          {message.errors && message.errors.length > 0 && <ul className="mt-1 list-disc pl-4">{message.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </Banner>
      )}
      {!active && <Banner tone="bad" className="mb-4">This agent has no active specification version and cannot be planned.</Banner>}

      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" },
        { id: "permissions", label: "Permissions", count: allowedCount },
        { id: "activity", label: "Activity", count: executions.length },
        { id: "instructions", label: "Instructions" },
        { id: "versions", label: "Versions", count: `v${active?.version ?? "–"}` },
      ]} />

      {tab === "overview" && spec && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Mission"><p className="text-sm leading-relaxed text-ink-2">{spec.mission}</p></Section>
          <Section title="Responsibilities"><List items={spec.responsibilities} /></Section>
          <Section title="Capabilities">
            <div className="flex flex-wrap gap-1.5">{spec.capabilities.map((c) => <Badge key={c} tone="accent">{c}</Badge>)}</div>
          </Section>
          <Section title="Limitations"><List items={spec.limitations} /></Section>
          <Section title="Inputs"><List items={spec.inputs} /></Section>
          <Section title="Outputs">
            <List items={spec.outputs} />
            <p className="mt-3 text-xs text-ink-3">Output schema <span className="font-mono text-ink-2">{spec.output_schema}</span></p>
          </Section>
          <Section title="Acceptance criteria"><List items={spec.acceptance_criteria} /></Section>
          <Section title="Verification & escalation">
            <div className="space-y-2 text-sm">
              {([["Schema validation", true], ["Cited evidence must be retrieved", spec.verification.require_cited_evidence],
                ["Syntax check of files", spec.verification.syntax_check], ["Independent review", spec.verification.independent_review]] as const)
                .map(([label, on]) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-ink-2">{label}</span>
                    {on ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
                  </div>
                ))}
              {spec.verification.min_sources > 0 && (
                <div className="flex justify-between"><span className="text-ink-2">Minimum retrieved sources</span><span className="tabular">{spec.verification.min_sources}</span></div>
              )}
              <div className="flex justify-between border-t border-line pt-2"><span className="text-ink-2">Max attempts</span><span className="tabular">{spec.escalation.max_attempts}</span></div>
              <div className="flex justify-between"><span className="text-ink-2">Max steps / timeout</span><span className="tabular">{spec.limits.max_steps} · {spec.limits.timeout_seconds}s</span></div>
              {spec.model && <div className="flex justify-between"><span className="text-ink-2">Model override</span><span className="font-mono text-xs">{spec.model}</span></div>}
              <p className="pt-1 text-xs text-ink-3">On failure: {spec.escalation.on_failure}</p>
            </div>
          </Section>
        </div>
      )}

      {tab === "permissions" && spec && (
        <Card>
          <CardHeader title={<span className="text-xl">What can this agent do?</span>} subtitle="Changes apply to new tasks immediately."
            icon={<ShieldCheck className="size-5" />} />
          <div className="px-5 pb-5">
            {effectiveError && <Banner tone="bad" className="mb-3">Could not compute effective tools: {effectiveError}</Banner>}
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                    <th className="px-4 py-3">Tool</th>
                    <th className="px-3 py-3">Requested by spec</th>
                    <th className="px-3 py-3">Org policy</th>
                    <th className="px-3 py-3">Integration</th>
                    <th className="px-3 py-3">Effective</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(catalog?.tools ?? []).map((tool) => {
                    const requested = spec.allowed_tools.includes(tool.name);
                    const policy = settings.tool_policy?.[tool.name] ?? { enabled: true, requires_approval: false };
                    const configured = tool.integrations.some((p) => status?.providers.includes(p));
                    const allowed = effective?.allowed.includes(tool.name);
                    const reason = effective?.unavailable[tool.name];
                    return (
                      <tr key={tool.name}>
                        <td className="px-4 py-3">
                          <div className="font-mono text-[13px] text-ink">{tool.name}</div>
                          <div className="max-w-xs text-[11px] text-ink-3">{tool.description}</div>
                        </td>
                        <td className="px-3 py-3">{requested ? <Pill kind="allowed">Requested</Pill> : <Pill kind="muted">Not requested</Pill>}</td>
                        <td className="px-3 py-3">
                          {!policy.enabled ? <Pill kind="blocked">Blocked</Pill> : policy.requires_approval ? <Pill kind="approval">Approval</Pill> : <Pill kind="allowed">Allowed</Pill>}
                        </td>
                        <td className="px-3 py-3">
                          {!tool.integrations.length ? <Pill kind="muted">Not needed</Pill> : configured ? <Pill kind="allowed">Configured</Pill>
                            : <Pill kind="blocked" title={`Needs ${tool.integrations.join(" or ")}`}>Missing</Pill>}
                        </td>
                        <td className="px-3 py-3">
                          {!requested ? <Pill kind="muted">—</Pill> : effective == null ? <Skeleton className="h-8 w-28" /> : allowed
                            ? (policy.requires_approval ? <Pill kind="approval">Approval</Pill> : <Pill kind="allowed">Allowed</Pill>)
                            : <div><Pill kind="blocked" title={reason}>Blocked</Pill>{reason && <div className="mt-1 text-[11px] text-ink-3">{reason}</div>}</div>}
                        </td>
                      </tr>
                    );
                  })}
                  {spec.allowed_tools.filter((name) => name.startsWith("mcp__")).map((name) => {
                    const allowed = effective?.allowed.includes(name);
                    const reason = effective?.unavailable[name];
                    return (
                      <tr key={name}>
                        <td className="px-4 py-3">
                          <div className="font-mono text-[13px] text-ink">{name}</div>
                          <div className="max-w-xs text-[11px] text-ink-3">Third-party MCP tool (approved per server in Integrations)</div>
                        </td>
                        <td className="px-3 py-3"><Pill kind="allowed">Requested</Pill></td>
                        <td className="px-3 py-3">
                          {effective == null ? <Skeleton className="h-8 w-28" /> : allowed ? <Pill kind="allowed">Approved</Pill> : <Pill kind="blocked">Not approved</Pill>}
                        </td>
                        <td className="px-3 py-3"><Pill kind="muted">MCP server</Pill></td>
                        <td className="px-3 py-3">
                          {effective == null ? <Skeleton className="h-8 w-28" /> : allowed ? <Pill kind="approval" title="Plans using MCP tools need approval unless the server opts out">Allowed</Pill>
                            : <div><Pill kind="blocked" title={reason}>Blocked</Pill>{reason && <div className="mt-1 text-[11px] text-ink-3">{reason}</div>}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {approvalTools.map((t) => (
              <Banner key={t.name} tone="warn" className="mt-3">
                <span className="font-medium">{t.name}</span> requires approval: any plan that uses it waits for an admin, even when general plan approval is off.
              </Banner>
            ))}
            <Banner tone="warn" className="mt-3">
              The specification only <em>requests</em> tools. The backend grants the intersection of the spec, the organization&apos;s tool policy,
              configured integrations and the permissions approved for each workflow, and denies and audits every other call.{" "}
              <Link href="/settings?tab=policy" className="underline">Governance → Tool policy</Link>
            </Banner>
          </div>
        </Card>
      )}

      {tab === "activity" && (
        <Card>
          <CardHeader title="Recent executions" subtitle={`${executions.length} most recent · ${succeeded}/${finished.length} verified`} icon={<History className="size-4" />} />
          <div className="divide-y divide-line">
            {executions.map((e) => {
              const task = tasks.find((t) => t.id === e.task_id);
              const checks = ((e.verification as { checks?: CheckResult[] } | null)?.checks ?? []);
              return (
                <div key={e.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status={e.status} />
                    <Link href={`/tasks/${e.workflow_id}`} className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:underline">
                      {task?.title ?? "Task"}
                    </Link>
                    <span className="text-[11px] text-ink-3 tabular">
                      attempt {e.attempt} · {duration(e.started_at, e.finished_at, now)} · {compact(e.input_tokens + e.output_tokens)} tokens
                      {e.cost_usd != null && ` · ${usd(Number(e.cost_usd))}`} · {timeAgo(e.started_at, now)}
                    </span>
                  </div>
                  {checks.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {checks.map((c) => <Badge key={c.name} tone={c.passed ? "ok" : "bad"}><span title={c.detail}>{c.passed ? "✓" : "✕"} {c.name.replaceAll("_", " ")}</span></Badge>)}
                    </div>
                  )}
                  {e.error && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-bad/20 bg-bad/[0.06] px-3 py-2 text-xs text-bad">{e.error}</p>}
                </div>
              );
            })}
            {!executions.length && <EmptyState icon={<History className="size-5" />} title="No executions yet" description="Runs appear here once a plan assigns this agent a task." />}
          </div>
        </Card>
      )}

      {tab === "instructions" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card>
            <CardHeader title="Specification" subtitle="Markdown with YAML frontmatter. Validated by the backend before activation."
              actions={draft !== null && <Badge tone="warn">Unsaved changes</Badge>} />
            <div className="px-5 pb-5">
              <Textarea rows={30} spellCheck={false} value={editorValue} readOnly={!isAdmin}
                onChange={(e) => { setDraft(e.target.value); setValidation(null); }}
                className="font-mono text-[12.5px] leading-relaxed" />
            </div>
          </Card>
          <div className="space-y-4">
            <Card className="p-5">
              <div className="flex gap-2">
                <Button className="flex-1" loading={busy === "validate"} onClick={validate}>Validate</Button>
                {draft !== null && <Button variant="ghost" onClick={() => { setDraft(null); setValidation(null); }}>Discard</Button>}
              </div>
              {isAdmin ? (
                <>
                  <Field label="Version note" className="mt-4">
                    <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" />
                  </Field>
                  <Button variant="primary" className="mt-3 w-full" loading={busy === "save"} disabled={draft === null} onClick={save}>
                    Save as new version
                  </Button>
                  <p className="mt-2 text-[11px] text-ink-3">Saving validates and activates a new version. The agent id must not change.</p>
                </>
              ) : <p className="mt-3 text-xs text-ink-3">Only admins can change agent specifications.</p>}
            </Card>
            {validation && (
              <Card className="p-5">
                {validation.valid ? (
                  <>
                    <Banner tone="ok">Valid specification</Banner>
                    <div className="mt-3 text-xs text-ink-3">Effective tools</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {validation.effective_tools?.allowed.map((t) => <Badge key={t} tone="ok">{t}</Badge>)}
                      {!validation.effective_tools?.allowed.length && <span className="text-xs text-ink-3">none</span>}
                    </div>
                    {Object.entries(validation.effective_tools?.unavailable ?? {}).map(([t, r]) => (
                      <p key={t} className="mt-2 text-[11px] text-ink-3"><span className="font-mono text-warn">{t}</span>: {r}</p>
                    ))}
                  </>
                ) : (
                  <Banner tone="bad">
                    {validation.errors.length} problem{validation.errors.length === 1 ? "" : "s"}:
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                  </Banner>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === "versions" && (
        <Card>
          <CardHeader title="Specification versions" subtitle="Versions are immutable. Restoring creates a new version from an old one." icon={<History className="size-4" />} />
          <div className="divide-y divide-line">
            {versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Badge tone={v.id === agent.active_version_id ? "accent" : "neutral"}>v{v.version}</Badge>
                {v.id === agent.active_version_id && <Badge tone="ok" dot>Active</Badge>}
                <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{v.note || "No note"}</span>
                <span className="text-[11px] text-ink-3">{timeAgo(v.created_at, now)}</span>
                <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>View</Button>
                {isAdmin && v.id !== agent.active_version_id && (
                  <Button size="sm" loading={busy === `restore-${v.id}`} onClick={() => restore(v)}>Restore</Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={`${agent.name} · v${viewing?.version ?? ""}`} wide>
        {viewing && <CodeBlock code={viewing.source_md} maxHeight="60vh" />}
      </Modal>
    </div>
  );
}
