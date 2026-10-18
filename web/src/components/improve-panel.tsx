"use client";

import { FlaskConical, GitCompareArrows, Route, Sparkles, Trophy, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/components/providers";
import { Badge, Banner, Button, Card, CardHeader, cx, EmptyState, Input, Modal, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { ApiError, api, type EvalSummary, errorMessage } from "@/lib/api";
import { compact, duration, pct, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type AgentProposal, type AgentVersion, type EvalRun, supabase } from "@/lib/supabase";

type DiffLine = { kind: "same" | "add" | "del"; text: string };

// ponytail: O(n·m) LCS line diff; specs are capped at 64 KB (a few hundred lines), so this stays instant.
function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ kind: "same", text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: x[i++] });
    else out.push({ kind: "add", text: y[j++] });
  }
  while (i < x.length) out.push({ kind: "del", text: x[i++] });
  while (j < y.length) out.push({ kind: "add", text: y[j++] });
  return out;
}

const summaryOf = (run: EvalRun) => (run.status === "completed" ? (run.summary as unknown as EvalSummary) : null);

function Meter({ value, tone }: { value: number; tone: "ok" | "bad" | "accent" }) {
  const color = { ok: "bg-ok", bad: "bg-bad", accent: "bg-accent" }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
      <div className={cx("h-full rounded-full", color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

function EvalVerdict({ s }: { s: EvalSummary }) {
  const better = s.passed > s.baseline_passed, worse = s.passed < s.baseline_passed;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={worse ? "bad" : better ? "ok" : "neutral"}>
        {s.passed}/{s.cases} passed {worse ? "▼" : better ? "▲" : "="} baseline {s.baseline_passed}/{s.cases}
      </Badge>
      <span className="text-[11px] text-ink-3 tabular">
        {s.cost_per_pass != null ? `${usd(s.cost_per_pass)} per pass` : s.total_cost_usd != null ? `${usd(s.total_cost_usd)} total` : "cost not reported"}
        {" · "}{s.replayed_calls} replayed / {s.live_calls} live tool calls
      </span>
    </span>
  );
}

export function ImprovePanel({ orgId, agentId, versions, activeVersionId, isAdmin }: {
  orgId: string; agentId: string; versions: AgentVersion[]; activeVersionId: string | null; isAdmin: boolean;
}) {
  const now = useNow();
  const { status } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string; errors?: string[] } | null>(null);
  const [models, setModels] = useState("");
  const [diffFor, setDiffFor] = useState<AgentProposal | null>(null);
  const [resultsFor, setResultsFor] = useState<EvalRun | null>(null);

  const insights = useLive(() => api.insights(orgId, agentId), [orgId, agentId], { orgId, tables: ["eval_runs", "agent_proposals"] });
  const live = useLive(async () => {
    const [runs, proposals] = await Promise.all([
      supabase.from("eval_runs").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(20).then(unwrap),
      supabase.from("agent_proposals").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(10).then(unwrap),
    ]);
    return { runs, proposals };
  }, [orgId, agentId], { orgId, tables: ["eval_runs", "agent_proposals"] });

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await fn() });
      insights.reload();
      live.reload();
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof ApiError ? e.message : errorMessage(e), errors: e instanceof ApiError ? e.errors : undefined });
    } finally {
      setBusy(null);
    }
  };

  const ins = insights.data;
  const runs = live.data?.runs ?? [];
  const proposals = live.data?.proposals ?? [];
  const f = ins?.failures;
  const routedModel = ins?.routing.model ?? status?.llm.model ?? null;
  const checkMax = Math.max(1, ...Object.values(f?.failed_checks ?? {}));
  const leaderboard = [...(ins?.models ?? [])].sort((a, b) =>
    b.pass_rate - a.pass_rate || (a.cost_per_pass ?? Infinity) - (b.cost_per_pass ?? Infinity));
  const baseOf = (p: AgentProposal) => versions.find((v) => v.id === p.base_version_id);

  return (
    <div className="space-y-4">
      {message && (
        <Banner tone={message.tone}>
          {message.text}
          {message.errors && message.errors.length > 0 && <ul className="mt-1 list-disc pl-4">{message.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </Banner>
      )}
      {insights.error && <Banner tone="bad">Could not load insights: {insights.error}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!ins || !f ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[84px]" />) : (
          <>
            <Stat icon={<Trophy className="size-5" />} accent={f.verified_runs && f.passed / f.verified_runs >= 0.8 ? "ok" : "warn"}
              label="Verified pass rate" value={f.verified_runs ? pct(f.passed, f.verified_runs) : "—"}
              sub={`${f.passed}/${f.verified_runs} verified · last ${f.window} runs`} />
            <Stat icon={<FlaskConical className="size-5" />} label="Regression cases" value={ins.eval_cases}
              sub="Recorded from verified runs, with tool outputs" />
            <Stat icon={<Route className="size-5" />} accent="info" label="Model for next task"
              value={<span className="block max-w-[200px] truncate font-mono text-[15px]" title={routedModel ?? ""}>{routedModel ?? "provider default"}</span>}
              sub={<span title={ins.routing.reason}>{ins.routing.reason}</span>} />
            <Stat icon={<Sparkles className="size-5" />} label="Open proposals"
              value={proposals.filter((p) => p.status === "proposed").length} sub={`${proposals.length} generated`} />
          </>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Failure patterns" icon={<TriangleAlert className="size-4" />}
            subtitle="What verification rejected in recent runs. Infrastructure errors are counted separately." />
          <div className="space-y-4 px-5 pb-5">
            {!f ? <Skeleton className="h-32" /> : f.failed === 0 && f.infra_failures === 0 ? (
              <p className="text-sm text-ink-3">{f.verified_runs ? "No verification failures in recent runs." : "No verified runs yet."}</p>
            ) : (
              <>
                {Object.entries(f.failed_checks).map(([name, n]) => (
                  <div key={name}>
                    <div className="mb-1 flex justify-between text-sm"><span className="text-ink-2">{name.replaceAll("_", " ")}</span><span className="tabular text-ink">{n}×</span></div>
                    <Meter value={n / checkMax} tone="bad" />
                  </div>
                ))}
                {f.unmet_criteria.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium text-ink-3">Criteria the reviewer marked unmet</div>
                    <ul className="space-y-1">
                      {f.unmet_criteria.map((c) => (
                        <li key={c.criterion} className="flex gap-3 text-sm"><span className="w-7 shrink-0 text-right tabular text-ink-3">{c.count}×</span><span className="text-ink-2">{c.criterion}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {f.infra_failures > 0 && (
                  <p className="text-xs text-ink-3">{f.infra_failures} run(s) failed before verification (provider, timeout or budget): {f.infra_errors.filter(Boolean).join(" · ") || "no detail"}</p>
                )}
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Model leaderboard" icon={<Trophy className="size-4" />}
            subtitle="Pass rate and cost per verified task for this agent, from real runs and evaluations." />
          <div className="px-5 pb-5">
            {!ins ? <Skeleton className="h-32" /> : !leaderboard.length ? (
              <p className="text-sm text-ink-3">No verified runs yet. Run a workflow or compare models below.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                      <th className="pb-2">Model</th><th className="w-28 pb-2">Pass rate</th><th className="w-24 pb-2 text-right">Cost / pass</th><th className="w-20 pb-2 text-right">Runs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {leaderboard.map((m) => (
                      <tr key={m.model}>
                        <td className="py-2.5 pr-3">
                          <div className="truncate font-mono text-[12.5px] text-ink" title={m.model}>{m.model}</div>
                          {m.model === routedModel && <Badge tone="info" className="mt-1">next task</Badge>}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="mb-1 text-xs tabular text-ink-2">{pct(m.passed, m.runs)}</div>
                          <Meter value={m.pass_rate} tone={m.pass_rate >= 0.8 ? "ok" : "accent"} />
                        </td>
                        <td className="py-2.5 text-right tabular text-ink-2">{m.cost_per_pass != null ? usd(m.cost_per_pass) : "—"}</td>
                        <td className="py-2.5 text-right text-xs tabular text-ink-3" title={`${m.live_runs} live, ${m.eval_runs} evaluation`}>
                          {m.runs}<div className="text-[10px]">{m.live_runs} live · {m.eval_runs} eval</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-ink-3">Cost per verified task. Turn on auto-routing in Governance → Limits to send tasks to the cheapest model that meets your bar.</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Improvement proposals" icon={<Sparkles className="size-4" />}
          subtitle="A model drafts a revised spec from the failure patterns. It may not add tools or switch verification off; each proposal is evaluated before you decide."
          actions={isAdmin && (
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === "propose"}
              disabled={!f || f.failed === 0} title={f?.failed === 0 ? "No verification failures to learn from yet" : undefined}
              onClick={() => act("propose", async () => {
                const p = await api.proposeRevision(orgId, agentId);
                return p.eval_run_id ? "Proposal drafted. Its evaluation is running against recorded cases." : "Proposal drafted (no evaluation cases yet).";
              })}>
              Propose improvement
            </Button>
          )} />
        <div className="divide-y divide-line">
          {proposals.map((p) => {
            const run = runs.find((r) => r.id === p.eval_run_id);
            const s = run && summaryOf(run);
            const stale = p.base_version_id !== activeVersionId;
            const changes = (p.changes as string[] | null) ?? [];
            return (
              <div key={p.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusBadge status={p.status} />
                  <span className="text-sm font-medium text-ink">Revision of v{baseOf(p)?.version ?? "?"}</span>
                  <span className="text-[11px] text-ink-3">{p.model && <span className="font-mono">{p.model} · </span>}{timeAgo(p.created_at, now)}</span>
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="ghost" icon={<GitCompareArrows className="size-3.5" />} onClick={() => setDiffFor(p)}>Diff</Button>
                    {isAdmin && p.status === "proposed" && (
                      <>
                        <Button size="sm" variant="ghost" loading={busy === `reject-${p.id}`}
                          onClick={() => act(`reject-${p.id}`, async () => { await api.decideProposal(orgId, p.id, "reject"); return "Proposal rejected."; })}>
                          Reject
                        </Button>
                        <Button size="sm" variant="success" loading={busy === `accept-${p.id}`} disabled={stale}
                          title={stale ? "The agent changed since this proposal was made" : undefined}
                          onClick={() => act(`accept-${p.id}`, async () => { await api.decideProposal(orgId, p.id, "accept"); return "Proposal accepted and activated as a new version."; })}>
                          Accept
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{p.rationale}</p>
                {changes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-2">{changes.map((c) => <li key={c}>{c}</li>)}</ul>}
                <div className="mt-3 text-sm">
                  {!p.eval_run_id ? <span className="text-xs text-warn">Not evaluated: this agent had no recorded cases yet.</span>
                    : !run ? <span className="text-xs text-ink-3">Evaluation not in the recent list.</span>
                    : s ? <EvalVerdict s={s} />
                    : run.status === "failed" ? <span className="text-xs text-bad">Evaluation failed: {run.error}</span>
                    : <StatusBadge status={run.status} />}
                </div>
              </div>
            );
          })}
          {live.data && !proposals.length && (
            <EmptyState icon={<Sparkles className="size-5" />} title="No proposals yet"
              description="When verification rejects this agent's work, generate a proposal: a revised spec that targets the recorded failures." />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Evaluations" icon={<FlaskConical className="size-4" />}
          subtitle="Replays recorded cases against a spec or model. Recorded tool calls are answered from the recording; MCP tools never run live."
          actions={isAdmin && (
            <Button loading={busy === "eval"} disabled={!ins?.eval_cases}
              onClick={() => act("eval", async () => { await api.startEval(orgId, agentId, {}); return "Evaluating the active version on the most recent cases."; })}>
              Evaluate active version
            </Button>
          )} />
        <div className="px-5 pb-4">
          {isAdmin && (
            <form className="flex flex-wrap gap-2" onSubmit={(e) => {
              e.preventDefault();
              const list = models.split(/[\s,]+/).filter(Boolean).slice(0, 4);
              if (list.length) void act("compare", async () => { await api.startEval(orgId, agentId, { models: list }); setModels(""); return `Comparing ${list.length} model(s) on the active version.`; });
            }}>
              <Input className="min-w-0 flex-1" value={models} onChange={(e) => setModels(e.target.value)} disabled={!ins?.eval_cases}
                placeholder="Compare models, e.g. openai/gpt-oss-20b:free, meta-llama/llama-3.3-70b-instruct:free" />
              <Button type="submit" icon={<GitCompareArrows className="size-4" />} loading={busy === "compare"} disabled={!models.trim() || !ins?.eval_cases}>Compare</Button>
            </form>
          )}
          {ins && !ins.eval_cases && (
            <p className="mt-3 text-xs text-ink-3">No cases yet. Every time this agent&apos;s output reaches verification, the attempt is frozen as a case (pass or fail) with its tool results.</p>
          )}
        </div>
        <div className="divide-y divide-line border-t border-line">
          {runs.map((r) => {
            const s = summaryOf(r);
            const v = versions.find((x) => x.source_md === r.source_md);
            const label = r.kind === "proposal" ? "Proposal" : v ? `v${v.version}${v.id === activeVersionId ? " (active)" : ""}` : "Draft spec";
            return (
              <button key={r.id} type="button" onClick={() => setResultsFor(r)}
                className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-white/[0.02]">
                <StatusBadge status={r.status} />
                <span className="text-sm text-ink">{label}</span>
                {r.model && <span className="max-w-[240px] truncate font-mono text-[12px] text-ink-2">{r.model}</span>}
                <span className="flex-1">{s ? <EvalVerdict s={s} /> : r.error ? <span className="text-xs text-bad">{r.error}</span> : null}</span>
                <span className="text-[11px] text-ink-3 tabular">{duration(r.started_at, r.completed_at, now)} · {timeAgo(r.created_at, now)}</span>
              </button>
            );
          })}
          {live.data && !runs.length && <p className="px-5 py-4 text-sm text-ink-3">No evaluations yet.</p>}
        </div>
      </Card>

      <Modal open={!!diffFor} onClose={() => setDiffFor(null)} wide title={`Proposed changes to v${diffFor ? baseOf(diffFor)?.version ?? "?" : ""}`}>
        {diffFor && <SpecDiff before={baseOf(diffFor)?.source_md ?? ""} after={diffFor.source_md} />}
      </Modal>
      <Modal open={!!resultsFor} onClose={() => setResultsFor(null)} wide title="Evaluation results">
        {resultsFor && <RunResults key={resultsFor.id} run={resultsFor} />}
      </Modal>
    </div>
  );
}

function SpecDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const added = lines.filter((l) => l.kind === "add").length, removed = lines.filter((l) => l.kind === "del").length;
  return (
    <>
      <p className="mb-2 text-xs text-ink-3"><span className="text-ok">+{added}</span> / <span className="text-bad">−{removed}</span> lines</p>
      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-[#080912] py-2 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={cx("px-3", l.kind === "add" && "bg-ok/10 text-ok", l.kind === "del" && "bg-bad/10 text-bad", l.kind === "same" && "text-ink-3")}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}{l.text || " "}
          </div>
        ))}
      </pre>
    </>
  );
}

function RunResults({ run }: { run: EvalRun }) {
  const { data, error } = useLive(async () => {
    const results = await supabase.from("eval_results").select("*").eq("eval_run_id", run.id).order("created_at").then(unwrap);
    const ids = results.map((r) => r.eval_case_id).filter((x): x is string => !!x);
    const cases = ids.length ? await supabase.from("eval_cases").select("id, title, baseline").in("id", ids).then(unwrap) : [];
    return { results, cases };
  }, [run.id]);
  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!data) return <Skeleton className="h-40" />;
  if (!data.results.length) return <p className="text-sm text-ink-3">{run.status === "running" || run.status === "queued" ? "Running…" : "No results."}</p>;
  return (
    <div className="divide-y divide-line">
      {data.results.map((r) => {
        const c = data.cases.find((x) => x.id === r.eval_case_id);
        const baseline = (c?.baseline as { passed?: boolean } | null)?.passed;
        const checks = ((r.verification as { checks?: { name: string; passed: boolean; detail: string }[] } | null)?.checks ?? []);
        return (
          <div key={r.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={r.passed ? "ok" : "bad"}>{r.passed ? "Pass" : "Fail"}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{c?.title ?? "Case"}</span>
              {baseline !== undefined && <span className="text-[11px] text-ink-3">baseline {baseline ? "pass" : "fail"}</span>}
              <span className="text-[11px] text-ink-3 tabular">{compact(r.tokens)} tokens{r.cost_usd != null && ` · ${usd(Number(r.cost_usd))}`}</span>
            </div>
            {checks.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {checks.map((ch) => <Badge key={ch.name} tone={ch.passed ? "ok" : "bad"}><span title={ch.detail}>{ch.passed ? "✓" : "✕"} {ch.name.replaceAll("_", " ")}</span></Badge>)}
              </div>
            )}
            {r.error && <p className="mt-1.5 text-xs text-bad">{r.error}</p>}
          </div>
        );
      })}
    </div>
  );
}
