"use client";

import { Bot, Box, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { API_URL, api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useApp } from "./providers";
import { Badge, Banner, Button, Card, CodeBlock, CopyButton, Input, Modal, Segmented, Skeleton } from "./ui";

const MCP_URL = `${API_URL}/mcp`;
type Client = "claude-code" | "cursor" | "claude-desktop";

function snippet(client: Client, token: string): string {
  if (client === "claude-code") return `claude mcp add --transport http osmsea ${MCP_URL} \\\n  --header "Authorization: Bearer ${token}"`;
  if (client === "cursor") {
    return JSON.stringify({ mcpServers: { osmsea: { url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { osmsea: {
    command: "npx", args: ["mcp-remote", MCP_URL, "--header", "Authorization:${OSMSEA_AUTH}"], env: { OSMSEA_AUTH: `Bearer ${token}` },
  } } }, null, 2);
}

const WHERE: Record<Client, string> = {
  "claude-code": "Run in a terminal.",
  cursor: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
  "claude-desktop": "Add to claude_desktop_config.json (Settings → Developer → Edit config). Requires Node for npx.",
};

export function AiClientsSection() {
  const { org, can } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const isAdmin = can("admin");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [client, setClient] = useState<Client>("claude-code");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data: tokens, reload } = useLive(async () => {
    if (!orgId) return [];
    return supabase.from("api_tokens").select("id, name, prefix, created_at, last_used_at, revoked_at").eq("org_id", orgId)
      .order("created_at", { ascending: false }).then(unwrap);
  }, [orgId], { orgId, tables: ["api_tokens"] });

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

  if (!orgId) return null;
  const active = (tokens ?? []).filter((t) => !t.revoked_at);

  return (
    <section className="mt-8">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-ink">Connect AI clients</h2>
        <p className="text-sm text-ink-3">
          OSMSEA is itself an MCP server. Claude Code, Cursor, Claude Desktop or any MCP client can hand goals to this organization
          and read verified results. Clients cannot approve plans, change agents or see credentials.
        </p>
      </div>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel-2/40 px-3.5 py-2.5">
          <Bot className="size-4 text-[#a99fff]" />
          <span className="text-xs text-ink-3">MCP endpoint</span>
          <span className="font-mono text-[12.5px] text-ink">{MCP_URL}</span>
          <span className="ml-auto flex flex-wrap gap-1.5 text-[11px]">
            {["list_agents", "submit_goal", "get_workflow", "search_memory"].map((t) => <Badge key={t}>{t}</Badge>)}
          </span>
        </div>
        {message && <Banner tone={message.tone} className="mt-3">{message.text}</Banner>}

        {isAdmin && (
          <form className="mt-4 flex flex-wrap gap-2" onSubmit={(e) => {
            e.preventDefault();
            void act("create", async () => {
              const row = await api.createToken(orgId, name.trim());
              setCreated({ name: row.name, token: row.token });
              setName("");
            });
          }}>
            <Input className="min-w-0 flex-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
              placeholder="Token name, e.g. “Claude Code on my laptop”" />
            <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy === "create"} disabled={!name.trim()}>
              Create token
            </Button>
          </form>
        )}

        <div className="mt-4 divide-y divide-line rounded-lg border border-line">
          {!tokens ? <Skeleton className="h-12" /> : tokens.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-3">No tokens yet. A token acts with the member role of the admin who created it.</p>
          ) : tokens.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <KeyRound className="size-4 text-ink-3" />
              <span className="text-sm text-ink">{t.name}</span>
              <span className="font-mono text-[11.5px] text-ink-3">{t.prefix}…</span>
              {t.revoked_at ? <Badge>Revoked</Badge> : <Badge tone="ok" dot>Active</Badge>}
              <span className="ml-auto text-[11px] text-ink-3">created {timeAgo(t.created_at, now)} · last used {timeAgo(t.last_used_at, now)}</span>
              {isAdmin && !t.revoked_at && (
                <Button size="sm" variant="danger" loading={busy === t.id}
                  onClick={() => window.confirm(`Revoke “${t.name}”? Clients using it stop working immediately.`) &&
                    act(t.id, async () => { await api.revokeToken(orgId, t.id); return `“${t.name}” revoked.`; })}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
        {active.length > 0 && <p className="mt-2 text-[11px] text-ink-3">{active.length} active token(s). Every goal submitted with a token is audited as token:&lt;name&gt;.</p>}
      </Card>

      <Modal open={!!created} onClose={() => setCreated(null)} wide title={`Token “${created?.name ?? ""}” created`}
        footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        {created && (
          <div className="space-y-4">
            <Banner tone="warn">Copy it now: OSMSEA stores only a hash, so this token is shown once.</Banner>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-[#080912] px-3 py-2 font-mono text-[12px] text-ink">{created.token}</code>
              <CopyButton text={created.token} />
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <Segmented value={client} onChange={setClient} options={[
                  { id: "claude-code", label: "Claude Code" }, { id: "cursor", label: "Cursor" }, { id: "claude-desktop", label: "Claude Desktop" },
                ]} />
                <CopyButton text={snippet(client, created.token)} label="Copy config" />
              </div>
              <p className="mb-2 text-xs text-ink-3">{WHERE[client]}</p>
              <CodeBlock code={snippet(client, created.token)} />
            </div>
            <p className="text-xs text-ink-3">Then ask your assistant, for example: “Ask my OSMSEA org to compare httpx and requests and wait for the verified result.”</p>
          </div>
        )}
      </Modal>
    </section>
  );
}

export function SandboxCard() {
  const { status } = useApp();
  const s = status?.sandbox;
  return (
    <Card className="mt-4 flex flex-wrap items-center gap-4 p-5">
      <div className="grid size-10 place-items-center rounded-xl border border-line bg-panel-2 text-[#a99fff]"><Box className="size-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">Code sandbox</span>
          {!s ? <Skeleton className="h-5 w-16" /> : s.available ? <Badge tone="ok" dot>Ready</Badge> : <Badge tone="warn" dot>Unavailable</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-ink-3">
          Agents with <span className="font-mono">run_tests</span> have their tests executed during verification in Docker
          ({s?.image ?? "osmsea-sandbox"}): no network, read-only filesystem, unprivileged, 512 MB, 60 s.
        </p>
        {s && !s.available && <p className="mt-1 font-mono text-[11.5px] text-warn">{s.detail}</p>}
      </div>
    </Card>
  );
}
