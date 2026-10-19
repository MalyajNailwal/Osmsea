"use client";

import { Brain, Check, ExternalLink, GitPullRequest, Plus, Search } from "lucide-react";
import { useState } from "react";
import { AiClientsSection, SandboxCard } from "@/components/ai-clients";
import { McpServersSection } from "@/components/mcp-servers";
import { useApp } from "@/components/providers";
import { Badge, Banner, Button, Card, cx, Field, Input, Modal, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage, type ProviderInfo } from "@/lib/api";
import { compact, timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type Integration, supabase } from "@/lib/supabase";

const DAY = 86_400_000;

function countOf(res: { count: number | null; error: { message: string } | null }): number {
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

export default function IntegrationsPage() {
  const { org, can, catalog, reloadStatus } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const isAdmin = can("admin");
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [secret, setSecret] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data, error, reload } = useLive(async () => {
    if (!orgId) return null;
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [integrations, agents, working, tasks, reviews, workflows] = await Promise.all([
      supabase.from("integrations").select("*").eq("org_id", orgId).then(unwrap),
      supabase.from("agents").select("id, status").eq("org_id", orgId).then(unwrap),
      supabase.from("tasks").select("agent_id").eq("org_id", orgId).in("status", ["running", "verifying"]).then(unwrap),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", since).then(countOf),
      supabase.from("approvals").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "pending").then(countOf),
      supabase.from("workflows").select("tokens_used").eq("org_id", orgId).gte("created_at", since).then(unwrap),
    ]);
    const busyAgents = new Set(working.map((t) => t.agent_id));
    const activeAgents = agents.filter((a) => a.status === "active");
    return {
      integrations, tasks, reviews, tokens: workflows.reduce((s, w) => s + (w.tokens_used ?? 0), 0),
      working: activeAgents.filter((a) => busyAgents.has(a.id)).length,
      idle: activeAgents.filter((a) => !busyAgents.has(a.id)).length,
    };
  }, [orgId], { orgId, tables: ["agents", "tasks", "approvals", "workflows"] });

  const rowFor = (p: ProviderInfo) => data?.integrations.find((i) => i.provider === p.id);

  const open = (p: ProviderInfo) => {
    const row = rowFor(p);
    const current = (row?.config ?? {}) as Record<string, string>;
    setEditing(p);
    setSecret("");
    setConfig(Object.fromEntries(Object.keys(p.config_fields).map((k) => [k, current[k] ?? ""])));
    setMessage(null);
  };

  const act = async (key: string, fn: () => Promise<string>) => {
    if (!orgId) return;
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await fn() });
      await reload();
      await reloadStatus();
    } catch (e) {
      setMessage({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = () => editing && act("save", async () => {
    await api.saveIntegration(orgId!, editing.id, { secret: secret.trim() || undefined, config });
    setEditing(null);
    setSecret("");
    return `${editing.name} saved. The credential is stored in Supabase Vault.`;
  });
  const test = (p: ProviderInfo) => act(`test-${p.id}`, async () => {
    const row = await api.testIntegration(orgId!, p.id);
    return `${p.name}: ${row.last_test_ok ? "test passed" : "test failed"}${row.last_test_message ? ` (${row.last_test_message})` : ""}`;
  });
  const remove = (p: ProviderInfo) => {
    if (!window.confirm(`Remove ${p.name}? Its stored credential is deleted from Vault, and features that depend on it stop working.`)) return;
    void act(`remove-${p.id}`, async () => {
      await api.deleteIntegration(orgId!, p.id);
      return `${p.name} removed.`;
    });
  };

  if (!org) return null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <Card className="mb-6 flex flex-wrap items-center gap-x-10 gap-y-3 px-5 py-3">
        <span className="text-sm font-medium text-ok">{data ? `${data.working} working, ${data.idle} idle` : "—"}</span>
        {[["Tasks", data?.tasks], ["Review requests", data?.reviews], ["Tokens", data ? compact(data.tokens) : undefined]].map(([label, value]) => (
          <div key={label as string} className="text-center">
            <div className="text-[15px] font-semibold tabular text-ink">{value ?? "—"}</div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3">{label} · 30d</div>
          </div>
        ))}
      </Card>

      <PageHeader title="Integrations" subtitle="Manage API keys and credentials for your agents and integrations." />
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      {message && <Banner tone={message.tone} className="mb-4">{message.text}</Banner>}

      <section>
        <h2 className="text-lg font-semibold">Service integrations</h2>
        <p className="mt-1 mb-5 text-sm text-ink-2">
          Credentials are encrypted in Supabase Vault and read only by the backend when a model or tool call needs them. They are never sent back to the browser.
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {!catalog && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}
          {catalog?.providers.map((p) => (
            <ProviderCard key={p.id} provider={p} row={rowFor(p)} isAdmin={isAdmin} busy={busy} now={now}
              onConfigure={() => open(p)} onTest={() => test(p)} onRemove={() => remove(p)} />
          ))}
        </div>
      </section>

      <McpServersSection />
      <AiClientsSection />
      <SandboxCard />

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Configure ${editing.name}` : ""} footer={
        <>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === "save"} onClick={save}
            disabled={!!editing && !rowFor(editing) && secret.trim().length < 8}>Save</Button>
        </>
      }>
        {editing && (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">{editing.description}</p>
            <Field label={editing.secret_label} hint="Stored encrypted in Supabase Vault. It is never shown again.">
              <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder={rowFor(editing) ? "Leave blank to keep the current key" : "Paste the key"} />
            </Field>
            {Object.entries(editing.config_fields).map(([field, placeholder]) => (
              <Field key={field} label={field.replaceAll("_", " ")} hint={`Default: ${placeholder}`}>
                <Input value={config[field] ?? ""} placeholder={placeholder}
                  onChange={(e) => setConfig((c) => ({ ...c, [field]: e.target.value }))} />
              </Field>
            ))}
            <a href={editing.docs_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-[#a99fff] hover:underline">
              Get a key from the developer portal <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ProviderCard({ provider: p, row, isAdmin, busy, now, onConfigure, onTest, onRemove }: {
  provider: ProviderInfo; row?: Integration; isAdmin: boolean; busy: string | null; now: number;
  onConfigure: () => void; onTest: () => void; onRemove: () => void;
}) {
  const Icon = p.kind === "llm" ? Brain : p.kind === "code" ? GitPullRequest : Search;
  const cfg = (row?.config ?? {}) as Record<string, string>;
  const failed = row?.last_test_ok === false;
  return (
    <Card className={cx("flex flex-col p-5", row && !failed && "border-ok/30", failed && "border-bad/30")}>
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl border border-line bg-panel-2"><Icon className="size-5 text-[#a99fff]" /></div>
        <div>
          <div className="text-[17px] font-semibold text-ink">{p.name}</div>
          <div className={cx("text-xs", failed ? "text-bad" : row ? "text-ok" : "text-ink-3")}>
            {failed ? "Last test failed" : row ? "Configured" : "Not configured"}
          </div>
        </div>
        <Badge className="ml-auto">{p.kind === "llm" ? "Model provider" : p.kind === "code" ? "Code delivery" : "Search"}</Badge>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between rounded-md bg-[#161616] px-3 py-2 font-mono text-[12px]">
          <span className="text-ink-2">{p.secret_label}</span>
          {row ? <span className="flex items-center gap-1.5 text-ink-3">••••{row.secret_hint}<Check className="size-3.5 text-ok" /></span> : <span className="text-ink-3">—</span>}
        </div>
        {Object.entries(p.config_fields).map(([field, placeholder]) => (
          <div key={field} className="flex items-center justify-between gap-3 rounded-md bg-[#161616] px-3 py-2 font-mono text-[12px]">
            <span className="shrink-0 text-ink-2">{field.toUpperCase()}</span>
            <span className={cx("truncate", cfg[field] ? "text-ink" : "text-ink-3")} title={cfg[field] || placeholder}>
              {cfg[field] || `default · ${placeholder}`}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-4 text-[13px] text-ink-2">{p.description}</p>
      <a href={p.docs_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-[13px] text-[#a99fff] hover:underline">
        Open developer portal <ExternalLink className="size-3" />
      </a>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {p.enables.map((e) => <Badge key={e} tone="accent">{e}</Badge>)}
      </div>
      {row?.last_tested_at && (
        <p className={cx("mt-3 text-[11px]", failed ? "text-bad" : "text-ink-3")}>
          Tested {timeAgo(row.last_tested_at, now)}{row.last_test_message ? ` · ${row.last_test_message}` : ""}
        </p>
      )}

      <div className="mt-auto flex gap-2 pt-5">
        {!isAdmin ? <span className="text-xs text-ink-3">Admins manage integrations.</span> : row ? (
          <>
            <Button size="sm" variant="primary" onClick={onConfigure}>Edit</Button>
            <Button size="sm" loading={busy === `test-${p.id}`} onClick={onTest}>Test</Button>
            <Button size="sm" variant="danger" loading={busy === `remove-${p.id}`} onClick={onRemove}>Remove</Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={onConfigure}>Configure</Button>
        )}
      </div>
    </Card>
  );
}

