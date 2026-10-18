"use client";

import { CheckCircle2, GitFork, XCircle } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { compact, timeAgo, usd } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type Execution, type Replay, supabase } from "@/lib/supabase";
import { SpecDiff } from "./improve-panel";
import { useApp } from "./providers";
import { Badge, Banner, Button, CodeBlock, Input, Modal, Segmented, Skeleton, StatusBadge, Textarea } from "./ui";

type Check = { name: string; passed: boolean; detail: string };
type Step = { n: number; type: string; tool?: string; ok?: boolean; replayed?: boolean };
type View = "verification" | "output" | "steps" | "spec";

/** "Replay" on a past attempt: re-run it against its recorded tool results with an edited spec or another model. */
export function ReplayButton({ execution }: { execution: Execution }) {
  const { can } = useApp();
  const [open, setOpen] = useState(false);
  if (!can("member") || !execution.agent_id) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-white/5 hover:text-ink"
        title="Re-run this attempt with an edited spec or another model">
        <GitFork className="size-3" /> Replay
      </button>
      <Modal open={open} onClose={() => setOpen(false)} wide title={`Replay attempt ${execution.attempt}`}>
        {open && <ReplayPanel execution={execution} />}
      </Modal>
    </>
  );
}

function ReplayPanel({ execution }: { execution: Execution }) {
  const now = useNow();
  const [draft, setDraft] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [view, setView] = useState<View>("verification");

  const { data } = useLive(async () => {
    const [versions, replays] = await Promise.all([
      execution.agent_version_id
        ? supabase.from("agent_versions").select("version, source_md").eq("id", execution.agent_version_id).then(unwrap) : Promise.resolve([]),
      supabase.from("replays").select("*").eq("execution_id", execution.id).order("created_at", { ascending: false }).then(unwrap),
    ]);
    return { version: versions[0] ?? null, replays };
  }, [execution.id], { orgId: execution.org_id, tables: ["replays"] });

  const original = data?.version?.source_md ?? "";
  const source = draft ?? original;
  const recorded = ((execution.tool_recordings as unknown[] | null) ?? []).length;
  const usedTools = ((execution.steps as Step[] | null) ?? []).some((s) => s.type === "tool");
  const selected = data?.replays.find((r) => r.id === compare) ?? null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const row = await api.replay(execution.org_id, execution.id, {
        ...(draft !== null && draft !== original ? { source_md: draft } : {}), ...(model.trim() ? { model: model.trim() } : {}),
      });
      setCompare(row.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-3">
        Runs this attempt again in a sandbox: tool calls that match the original are answered from its recording ({recorded} recorded),
        new calls to read-only tools run live, MCP tools never run, and no real task, memory or audit row is touched.
        Verification, including tests and the independent review, runs as in production.
      </p>
      {!recorded && usedTools && <Banner tone="warn">This attempt predates tool recording, so its tools will run live and results may differ.</Banner>}
      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium text-ink-2">Spec{data.version ? ` (v${data.version.version} as used)` : ""}</span>
          {draft !== null && draft !== original && <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Reset</Button>}
        </div>
        <Textarea rows={10} spellCheck={false} value={source} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[12px] leading-relaxed" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" value={model} onChange={(e) => setModel(e.target.value)} placeholder={`Model (default: ${execution.model ?? "the agent's model"})`} />
        <Button variant="primary" icon={<GitFork className="size-4" />} loading={busy} onClick={run}>Run replay</Button>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}

      {data.replays.length > 0 && (
        <div className="divide-y divide-line rounded-lg border border-line">
          {data.replays.map((r) => (
            <button key={r.id} onClick={() => setCompare(r.id)}
              className={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-white/[0.03] ${r.id === compare ? "bg-accent/[0.06]" : ""}`}>
              <StatusBadge status={r.status} />
              {r.passed != null && <Badge tone={r.passed ? "ok" : "bad"}>{r.passed ? "verified" : "failed verification"}</Badge>}
              <span className="font-mono text-ink-2">{r.model ?? execution.model ?? "default model"}</span>
              {r.source_md !== original && <Badge tone="accent">edited spec</Badge>}
              <span className="ml-auto text-ink-3 tabular">
                {compact(r.tokens)} tok{r.cost_usd != null && ` · ${usd(Number(r.cost_usd))}`} · {r.replayed} replayed / {r.live_calls} live · {timeAgo(r.created_at, now)}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div>
          <Segmented value={view} onChange={setView} options={[
            { id: "verification", label: "Verification" }, { id: "output", label: "Output" }, { id: "steps", label: "Steps" }, { id: "spec", label: "Spec diff" },
          ]} />
          <div className="mt-3">
            {selected.status !== "completed" && selected.status !== "failed" ? <p className="text-sm text-ink-3">Replay {selected.status}…</p>
              : selected.status === "failed" ? <Banner tone="bad">{selected.error}</Banner>
              : view === "spec" ? <SpecDiff before={original} after={selected.source_md} />
              : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Side title={`Original · ${execution.status}`} view={view} verification={execution.verification} output={execution.output} steps={execution.steps} />
                  <Side title={`Replay · ${selected.passed ? "verified" : "not verified"}`} view={view} verification={selected.verification}
                    output={selected.output} steps={selected.steps} error={selected.error} />
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

function Side({ title, view, verification, output, steps, error }: {
  title: string; view: View; verification: Replay["verification"]; output: Replay["output"]; steps: Replay["steps"]; error?: string | null;
}) {
  const checks = ((verification as { checks?: Check[] } | null)?.checks ?? []);
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel-2/40 p-3">
      <div className="mb-2 text-xs font-medium text-ink-2">{title}</div>
      {view === "verification" && (checks.length ? (
        <div className="space-y-1.5">
          {checks.map((c) => (
            <div key={c.name} className="flex items-start gap-2 text-xs">
              {c.passed ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-bad" />}
              <div className="min-w-0"><div className="text-ink">{c.name.replaceAll("_", " ")}</div><div className="break-words text-[11px] text-ink-3">{c.detail}</div></div>
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-ink-3">{error ?? "Not verified."}</p>)}
      {view === "output" && (output != null ? <CodeBlock code={JSON.stringify(output, null, 2)} maxHeight="22rem" className="text-[11px]" />
        : <p className="text-xs text-ink-3">No schema-valid output.</p>)}
      {view === "steps" && (
        <ol className="space-y-1 text-[11.5px]">
          {((steps as Step[] | null) ?? []).map((s) => (
            <li key={s.n} className="flex items-center gap-2">
              <span className="w-5 text-right text-ink-3 tabular">{s.n}</span>
              <span className="font-mono text-ink-2">{s.tool ?? s.type}</span>
              {s.replayed && <Badge>replayed</Badge>}
              {s.ok === false ? <XCircle className="ml-auto size-3.5 text-bad" /> : <CheckCircle2 className="ml-auto size-3.5 text-ok" />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
