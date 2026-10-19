"use client";

import { Clock, Play, Plus, Trash2, Webhook, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/providers";
import {
  Badge, Banner, Button, Card, CodeBlock, CopyButton, EmptyState, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton,
  StatusBadge, Textarea, Toggle,
} from "@/components/ui";
import { API_URL, api, errorMessage } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase, type Trigger } from "@/lib/supabase";

const UNIT = { minutes: 1, hours: 60, days: 1440, weeks: 10080 } as const;
type Unit = keyof typeof UNIT;
type Form = { name: string; kind: "schedule" | "webhook"; goal: string; startAt: string; every: number; unit: Unit; requireApproval: boolean };

const EXAMPLES: Omit<Form, "startAt">[] = [
  { name: "Weekly HTTP client brief", kind: "schedule", every: 1, unit: "weeks", requireApproval: true,
    goal: "Research what changed this week in the httpx and requests Python libraries (releases, security advisories) and summarize it with sources." },
  { name: "Triage new issues", kind: "webhook", every: 1, unit: "days", requireApproval: true,
    goal: "Triage the issue in the event: summarize the problem, research likely causes in the official docs, and propose next steps." },
];

function every(minutes: number | null): string {
  if (!minutes) return "";
  for (const [unit, size] of [["week", 10080], ["day", 1440], ["hour", 60]] as const) {
    if (minutes % size === 0) return minutes === size ? `every ${unit}` : `every ${minutes / size} ${unit}s`;
  }
  return `every ${minutes} min`;
}

function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const hookUrl = (id: string) => `${API_URL}/hooks/${id}`;

export default function AutomationsPage() {
  const { org, can } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const isAdmin = can("admin");
  const [form, setForm] = useState<Form | null>(null);
  const [created, setCreated] = useState<{ trigger: Trigger; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data, error, reload } = useLive(async () => {
    if (!orgId) return null;
    const triggers = await supabase.from("triggers").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).then(unwrap);
    const ids = triggers.map((t) => t.last_workflow_id).filter((x): x is string => !!x);
    const runs = ids.length ? await supabase.from("workflows").select("id, status").in("id", ids).then(unwrap) : [];
    return { triggers, runs };
  }, [orgId], { orgId, tables: ["triggers", "workflows"] });

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ tone: "ok", text });
      reload();
    } catch (e) {
      setMessage({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const open = (preset?: Omit<Form, "startAt">) => setForm({
    name: "", kind: "schedule", goal: "", every: 1, unit: "days", requireApproval: true, ...preset,
    startAt: localInput(new Date(Date.now() + 5 * 60_000)),
  });

  const minutes = form ? form.every * UNIT[form.unit] : 0;
  const formError = !form ? null : form.name.trim().length < 1 ? "Name it" : form.goal.trim().length < 3 ? "Describe the goal"
    : form.kind === "schedule" && (minutes < 15 || minutes > 525_600) ? "Repeat every 15 minutes to 365 days" : null;

  const save = () => form && act("create", async () => {
    const row = await api.createTrigger(org!.id, {
      name: form.name.trim(), kind: form.kind, goal: form.goal.trim(), require_approval: form.requireApproval,
      ...(form.kind === "schedule" ? { interval_minutes: minutes, start_at: new Date(form.startAt).toISOString() } : {}),
    });
    setForm(null);
    if (row.secret) setCreated({ trigger: row, secret: row.secret });
    return `“${row.name}” created.`;
  });

  if (!org) return null;
  const triggers = data?.triggers ?? [];

  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader title="Automations" subtitle="Run goals on a schedule or from a webhook. Each run is planned, permission-checked and verified."
        actions={isAdmin && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open()}>New automation</Button>} />
      {message && <Banner tone={message.tone} className="mb-4">{message.text}</Banner>}
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}

      <div className="space-y-3">
        {!data ? <Skeleton className="h-32" /> : triggers.map((t) => {
          const run = data.runs.find((r) => r.id === t.last_workflow_id);
          const Icon = t.kind === "schedule" ? Clock : Webhook;
          return (
            <Card key={t.id} className="p-5">
              <div className="flex flex-wrap items-start gap-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-[#a99fff]"><Icon className="size-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{t.name}</span>
                    <Badge tone="accent">{t.kind === "schedule" ? every(t.interval_minutes) : "Webhook"}</Badge>
                    {t.require_approval ? <Badge tone="warn">Plans need approval</Badge> : <Badge>Runs without approval</Badge>}
                    {!t.enabled && <Badge>Paused</Badge>}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm text-ink-2">{t.goal}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[11.5px] text-ink-3">
                    {t.kind === "schedule" ? (
                      <span>Next run <span className="text-ink-2">{t.enabled ? dateTime(t.next_run_at) : "paused"}</span></span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-ink-2">{hookUrl(t.id)}</span>
                        <CopyButton text={hookUrl(t.id)} label="Copy URL" />
                        <span>secret {t.secret_prefix}…</span>
                      </span>
                    )}
                    <span>
                      Last run <span className="text-ink-2">{timeAgo(t.last_run_at, now)}</span>
                      {run && <> · <Link href={`/tasks/${run.id}`} className="underline hover:text-ink">workflow</Link> <StatusBadge status={run.status} /></>}
                    </span>
                    <span>{t.runs} run(s)</span>
                  </div>
                  {t.last_error && <p className="mt-2 text-xs text-warn">{t.last_error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {isAdmin && (
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      <Toggle checked={t.enabled} label="Enabled" disabled={!!busy}
                        onChange={(v) => act(`toggle-${t.id}`, async () => { await api.updateTrigger(org.id, t.id, { enabled: v }); return `“${t.name}” ${v ? "resumed" : "paused"}.`; })} />
                      Enabled
                    </label>
                  )}
                  {can("member") && (
                    <Button size="sm" icon={<Play className="size-3.5" />} loading={busy === `run-${t.id}`}
                      onClick={() => act(`run-${t.id}`, async () => { await api.runTrigger(org.id, t.id); return `“${t.name}” started. Follow it in Tasks & Runs.`; })}>
                      Run now
                    </Button>
                  )}
                  {isAdmin && (
                    <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} loading={busy === `delete-${t.id}`} aria-label={`Delete ${t.name}`}
                      onClick={() => window.confirm(`Delete “${t.name}”?${t.kind === "webhook" ? " Its URL stops working." : ""}`) &&
                        act(`delete-${t.id}`, async () => { await api.deleteTrigger(org.id, t.id); return `“${t.name}” deleted.`; })} />
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {data && !triggers.length && (
          <Card>
            <EmptyState icon={<Zap className="size-5" />} title="No automations yet"
              description="Turn the organization into an always-on team: a weekly research brief, or triage whenever a system posts an event."
              action={isAdmin && (
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((e) => <Button key={e.name} icon={e.kind === "schedule" ? <Clock className="size-4" /> : <Webhook className="size-4" />} onClick={() => open(e)}>{e.name}</Button>)}
                </div>
              )} />
          </Card>
        )}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title="New automation" wide
        footer={<>
          <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === "create"} disabled={!!formError} title={formError ?? undefined} onClick={save}>Create</Button>
        </>}>
        {form && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Name" className="min-w-[240px] flex-1">
                <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Weekly competitor brief" />
              </Field>
              <Segmented value={form.kind} onChange={(kind) => setForm({ ...form, kind })}
                options={[{ id: "schedule", label: "Schedule" }, { id: "webhook", label: "Webhook" }]} />
            </div>
            <Field label="Goal" hint="Planned like any goal you submit. For webhooks, the event payload is shown to the planner as untrusted data.">
              <Textarea rows={4} maxLength={4000} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
            </Field>
            {form.kind === "schedule" && (
              <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
                <Field label="First run (your local time)">
                  <Input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} />
                </Field>
                <Field label="Repeat every">
                  <Input type="number" min={1} className="w-24" value={String(form.every)} onChange={(e) => setForm({ ...form, every: Math.max(1, Number(e.target.value)) })} />
                </Field>
                <Field label="Unit">
                  <Select className="w-32" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value as Unit })}>
                    {Object.keys(UNIT).map((u) => <option key={u} value={u}>{u}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel-2/50 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-ink">Plans need approval</div>
                <div className="text-xs text-ink-3">Each run waits for an admin before any task executes. A run is skipped while the previous one is still active.</div>
              </div>
              <Toggle label="Plans need approval" checked={form.requireApproval} onChange={(v) => setForm({ ...form, requireApproval: v })} />
            </div>
            {form.kind === "webhook" && !form.requireApproval && (
              <Banner tone="warn">Anyone with the webhook secret can then start work without review. Keep approval on unless the sender is fully trusted.</Banner>
            )}
            {formError && <p className="text-xs text-ink-3">{formError}</p>}
          </div>
        )}
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} wide title={`Webhook “${created?.trigger.name ?? ""}” is ready`}
        footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        {created && (
          <div className="space-y-4">
            <Banner tone="warn">Copy the secret now: OSMSEA stores only a hash, so it is shown once.</Banner>
            <Field label="Secret">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-[#161616] px-3 py-2 font-mono text-[12px] text-ink">{created.secret}</code>
                <CopyButton text={created.secret} />
              </div>
            </Field>
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">Call it (any JSON or text body, up to 64 KB)</div>
              <CodeBlock code={`curl -X POST ${hookUrl(created.trigger.id)} \\\n  -H "Authorization: Bearer ${created.secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"issue": {"title": "Crash on start", "body": "..."}}'`} />
            </div>
            <p className="text-xs text-ink-3">
              Services that cannot set headers (for example GitHub webhooks) can use <span className="font-mono">{hookUrl(created.trigger.id)}?token=…</span> with
              content type application/json. The URL must be reachable from the sender: for local development use a tunnel.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
