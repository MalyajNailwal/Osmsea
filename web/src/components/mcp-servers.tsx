"use client";

import { Check, Copy, KeyRound, Plus, RefreshCw, ServerCog, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, type McpToolInfo } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type McpServer, supabase } from "@/lib/supabase";
import { useApp } from "./providers";
import { Badge, Banner, Button, Card, cx, EmptyState, Field, Input, Modal, Skeleton, StatusBadge, Toggle } from "./ui";

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 24);
}

function ServerCard({ server, isAdmin, onChanged }: { server: McpServer; isAdmin: boolean; onChanged: (msg: string) => void }) {
  const now = useNow();
  const catalog = (server.tool_catalog as McpToolInfo[] | null) ?? [];
  const info = (server.server_info as { name?: string; version?: string; protocol?: string } | null) ?? {};
  const [approved, setApproved] = useState<string[] | null>(null); // null = unchanged from server
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = approved ?? server.approved_tools;
  const dirty = approved !== null && [...approved].sort().join() !== [...server.approved_tools].sort().join();

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    try {
      onChanged(await fn());
      setApproved(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const orgId = server.org_id;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-[#a99fff]"><ServerCog className="size-5" /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{server.name}</span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{server.slug}</span>
              <StatusBadge status={server.status === "connected" ? "active" : server.status === "error" ? "failed" : server.status} />
            </div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3" title={server.url}>{server.url}</div>
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy === "refresh"}
              onClick={() => act("refresh", async () => {
                const row = await api.refreshMcpServer(orgId, server.id);
                return row.status === "connected" ? `${server.name}: ${(row.tool_catalog as unknown[]).length} tool(s) discovered.` : `${server.name}: ${row.last_error}`;
              })}>Refresh tools</Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} loading={busy === "remove"}
              onClick={() => window.confirm(`Remove ${server.name}? Agents lose access to its tools and its credential is deleted from Vault.`) &&
                act("remove", async () => { await api.deleteMcpServer(orgId, server.id); return `${server.name} removed.`; })}>Remove</Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-ink-3">
        <span>Server: <span className="text-ink-2">{info.name ? `${info.name} ${info.version ?? ""}` : "—"}</span></span>
        <span>Protocol: <span className="text-ink-2">{info.protocol ?? "—"}</span></span>
        <span>Checked: <span className="text-ink-2">{timeAgo(server.last_checked_at, now)}</span></span>
        <span className="flex items-center gap-1"><KeyRound className="size-3" />{server.secret_hint ? `${server.auth_header}: ••••${server.secret_hint}` : "no credential"}</span>
      </div>
      {server.last_error && <Banner tone="bad" className="mt-3 text-xs">{server.last_error}</Banner>}
      {error && <Banner tone="bad" className="mt-3 text-xs">{error}</Banner>}

      <div className="mt-4 flex flex-wrap items-center gap-6 rounded-lg border border-line bg-panel-2/40 px-3.5 py-2.5 text-xs">
        <label className="flex items-center gap-2 text-ink-2">
          <Toggle checked={server.status !== "disabled"} disabled={!isAdmin || !!busy} label="Enabled"
            onChange={(v) => act("enabled", async () => { await api.updateMcpServer(orgId, server.id, { enabled: v }); return `${server.name} ${v ? "enabled" : "disabled"}.`; })} />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-ink-2">
          <Toggle checked={server.require_approval} disabled={!isAdmin || !!busy} label="Plans need approval"
            onChange={(v) => act("approval", async () => { await api.updateMcpServer(orgId, server.id, { require_approval: v }); return `${server.name}: plans using its tools ${v ? "now require" : "no longer require"} approval.`; })} />
          Plans using these tools need approval
        </label>
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            <Input type="password" className="h-8 w-56 text-xs" placeholder={server.secret_hint ? "Replace credential" : "Add credential"}
              value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            <Button size="sm" disabled={!secret.trim()} loading={busy === "secret"}
              onClick={() => act("secret", async () => {
                await api.updateMcpServer(orgId, server.id, { secret: secret.trim() });
                setSecret("");
                await api.refreshMcpServer(orgId, server.id);
                return `${server.name}: credential stored in Vault and tools re-discovered.`;
              })}>Save</Button>
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium text-ink-2">
            Discovered tools <span className="text-ink-3">· {current.length} of {catalog.length} approved for agents</span>
          </div>
          {isAdmin && dirty && (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setApproved(null)}>Discard</Button>
              <Button size="sm" variant="primary" loading={busy === "approve"}
                onClick={() => act("approve", async () => { await api.updateMcpServer(orgId, server.id, { approved_tools: current }); return `${server.name}: tool approvals saved.`; })}>
                Save approvals
              </Button>
            </div>
          )}
        </div>
        {catalog.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3">
            No tools discovered{server.status === "error" ? " (connection failed)" : ""}.
          </p>
        ) : (
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {catalog.map((t) => {
              const on = current.includes(t.name);
              const osmName = `mcp__${server.slug}__${t.name}`;
              return (
                <div key={t.name} className={cx("flex items-start gap-3 px-3.5 py-2.5", on && "bg-accent/[0.05]")}>
                  <input type="checkbox" className="mt-1 size-4 accent-[#7c6cff]" checked={on} disabled={!isAdmin || !t.approvable}
                    aria-label={`Approve ${t.name}`}
                    onChange={() => setApproved(on ? current.filter((x) => x !== t.name) : [...current, t.name])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] text-ink">{t.name}</span>
                      {!t.approvable && <Badge tone="warn">name not usable</Badge>}
                      {on && server.approved_tools.includes(t.name) && <Badge tone="ok"><Check className="size-3" />approved</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-3">{t.description || "No description."}</p>
                    {on && (
                      <button className="mt-1 flex items-center gap-1 font-mono text-[11px] text-[#a99fff] hover:underline"
                        onClick={() => void navigator.clipboard.writeText(osmName)} title="Copy the name agents use in allowed_tools">
                        <Copy className="size-3" />{osmName}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

export function McpServersSection() {
  const { org, can } = useApp();
  const orgId = org?.id;
  const isAdmin = can("admin");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", url: "", auth_header: "Authorization", secret: "", require_approval: true });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data, error, reload } = useLive(async () => {
    if (!orgId) return [];
    return supabase.from("mcp_servers").select("*").eq("org_id", orgId).order("created_at").then(unwrap);
  }, [orgId], { orgId, tables: ["mcp_servers"] });

  const changed = (msg: string) => { setMessage(msg); reload(); };

  const submit = async () => {
    if (!orgId) return;
    setBusy(true);
    setFormError(null);
    try {
      const row = await api.createMcpServer(orgId, {
        name: form.name.trim(), slug: form.slug.trim(), url: form.url.trim(), auth_header: form.auth_header.trim() || "Authorization",
        secret: form.secret.trim() || undefined, require_approval: form.require_approval,
      });
      setAdding(false);
      setForm({ name: "", slug: "", url: "", auth_header: "Authorization", secret: "", require_approval: true });
      changed(row.status === "connected"
        ? `${row.name} connected: ${(row.tool_catalog as unknown[]).length} tool(s) discovered. Approve the ones agents may use.`
        : `${row.name} registered, but discovery failed: ${row.last_error}`);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP servers</h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            Connect remote Model Context Protocol servers (Streamable HTTP). OSMSEA discovers their tools, but agents can use only the
            tools you approve, named <span className="font-mono text-[12.5px]">mcp__server__tool</span> in an agent&apos;s allowed tools.
            Credentials stay in Supabase Vault, every call is audited, and tool output is treated as untrusted.
          </p>
        </div>
        {isAdmin && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setAdding(true); setFormError(null); }}>Add MCP server</Button>}
      </div>
      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}
      {message && <Banner tone="info" className="mb-4">{message}</Banner>}
      <div className="space-y-4">
        {!data && <Skeleton className="h-40 rounded-2xl" />}
        {data?.map((s) => <ServerCard key={`${s.id}:${s.updated_at}`} server={s} isAdmin={isAdmin} onChanged={changed} />)}
        {data && data.length === 0 && (
          <Card><EmptyState icon={<ServerCog className="size-5" />} title="No MCP servers connected"
            description="Add a server to give agents approved third-party tools, for example a documentation or ticketing server." /></Card>
        )}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add MCP server" footer={
        <>
          <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim() || !form.slug.trim() || !form.url.trim()} onClick={submit}>
            Connect &amp; discover tools
          </Button>
        </>
      }>
        <div className="space-y-3.5">
          <Field label="Name"><Input value={form.name} placeholder="DeepWiki"
            onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || slugify(e.target.value) })} /></Field>
          <Field label="Slug" hint="Lowercase letters, digits and hyphens. Becomes part of tool names: mcp__slug__tool.">
            <Input value={form.slug} placeholder="deepwiki" onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="Server URL" hint="Streamable HTTP endpoint. Must be a public https URL.">
            <Input value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <Field label="Auth header"><Input value={form.auth_header} onChange={(e) => setForm({ ...form, auth_header: e.target.value })} /></Field>
            <Field label="Credential (optional)" hint="Stored encrypted in Vault; never shown again.">
              <Input type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Toggle checked={form.require_approval} onChange={(v) => setForm({ ...form, require_approval: v })} label="Require approval" />
            Plans that use this server&apos;s tools always need approval (recommended)
          </label>
          {formError && <Banner tone="bad">{formError}</Banner>}
        </div>
      </Modal>
    </section>
  );
}

