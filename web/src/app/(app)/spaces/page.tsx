"use client";

import { AtSign, ExternalLink, Plus, SendHorizontal, Settings2, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AgentFace, PersonFace, personaHex } from "@/components/agent-face";
import { CreateAgentModal } from "@/components/create-agent";
import { useApp } from "@/components/providers";
import { Badge, Banner, Button, cx, EmptyState, Field, Input, Markdown, Modal, Select, Skeleton, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type SpaceMessage, supabase } from "@/lib/supabase";

type AgentInfo = { id: string; name: string; slug: string; role: string; color: string; tagline: string; status: string };

const STARTERS = [
  { name: "Family trip", description: "Plans, bookings and the holiday pot", agents: ["trip-planner", "budget-keeper"] },
  { name: "Marketing", description: "Posts, campaigns and what competitors are doing", agents: ["content-writer", "market-scout"] },
  { name: "Support desk", description: "Customer answers straight from our docs", agents: ["support-agent", "meeting-scribe"] },
  { name: "Engineering", description: "Code reviews and data questions", agents: ["code-reviewer", "data-analyst"] },
];
const STARTER_COLORS: Record<string, string> = {
  "trip-planner": "blue", "budget-keeper": "yellow", "content-writer": "pink", "market-scout": "red", "support-agent": "teal",
  "meeting-scribe": "violet", "code-reviewer": "green", "data-analyst": "orange",
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", "").toLowerCase();

function dayLabel(iso: string, now: number): string {
  const d = new Date(iso), today = new Date(now);
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

const personName = (label: string) => {
  const local = label.replace(/@.*/, "").replace(/[._-]+/g, " ");
  return local.charAt(0).toUpperCase() + local.slice(1);
};

// Models often end a list without a blank line; Markdown would then fold the next sentence into the last item.
const tidy = (text: string) => text.replace(/^((?:[-*]|\d+\.) .*)\n(?!(?:[-*]|\d+\.) |\s*$)/gm, "$1\n\n");

function argSummary(args: unknown): string {
  if (args && typeof args === "object") {
    const first = Object.values(args as Record<string, unknown>).find((v) => typeof v === "string");
    if (typeof first === "string") return first;
  }
  return JSON.stringify(args ?? {});
}

function SpaceIcon({ colors }: { colors: string[] }) {
  return (
    <span className="grid size-full grid-cols-2 place-items-center gap-1 p-2.5">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="size-[18px] rounded-full" style={{ background: colors[i] ? personaHex(colors[i]) : "rgba(255,255,255,0.06)" }} />
      ))}
    </span>
  );
}

export default function SpacesPage() {
  const { org, can, session } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const me = session?.user.id ?? "";
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("s"));
  const [draft, setDraft] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [spaceModal, setSpaceModal] = useState<"new" | "edit" | null>(null);
  const [agentModal, setAgentModal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const { data: base, reload: reloadBase } = useLive(async () => {
    if (!orgId || !me) return null;
    const [spaces, links, agents, reads] = await Promise.all([
      supabase.from("spaces").select("*").eq("org_id", orgId).order("last_message_at", { ascending: false }).then(unwrap),
      supabase.from("space_agents").select("space_id, agent_id").eq("org_id", orgId).then(unwrap),
      supabase.from("agents").select("id, name, slug, role, status, active_version_id").eq("org_id", orgId).then(unwrap),
      supabase.from("space_reads").select("space_id, last_read_at").eq("user_id", me).then(unwrap),
    ]);
    const versionIds = agents.map((a) => a.active_version_id).filter((x): x is string => !!x);
    const versions = versionIds.length ? await supabase.from("agent_versions").select("id, spec").in("id", versionIds).then(unwrap) : [];
    const info: AgentInfo[] = agents.map((a) => {
      const persona = ((versions.find((v) => v.id === a.active_version_id)?.spec as { persona?: { color?: string; tagline?: string } } | null)?.persona) ?? {};
      return { id: a.id, name: a.name, slug: a.slug, role: a.role, status: a.status, color: persona.color ?? "gray", tagline: persona.tagline ?? a.role };
    });
    const unread = Object.fromEntries(await Promise.all(spaces.map(async (s) => {
      const since = reads.find((r) => r.space_id === s.id)?.last_read_at ?? "1970-01-01T00:00:00Z";
      const res = await supabase.from("space_messages").select("id", { count: "exact", head: true }).eq("space_id", s.id)
        .is("thread_id", null).gt("created_at", since).neq("author_id", me);
      return [s.id, res.count ?? 0] as const;
    })));
    return { spaces, links, agents: info, unread };
  }, [orgId, me], { orgId, tables: ["spaces", "space_agents", "agents", "space_messages"] });

  const spaces = useMemo(() => base?.spaces ?? [], [base]);
  const sid = selected && spaces.some((s) => s.id === selected) ? selected : spaces[0]?.id ?? null;
  const space = spaces.find((s) => s.id === sid) ?? null;
  const agentsIn = (spaceId: string) => (base?.links ?? []).filter((l) => l.space_id === spaceId)
    .map((l) => base?.agents.find((a) => a.id === l.agent_id)).filter((a): a is AgentInfo => !!a && a.status === "active");
  const agentById = (id: string | null) => base?.agents.find((a) => a.id === id);
  const members = space ? agentsIn(space.id) : [];
  const primary = space ? agentById(space.primary_agent_id) : undefined;

  const { data: messages } = useLive(async () => {
    if (!sid) return [];
    return supabase.from("space_messages").select("*").eq("space_id", sid).order("created_at").limit(500).then(unwrap);
  }, [sid], { orgId, tables: ["space_messages"] });

  const top = (messages ?? []).filter((m) => !m.thread_id);
  const threadOf = (id: string) => (messages ?? []).filter((m) => m.thread_id === id);
  const lastId = top.at(-1)?.id;

  useEffect(() => {  // keep the newest message in view, and mark the space read
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    if (orgId && sid && lastId) void api.markRead(orgId, sid).then(() => reloadBase(), () => {});
  }, [orgId, sid, lastId, top.length, reloadBase]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = () => {
    const content = draft.trim();
    if (!content || !orgId || !sid) return;
    setDraft("");
    setMentionOpen(false);
    void act("send", async () => { await api.postMessage(orgId, sid, content); });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const quickStart = (starter: (typeof STARTERS)[number]) => act(`starter-${starter.name}`, async () => {
    const ids: string[] = [];
    for (const slug of starter.agents) {
      const existing = base?.agents.find((a) => a.slug === slug);
      ids.push(existing ? existing.id : (await api.addLibraryAgent(orgId!, slug)).id);
    }
    const created = await api.createSpace(orgId!, { name: starter.name, description: starter.description, agent_ids: ids, primary_agent_id: ids[0] });
    setSelected(created.id);
    reloadBase();
  });

  if (!org) return null;
  const canPost = can("member");

  return (
    <div className="mx-auto max-w-[1400px]">
      {error && <Banner tone="bad" className="mb-3">{error}</Banner>}
      <div className="surface grid h-[calc(100vh-7.5rem)] min-h-[560px] grid-cols-[84px_minmax(0,1fr)] overflow-hidden">
        {/* Space rail */}
        <aside className="flex flex-col items-center gap-3 overflow-y-auto border-r border-line bg-[#0c0e16] py-4">
          {spaces.map((s) => {
            const colors = agentsIn(s.id).map((a) => a.color);
            const unread = s.id === sid ? 0 : base?.unread[s.id] ?? 0;
            return (
              <button key={s.id} title={s.name} onClick={() => { setSelected(s.id); setExpanded(new Set()); }}
                className={cx("relative size-14 shrink-0 rounded-2xl border transition-colors",
                  s.id === sid ? "border-white/20 bg-[#1b1e2b]" : "border-transparent bg-[#151824] hover:bg-[#1b1e2b]")}>
                {s.id === sid && <span className="absolute -left-[15px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-white" />}
                <SpaceIcon colors={colors} />
                {unread > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold text-white">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </button>
            );
          })}
          {canPost && (
            <button title="New space" onClick={() => setSpaceModal("new")}
              className="grid size-14 shrink-0 place-items-center rounded-2xl border border-dashed border-white/20 text-ink-3 hover:border-white/40 hover:text-ink">
              <Plus className="size-5" />
            </button>
          )}
        </aside>

        {/* Conversation */}
        {!base ? <div className="p-6"><Skeleton className="h-full" /></div> : !space ? (
          <div className="flex flex-col items-center justify-center overflow-y-auto p-8 text-center">
            <div className="mb-4 flex -space-x-2"><AgentFace color="blue" size={44} /><AgentFace color="yellow" size={44} /><AgentFace color="pink" size={44} /></div>
            <h1 className="text-2xl font-semibold tracking-tight">Talk to your agents</h1>
            <p className="mt-2 max-w-lg text-sm text-ink-2">
              A space is a group chat for people and agents. Mention an agent to ask it something; agents consult each other,
              ask before using sensitive tools, and hand bigger work to verified workflows.
            </p>
            {can("admin") ? (
              <div className="mt-6 grid w-full max-w-2xl gap-3 sm:grid-cols-2">
                {STARTERS.map((st) => (
                  <button key={st.name} disabled={!!busy} onClick={() => void quickStart(st)}
                    className="surface flex items-center gap-3 p-4 text-left transition-colors hover:border-line-strong disabled:opacity-60">
                    <span className="size-12 shrink-0 rounded-xl bg-[#151824]"><SpaceIcon colors={st.agents.map((slug) => STARTER_COLORS[slug])} /></span>
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{busy === `starter-${st.name}` ? "Setting up…" : st.name}</span>
                      <span className="block text-xs text-ink-3">{st.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : <p className="mt-4 text-xs text-ink-3">Ask an admin to create a space.</p>}
            {canPost && <Button className="mt-4" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSpaceModal("new")}>Blank space</Button>}
          </div>
        ) : (
          <section className="flex min-h-0 flex-col">
            <header className="flex items-center gap-3 border-b border-line px-6 py-4">
              {primary ? <AgentFace color={primary.color} size={40} /> : <Users className="size-6 text-ink-3" />}
              <div className="flex min-w-0 items-baseline gap-3">
                <h1 className="truncate text-[17px] font-semibold text-ink">{space.name}</h1>
                <span className="hidden h-5 w-px self-center bg-line-strong sm:block" />
                <span className="hidden truncate text-sm text-ink-3 sm:block">{space.description || primary?.tagline}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="hidden -space-x-1.5 md:flex">{members.map((a) => <AgentFace key={a.id} color={a.color} size={26} title={a.name} className="ring-2 ring-[#12141d]" />)}</div>
                {canPost && <Button size="sm" variant="ghost" icon={<Settings2 className="size-4" />} onClick={() => setSpaceModal("edit")}>Agents</Button>}
              </div>
            </header>

            <div ref={scroller} className="flex-1 overflow-y-auto px-6 py-4">
              {!messages ? <Skeleton className="h-40" /> : top.length === 0 ? (
                <EmptyState icon={<Sparkles className="size-5" />} title="Start the conversation"
                  description={members.length ? `Try “${members[0].name}, …” or @${members[0].slug}. Messages that mention nobody go to ${primary?.name ?? "the primary agent"}.`
                    : "Add an agent to this space first."} />
              ) : top.map((m, i) => {
                const prev = top[i - 1];
                const newDay = !prev || dayLabel(prev.created_at, now) !== dayLabel(m.created_at, now);
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="my-4 flex items-center gap-4 text-xs font-semibold text-ink-3">
                        <span className="h-px flex-1 bg-line" />{dayLabel(m.created_at, now)}<span className="h-px flex-1 bg-line" />
                      </div>
                    )}
                    <MessageRow m={m} me={me} agent={agentById(m.author_id)} withAgent={agentById((m.data as { with_id?: string })?.with_id ?? null)}
                      thread={threadOf(m.id)} expanded={expanded.has(m.id)} canDecide={can("admin")} busy={busy}
                      onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                      onDecide={(allow, remember) => act(`decide-${m.id}`, async () => { await api.decideTool(org.id, m.id, allow, remember); })}
                      agentColor={(id) => agentById(id)?.color} />
                  </div>
                );
              })}
            </div>

            <div className="px-6 pb-5">
              <div className="relative rounded-2xl border border-line-strong bg-[#0b0d14]">
                {mentionOpen && members.length > 0 && (
                  <div className="absolute bottom-full left-3 mb-2 w-64 overflow-hidden rounded-xl border border-line-strong bg-panel-2 shadow-xl">
                    {members.map((a) => (
                      <button key={a.id} onClick={() => { setDraft((d) => `${d.replace(/@$/, "")}@${a.slug} `); setMentionOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-white/5">
                        <AgentFace color={a.color} size={22} /><span className="text-ink">{a.name}</span><span className="ml-auto font-mono text-[11px] text-ink-3">@{a.slug}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea value={draft} rows={2} disabled={!canPost} onKeyDown={onKey}
                  onChange={(e) => { setDraft(e.target.value); setMentionOpen(e.target.value.endsWith("@")); }}
                  placeholder={canPost ? `Message ${primary?.name ?? space.name}` : "Viewers can read but not post"}
                  className="w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] text-ink outline-none placeholder:text-ink-3" />
                <div className="flex items-center gap-1 px-3 pb-3">
                  <button title="Mention an agent" onClick={() => setMentionOpen((v) => !v)} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/5 hover:text-ink"><AtSign className="size-[18px]" /></button>
                  <button title="Agents in this space" onClick={() => setSpaceModal("edit")} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/5 hover:text-ink"><Users className="size-[18px]" /></button>
                  <span className="ml-auto mr-2 text-xs text-ink-3">Enter to send</span>
                  <button aria-label="Send" onClick={send} disabled={!draft.trim() || busy === "send"}
                    className="grid size-9 place-items-center rounded-lg bg-white/10 text-ink transition-colors hover:bg-white/15 disabled:opacity-40">
                    {busy === "send" ? <Spinner /> : <SendHorizontal className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {spaceModal && base && (
        <SpaceModal key={`${spaceModal}-${sid}`} mode={spaceModal} orgId={org.id} space={spaceModal === "edit" ? space : null}
          agents={base.agents.filter((a) => a.status === "active")} current={spaceModal === "edit" && space ? members.map((a) => a.id) : []}
          canDelete={can("admin")} canCreateAgents={can("admin")} onAddAgent={() => setAgentModal(true)}
          onClose={() => setSpaceModal(null)}
          onSaved={(id) => { setSpaceModal(null); if (id) setSelected(id); reloadBase(); }} />
      )}
      <CreateAgentModal orgId={org.id} open={agentModal} onClose={() => setAgentModal(false)}
        existingSlugs={new Set((base?.agents ?? []).map((a) => a.slug))}
        onCreated={() => { setAgentModal(false); reloadBase(); }} />
    </div>
  );
}

function MessageRow({ m, me, agent, withAgent, thread, expanded, canDecide, busy, onToggle, onDecide, agentColor }: {
  m: SpaceMessage; me: string; agent?: AgentInfo; withAgent?: AgentInfo; thread: SpaceMessage[]; expanded: boolean; canDecide: boolean;
  busy: string | null; onToggle: () => void; onDecide: (allow: boolean, remember?: boolean) => void; agentColor: (id: string | null) => string | undefined;
}) {
  const data = (m.data ?? {}) as Record<string, unknown>;
  const isAgent = m.author_kind === "agent";
  const name = isAgent ? m.author_label : m.author_kind === "system" ? "OSMSEA" : m.author_id === me ? "You" : personName(m.author_label);
  const face = isAgent ? <AgentFace color={agent?.color} size={40} />
    : m.author_kind === "system" ? <span className="grid size-10 place-items-center rounded-full bg-accent/20 text-[#b4abff]"><Sparkles className="size-4" /></span>
    : <PersonFace label={m.author_id === me ? "You" : m.author_label} size={40} />;

  return (
    <div className="flex gap-3.5 py-2.5">
      {face}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">{name}</span>
          {isAgent && <span className="rounded bg-white/8 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">Bot</span>}
          <span className="text-xs text-ink-3">{clock(m.created_at)}</span>
        </div>

        {m.kind === "text" && (m.status === "thinking" ? (
          <div className="mt-1 flex items-center gap-1.5 text-sm text-ink-3">
            <span>{typeof data.activity === "string" ? `is ${data.activity}` : "is thinking"}</span>
            <span className="flex gap-0.5">{[0, 1, 2].map((d) => <span key={d} className="size-1 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${d * 150}ms` }} />)}</span>
          </div>
        ) : m.author_kind === "user" || m.status === "failed"  // people's messages stay verbatim; agent replies may use Markdown
          ? <p className={cx("mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-relaxed", m.status === "failed" ? "text-bad/90" : "text-ink")}>{m.content}</p>
          : <Markdown className="chat-markdown mt-0.5 break-words text-ink">{tidy(m.content)}</Markdown>)}

        {m.kind === "collaboration" && (
          <div className="mt-1.5">
            <button onClick={onToggle} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex -space-x-2">
                <AgentFace color={agent?.color} size={24} className="ring-2 ring-[#12141d]" />
                <AgentFace color={withAgent?.color ?? (data.with_color as string)} size={24} className="ring-2 ring-[#12141d]" />
              </span>
              <span className="font-medium text-[#a9a2ff] hover:underline">{m.content}</span>
              {typeof data.last_reply_at === "string" && <span className="text-xs text-ink-3">Last reply {clock(data.last_reply_at)}</span>}
              <Badge tone={m.status === "done" ? "neutral" : m.status === "failed" ? "bad" : "accent"}>{m.status === "done" ? "Done" : m.status === "failed" ? "Failed" : "Working…"}</Badge>
            </button>
            {expanded && (
              <div className="mt-2 space-y-2 border-l-2 border-line pl-4">
                {thread.map((t) => (
                  <div key={t.id} className="flex gap-2.5">
                    <AgentFace color={agentColor(t.author_id)} size={24} />
                    <div className="min-w-0">
                      <div className="text-xs"><span className="font-semibold text-ink">{t.author_label}</span> <span className="text-ink-3">{clock(t.created_at)}</span></div>
                      <Markdown className="chat-markdown compact break-words text-ink-2">{tidy(t.content)}</Markdown>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {m.kind === "approval" && (
          <div className="mt-2 max-w-xl rounded-xl border border-line-strong bg-[#08090f] p-4">
            <div className="flex gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white/8 text-sm font-semibold text-ink">{String(data.tool_label ?? "?").charAt(0).toUpperCase()}</span>
              <div className="min-w-0">
                <div className="text-sm text-ink-3">{m.content}</div>
                <div className="mt-0.5 break-words font-semibold text-ink">{argSummary(data.args)}</div>
                <div className="mt-1 text-[11px] text-ink-3">{String(data.description ?? "")}</div>
              </div>
            </div>
            {m.status === "pending" ? (canDecide ? (
              <div className="mt-3 flex gap-2 pl-11">
                <Button size="sm" variant="primary" loading={busy === `decide-${m.id}`} onClick={() => onDecide(true)}>Allow</Button>
                <Button size="sm" disabled={busy === `decide-${m.id}`} onClick={() => onDecide(true, true)} title={`Don't ask again for ${String(data.tool_label ?? "this tool")} in this reply`}>
                  Allow for this reply
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === `decide-${m.id}`} onClick={() => onDecide(false)}>Deny</Button>
              </div>
            ) : <p className="mt-3 pl-11 text-xs text-ink-3">Waiting for an admin to allow or deny.</p>)
              : <p className={cx("mt-3 pl-11 text-xs", m.status === "allowed" ? "text-ok" : "text-ink-3")}>
                  {m.status === "allowed" ? (data.for_reply ? "Allowed for this reply" : "Allowed") : "Denied"}{typeof data.decided_by === "string" ? ` by ${data.decided_by}` : ""}
                </p>}
          </div>
        )}

        {m.kind === "workflow" && (
          <div className="mt-2 max-w-xl rounded-xl border border-line bg-panel-2/40 p-3.5">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              {m.author_kind === "agent" ? "Started a verified workflow" : "Workflow result"}
              <Badge tone={data.status === "completed" ? "ok" : data.status === "failed" ? "bad" : "accent"}>
                {typeof data.status === "string" ? data.status : "in progress"}
              </Badge>
              {typeof data.workflow_id === "string" && (
                <Link href={`/tasks/${data.workflow_id}`} className="ml-auto flex items-center gap-1 text-[#a9a2ff] hover:underline">Open <ExternalLink className="size-3" /></Link>
              )}
            </div>
            <Markdown className="chat-markdown compact mt-1.5 break-words text-ink">{tidy(m.content)}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function SpaceModal({ mode, orgId, space, agents, current, canDelete, canCreateAgents, onAddAgent, onClose, onSaved }: {
  mode: "new" | "edit"; orgId: string; space: { id: string; name: string; description: string; primary_agent_id: string | null } | null;
  agents: AgentInfo[]; current: string[]; canDelete: boolean; canCreateAgents: boolean; onAddAgent: () => void; onClose: () => void;
  onSaved: (id: string | null) => void;
}) {
  const [name, setName] = useState(space?.name ?? "");
  const [description, setDescription] = useState(space?.description ?? "");
  const [picked, setPicked] = useState<string[]>(current);
  const [primary, setPrimary] = useState<string>(space?.primary_agent_id ?? current[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), agent_ids: picked, primary_agent_id: picked.includes(primary) ? primary : picked[0] ?? null };
      const row = mode === "new" ? await api.createSpace(orgId, body) : await api.updateSpace(orgId, space!.id, body);
      onSaved(row.id);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} wide title={mode === "new" ? "New space" : `${space?.name ?? "Space"} · agents`}
      footer={<>
        {mode === "edit" && canDelete && (
          <Button variant="danger" className="mr-auto" onClick={() => window.confirm("Delete this space and its messages?") &&
            void api.deleteSpace(orgId, space!.id).then(() => onSaved(null), (e) => setError(errorMessage(e)))}>Delete space</Button>
        )}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>{mode === "new" ? "Create space" : "Save"}</Button>
      </>}>
      <div className="space-y-4">
        {error && <Banner tone="bad">{error}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Family trip" /></Field>
          <Field label="Description"><Input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Flights, stays and the holiday pot" /></Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-ink-2">
            Agents in this space
            {canCreateAgents && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onAddAgent}>New agent</Button>}
          </div>
          <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
            {agents.map((a) => {
              const on = picked.includes(a.id);
              return (
                <button key={a.id} onClick={() => setPicked((p) => on ? p.filter((x) => x !== a.id) : [...p, a.id])}
                  className={cx("flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors",
                    on ? "border-accent/50 bg-accent/[0.08]" : "border-line hover:border-line-strong")}>
                  <AgentFace color={a.color} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                    <span className="block truncate text-[11px] text-ink-3">{a.tagline}</span>
                  </span>
                  <span className={cx("ml-auto size-4 shrink-0 rounded border", on ? "border-accent bg-accent" : "border-line-strong")} />
                </button>
              );
            })}
          </div>
        </div>
        {picked.length > 1 && (
          <Field label="Answers messages that mention nobody">
            <Select value={primary} onChange={(e) => setPrimary(e.target.value)}>
              {picked.map((id) => <option key={id} value={id}>{agents.find((a) => a.id === id)?.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
