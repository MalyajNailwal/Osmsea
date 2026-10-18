"use client";

import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Clock, Download, FileText, GitBranch, Loader2, RotateCcw,
  Search, ShieldAlert, ShieldCheck, XCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { ForecastCard } from "@/components/forecast";
import { PlanDag } from "@/components/plan-dag";
import { useApp } from "@/components/providers";
import { ReplayButton } from "@/components/replay";
import {
  Badge, Banner, Button, Card, CardHeader, CodeBlock, CopyButton, cx, download, EmptyState, Markdown, Segmented, Skeleton,
  StatusBadge, Tabs, Textarea,
} from "@/components/ui";
import { api, errorMessage, type Forecast } from "@/lib/api";
import { clockTime, compact, duration, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type Artifact, type Execution, type ExecutionEvent, type Task, supabase } from "@/lib/supabase";

type Permission = { tool: string; agents: string[]; requires_approval: boolean };
type Check = { name: string; passed: boolean; detail: string; output?: string; exit_code?: number };
type Verification = { passed: boolean; checks: Check[]; review: { criteria: { criterion: string; met: boolean; reason: string }[]; verdict: string; summary: string } | null };
type Step = { n: number; at: string; type: string; tool?: string; ok: boolean; args?: Record<string, unknown>; preview?: string; ms?: number; evidence?: string[] };
type PlanJson = { tasks?: { key: string }[] };

const CHECK_LABEL: Record<string, string> = {
  schema: "Schema validation", cited_evidence: "Citations were retrieved", min_sources: "Minimum sources",
  syntax: "Files parse", tests: "Tests executed in sandbox", independent_review: "Independent review",
};

function StatCell({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-ink">{icon}{children}</div>
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const label = step.type === "tool" ? step.tool : step.type === "denied" ? `${step.tool} (denied)` : step.type === "submit" ? "submit_result" : "message";
  return (
    <div className="rounded-md border border-line bg-[#0a0c16]">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]">
        {open ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" />}
        <span className="text-ink-3 tabular">#{step.n}</span>
        <span className={cx("font-mono", step.type === "denied" ? "text-warn" : "text-ink-2")}>{label}</span>
        <span className="ml-auto flex items-center gap-2">
          {step.ms != null && <span className="text-[10.5px] text-ink-3 tabular">{step.ms}ms</span>}
          {step.ok ? <CheckCircle2 className="size-3.5 text-ok" /> : <XCircle className={cx("size-3.5", step.type === "denied" ? "text-warn" : "text-bad")} />}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          {step.args && <div><div className="mb-1 text-[10.5px] text-ink-3">Request</div><CodeBlock code={JSON.stringify(step.args, null, 2)} maxHeight="10rem" /></div>}
          {step.preview && <div><div className="mb-1 text-[10.5px] text-ink-3">Response (preview)</div><CodeBlock code={step.preview} maxHeight="12rem" /></div>}
          {!!step.evidence?.length && <div className="text-[10.5px] text-ink-3">Evidence: {step.evidence.join(", ")}</div>}
        </div>
      )}
    </div>
  );
}

function TaskItem({ task, index, executions, selected, onSelect, now }: {
  task: Task; index: number; executions: Execution[]; selected: boolean; onSelect: () => void; now: number;
}) {
  const [open, setOpen] = useState(false);
  const criteria = (task.acceptance_criteria as string[] | null) ?? [];
  return (
    <div className={cx("rounded-xl border transition-colors", selected ? "border-accent/50 bg-accent/[0.06]" : "border-line bg-panel-2/40")}>
      <div className="flex items-start gap-3 p-3">
        <button onClick={onSelect} className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] text-ink-2">{index}</button>
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className="line-clamp-2 text-[13px] font-medium text-ink">{task.title}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            <span className="font-mono">{task.agent_slug}</span> · {task.started_at ? `${clockTime(task.started_at)} · ${duration(task.started_at, task.completed_at, now)}` : "not started"}
            {task.attempt > 0 && ` · attempt ${task.attempt}/${task.max_attempts}`}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={task.status} />
          <button onClick={() => setOpen((v) => !v)} className="rounded p-0.5 text-ink-3 hover:text-ink" aria-label="Toggle details">
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </div>
      </div>
      {task.error && ["failed", "blocked", "queued"].includes(task.status) && (
        <div className={cx("mx-3 mb-3 rounded-md border px-2.5 py-1.5 text-[11.5px]", task.status === "queued" ? "border-warn/25 bg-warn/5 text-warn/90" : "border-bad/25 bg-bad/5 text-bad/90")}>
          {task.status === "queued" ? "Retrying after: " : ""}{task.error}
        </div>
      )}
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-[12.5px]">
          <p className="text-ink-2">{task.description}</p>
          <div><span className="text-ink-3">Expected output: </span><span className="text-ink-2">{task.expected_output}</span></div>
          {!!criteria.length && (
            <div>
              <div className="mb-1 text-ink-3">Acceptance criteria</div>
              <ul className="list-disc space-y-0.5 pl-4 text-ink-2">{criteria.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          {executions.map((ex) => (
            <div key={ex.id} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="font-medium text-ink">Attempt {ex.attempt}</span>
                <StatusBadge status={ex.status} />
                <span className="text-ink-3">{ex.model ?? ex.provider ?? ""} · {compact(ex.input_tokens + ex.output_tokens)} tok · {duration(ex.started_at, ex.finished_at, now)}</span>
                {!["running", "verifying"].includes(ex.status) && <ReplayButton execution={ex} />}
              </div>
              {((ex.steps as Step[] | null) ?? []).map((s) => <StepRow key={s.n} step={s} />)}
              {ex.error && <div className="text-[11.5px] text-bad/90">{ex.error}</div>}
            </div>
          ))}
          {!executions.length && <div className="text-ink-3">No executions yet.</div>}
        </div>
      )}
    </div>
  );
}

function VerificationView({ verification }: { verification: Verification | null }) {
  if (!verification) return <EmptyState icon={<ShieldCheck className="size-5" />} title="Not verified yet" description="Checks run after the agent submits a schema-valid result." />;
  return (
    <div className="space-y-4">
      <Banner tone={verification.passed ? "ok" : "bad"}>
        {verification.passed ? "All verification checks passed. The task was marked completed by the runtime, not by the model." : "Verification failed. The task cannot complete with this output."}
      </Banner>
      <div className="space-y-2">
        {verification.checks.map((c) => (
          <div key={c.name} className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2/40 px-3 py-2">
            {c.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-bad" />}
            <div className="min-w-0">
              <div className="text-sm text-ink">{CHECK_LABEL[c.name] ?? c.name}</div>
              <div className="text-xs break-words text-ink-3">{c.detail}</div>
              {c.output && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-ink-2">Sandbox output (exit code {c.exit_code}, offline, printed by the agent&apos;s code)</summary>
                  <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-line bg-[#080912] p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">{c.output}</pre>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>
      {verification.review && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">Reviewer verdict <StatusBadge status={verification.review.verdict === "pass" ? "success" : "failure"} /></div>
          <p className="mb-2 text-xs text-ink-2">{verification.review.summary}</p>
          <div className="overflow-hidden rounded-lg border border-line">
            {verification.review.criteria.map((c, i) => (
              <div key={i} className="flex gap-2.5 border-b border-line px-3 py-2 text-xs last:border-0">
                {c.met ? <CheckCircle2 className="size-3.5 shrink-0 text-ok" /> : <XCircle className="size-3.5 shrink-0 text-bad" />}
                <div><div className="text-ink-2">{c.criterion}</div><div className="text-ink-3">{c.reason}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function logLines(events: ExecutionEvent[]): string {
  return events.map((e) => `[${clockTime(e.created_at)}] ${e.level.toUpperCase().padEnd(7)} ${e.type.padEnd(20)} ${e.message}`).join("\n");
}

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const { org, can } = useApp();
  const router = useRouter();
  const now = useNow(1000);
  const orgId = org?.id;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "errors" | "running">("all");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"result" | "json" | "verification" | "logs" | "artifacts">("result");
  const [logScope, setLogScope] = useState<"task" | "workflow">("task");
  const [artifactOpen, setArtifactOpen] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error } = useLive(async () => {
    const [wfs, tasks, executions, events, artifacts, approvals] = await Promise.all([
      supabase.from("workflows").select("*").eq("id", id).then(unwrap),
      supabase.from("tasks").select("*").eq("workflow_id", id).then(unwrap),
      supabase.from("agent_executions").select("*").eq("workflow_id", id).order("started_at").then(unwrap),
      supabase.from("execution_events").select("*").eq("workflow_id", id).order("id").limit(2000).then(unwrap),
      supabase.from("artifacts").select("*").eq("workflow_id", id).order("created_at").then(unwrap),
      supabase.from("approvals").select("*").eq("workflow_id", id).order("created_at").then(unwrap),
    ]);
    return { wf: wfs[0] ?? null, tasks, executions, events, artifacts, approvals };
  }, [id], { orgId, tables: ["workflows", "tasks", "agent_executions", "execution_events", "approvals"] });

  const wf = data?.wf ?? null;
  const tasks = useMemo(() => {
    const order = new Map(((wf?.plan as PlanJson | null)?.tasks ?? []).map((t, i) => [t.key, i]));
    return [...(data?.tasks ?? [])].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  }, [data?.tasks, wf?.plan]);
  const selectedTask = tasks.find((t) => t.id === selected)
    ?? tasks.find((t) => ["running", "verifying"].includes(t.status)) ?? tasks.find((t) => t.output) ?? tasks[0] ?? null;
  const execsFor = (taskId: string) => (data?.executions ?? []).filter((e) => e.task_id === taskId);
  const artifactsFor = (taskId: string): Artifact[] => (data?.artifacts ?? []).filter((a) => a.task_id === taskId);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <div className="mx-auto max-w-[1500px] space-y-4"><Skeleton className="h-36 rounded-2xl" /><Skeleton className="h-96 rounded-2xl" /></div>;
  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!wf) return <EmptyState title="Workflow not found" description="It may belong to another organization, or it was deleted." action={<Link href="/tasks"><Button>Back to tasks</Button></Link>} />;

  const errors = tasks.filter((t) => t.status === "failed").length + (data?.events ?? []).filter((e) => e.level === "error").length;
  const permissions = (wf.required_permissions as Permission[] | null) ?? [];
  const planErrors = (wf.plan_errors as string[] | null) ?? [];
  const criteria = (wf.acceptance_criteria as string[] | null) ?? [];
  const activeState = ["planning", "awaiting_approval", "running"].includes(wf.status);
  const term = search.trim().toLowerCase();
  const listed = tasks.filter((t) => (filter === "all" || (filter === "errors" && ["failed", "blocked"].includes(t.status))
    || (filter === "running" && ["running", "verifying", "queued"].includes(t.status)))
    && (!term || t.title.toLowerCase().includes(term) || t.agent_slug.includes(term)));
  const selectedVerification = (selectedTask?.verification as Verification | null) ?? null;
  const resultArtifact = selectedTask ? artifactsFor(selectedTask.id).find((a) => a.kind === "markdown") : undefined;
  const scopedEvents = (data?.events ?? []).filter((e) => logScope === "workflow" || !selectedTask || e.task_id === selectedTask.id);
  const exportLogs = () => download(`workflow-${wf.id}.json`, JSON.stringify({ workflow: wf, tasks, executions: data?.executions, events: data?.events, approvals: data?.approvals }, null, 2));

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3 flex items-center gap-2 text-xs text-ink-3">
        <Link href="/tasks" className="flex items-center gap-1 hover:text-ink"><ArrowLeft className="size-3.5" /> Back to Tasks</Link>
        <span>›</span><span className="font-mono">Workflow {wf.id.slice(0, 8)}</span>
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0 max-w-4xl">
            <div className="mb-1 text-xs text-ink-3">Agent Execution Viewer</div>
            <h1 className="line-clamp-2 text-xl font-semibold tracking-tight">{wf.goal}</h1>
            {wf.objective && <p className="mt-1 text-sm text-ink-2">{wf.objective}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeState && can("admin") && (
              <Button variant="danger" size="sm" icon={<CircleSlash className="size-3.5" />} loading={busy === "cancel"}
                onClick={() => confirm("Cancel this workflow? Running tasks are stopped.") && act("cancel", () => api.cancel(wf.org_id, wf.id))}>
                Cancel
              </Button>
            )}
            {["plan_failed", "failed", "cancelled", "rejected"].includes(wf.status) && can("member") && (
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={busy === "rerun"}
                onClick={() => act("rerun", async () => router.push(`/tasks/${(await api.submitGoal(wf.org_id, wf.goal)).id}`))}>
                Run again
              </Button>
            )}
            <Button size="sm" icon={<Download className="size-3.5" />} onClick={exportLogs}>Export logs</Button>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          <StatCell label="Total tasks" icon={<GitBranch className="size-4 text-ink-3" />}>{tasks.length}</StatCell>
          <StatCell label="Errors" icon={<ShieldAlert className={cx("size-4", errors ? "text-bad" : "text-ink-3")} />}>{errors}</StatCell>
          <StatCell label="Duration" icon={<Clock className="size-4 text-ink-3" />}>{wf.started_at ? duration(wf.started_at, wf.completed_at, now) : "—"}</StatCell>
          <StatCell label="Status" icon={null}><StatusBadge status={wf.status} className="text-xs" /></StatCell>
          <StatCell label="Tokens · cost" icon={null}><span className="tabular">{compact(wf.tokens_used)} · {usd(Number(wf.cost_usd))}</span></StatCell>
        </div>
      </Card>

      {actionError && <Banner tone="bad" className="mb-4">{actionError}</Banner>}

      {wf.status === "planning" && (
        <Card className="mb-4 flex items-center gap-3 px-5 py-4">
          <Loader2 className="size-5 animate-spin text-accent" />
          <div>
            <div className="text-sm font-medium">The planner is drafting tasks for your agents…</div>
            <div className="text-xs text-ink-3">{data?.events.at(-1)?.message ?? "Waiting for the planner"} · submitted {timeAgo(wf.created_at, now)}</div>
          </div>
        </Card>
      )}

      {wf.status === "plan_failed" && (
        <Banner tone="bad" className="mb-4">
          <div className="font-medium">Planning failed — nothing was executed.</div>
          <ul className="mt-1 list-disc pl-4 text-xs">{planErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </Banner>
      )}

      {wf.status === "awaiting_approval" && (
        <Card className="mb-4 border-warn/30">
          <CardHeader title="Review the proposed plan" icon={<ShieldCheck className="size-4 text-warn" />}
            subtitle="Nothing runs until an admin approves. Approval pins each task to the agent spec version active right now." />
          <div className="grid gap-5 px-5 pb-5 lg:grid-cols-3">
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">Acceptance criteria</div>
              <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">{criteria.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">Permissions this plan requires (computed by the backend)</div>
              <div className="space-y-1.5">
                {permissions.map((p) => (
                  <div key={p.tool} className="flex items-center justify-between rounded-lg border border-line bg-panel-2/40 px-3 py-1.5 text-xs">
                    <span className="font-mono text-ink">{p.tool}</span>
                    <span className="flex items-center gap-2 text-ink-3">{p.agents.join(", ")}{p.requires_approval && <Badge tone="warn">approval-gated</Badge>}</span>
                  </div>
                ))}
                {!permissions.length && <div className="text-xs text-ink-3">No tools — agents only reason over the provided context.</div>}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">Decision</div>
              {can("admin") ? (
                <>
                  <Textarea rows={3} placeholder="Optional comment (stored in the audit log)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
                  <div className="mt-2 flex gap-2">
                    <Button variant="success" loading={busy === "approve"} onClick={() => act("approve", () => api.approve(wf.org_id, wf.id, comment || undefined))}>Approve & run</Button>
                    <Button variant="ghost" loading={busy === "reject"} onClick={() => act("reject", () => api.reject(wf.org_id, wf.id, comment || undefined))}>Reject</Button>
                  </div>
                </>
              ) : <p className="text-xs text-ink-3">Only admins and owners can approve plans.</p>}
            </div>
          </div>
        </Card>
      )}

      {wf.forecast != null && <ForecastCard forecast={wf.forecast as unknown as Forecast} wf={wf} now={now} />}

      {tasks.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
          <Card className="flex max-h-[calc(100vh-7rem)] flex-col xl:sticky xl:top-20">
            <div className="space-y-2.5 border-b border-line p-3">
              <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-[#090b14] px-3">
                <Search className="size-4 text-ink-3" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search steps" className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3" />
              </div>
              <Segmented options={[{ id: "all", label: "All" }, { id: "errors", label: "Errors" }, { id: "running", label: "Running" }]} value={filter} onChange={setFilter} />
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {listed.map((t) => (
                <TaskItem key={t.id} task={t} index={tasks.indexOf(t) + 1} executions={execsFor(t.id)} now={now}
                  selected={selectedTask?.id === t.id} onSelect={() => setSelected(t.id)} />
              ))}
              {!listed.length && <p className="py-6 text-center text-xs text-ink-3">No steps match.</p>}
            </div>
          </Card>

          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader title="Execution flow" subtitle="Plan dependencies; arrows show hand-offs between agents" />
              <div className="px-2 pb-2"><PlanDag tasks={tasks} selectedId={selectedTask?.id} onSelect={setSelected} height={290} /></div>
            </Card>

            {selectedTask && (
              <Card>
                <CardHeader title="Execution output" subtitle={<>Step {tasks.indexOf(selectedTask) + 1}: {selectedTask.title}</>}
                  actions={<>
                    {tab === "json" && selectedTask.output != null && <CopyButton text={JSON.stringify(selectedTask.output, null, 2)} />}
                    {tab === "logs" && <CopyButton text={logLines(scopedEvents)} />}
                  </>} />
                <div className="px-5">
                  <Tabs value={tab} onChange={setTab} tabs={[
                    { id: "result", label: "Result" }, { id: "json", label: "JSON" },
                    { id: "verification", label: <span className="flex items-center gap-1.5">Verification {selectedVerification && (selectedVerification.passed ? <CheckCircle2 className="size-3.5 text-ok" /> : <XCircle className="size-3.5 text-bad" />)}</span> },
                    { id: "logs", label: "Logs" }, { id: "artifacts", label: "Artifacts", count: artifactsFor(selectedTask.id).length },
                  ]} />
                </div>
                <div className="p-5">
                  {tab === "result" && (resultArtifact ? <Markdown>{resultArtifact.content}</Markdown> : (
                    <EmptyState icon={<FileText className="size-5" />} title={selectedTask.status === "failed" ? "No verified output" : "No verified output yet"}
                      description={selectedTask.status === "failed" ? selectedTask.error ?? undefined : `Task is ${selectedTask.status.replace("_", " ")}.`} />
                  ))}
                  {tab === "json" && (selectedTask.output != null ? <CodeBlock code={JSON.stringify(selectedTask.output, null, 2)} /> :
                    <EmptyState title="No output stored" description="Only schema-valid results are stored." />)}
                  {tab === "verification" && <VerificationView verification={selectedVerification} />}
                  {tab === "logs" && (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <Segmented options={[{ id: "task", label: "This step" }, { id: "workflow", label: "Whole workflow" }]} value={logScope} onChange={setLogScope} />
                        <span className="text-[11px] text-ink-3">{scopedEvents.length} events</span>
                      </div>
                      <CodeBlock code={logLines(scopedEvents) || "No events yet."} />
                    </div>
                  )}
                  {tab === "artifacts" && (
                    <div className="space-y-2">
                      {artifactsFor(selectedTask.id).map((a) => (
                        <div key={a.id} className="rounded-lg border border-line">
                          <div className="flex items-center gap-3 px-3 py-2">
                            <FileText className="size-4 text-ink-3" />
                            <button onClick={() => setArtifactOpen(artifactOpen === a.id ? null : a.id)} className="min-w-0 flex-1 text-left">
                              <div className="truncate font-mono text-[12.5px] text-ink">{a.name}</div>
                              <div className="text-[11px] text-ink-3">{a.kind} · {a.size_bytes} B · sha256 {a.sha256.slice(0, 12)}…</div>
                            </button>
                            <CopyButton text={a.content} />
                            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(a.name.split("/").pop() ?? "artifact.txt", a.content, "text/plain")}>Download</Button>
                          </div>
                          {artifactOpen === a.id && <div className="border-t border-line p-3">{a.kind === "markdown" ? <Markdown>{a.content}</Markdown> : <CodeBlock code={a.content} />}</div>}
                        </div>
                      ))}
                      {!artifactsFor(selectedTask.id).length && <EmptyState title="No artifacts" description="Artifacts are stored when a task passes verification." />}
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {!tasks.length && wf.status !== "planning" && wf.status !== "plan_failed" && (
        <Card><CardHeader title="Event log" /><div className="px-5 pb-5"><CodeBlock code={logLines(data?.events ?? []) || "No events."} /></div></Card>
      )}
    </div>
  );
}
