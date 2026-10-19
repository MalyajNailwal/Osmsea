"use client";

import { ArrowUp, AtSign, ChevronDown, ExternalLink, Plus, Search, Settings2, Sparkles } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AgentFace, PersonFace, personaHex } from "@/components/agent-face";
import { CreateAgentModal } from "@/components/create-agent";
import { useApp } from "@/components/providers";
import { Banner, Button, cx, EmptyState, Field, Input, Markdown, Modal, Select, Skeleton, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { type SpaceMessage, supabase } from "@/lib/supabase";

type AgentInfo = { id: string; name: string; slug: string; role: string; color: string; tagline: string; status: string };
type LastMessage = Pick<SpaceMessage, "content" | "author_kind" | "author_id" | "status" | "kind" | "data">;

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
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

const listTime = (iso: string, now: number) => {
  const day = dayLabel(iso, now);
  return day === "Today" ? clock(iso) : day === "Yesterday" ? day : new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
};

const personName = (label: string) => {
  const local = label.replace(/@.*/, "").replace(/[._-]+/g, " ");
  return local.charAt(0).toUpperCase() + local.slice(1);
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

// Models often end a list without a blank line; Markdown would then fold the next sentence into the last item.
const tidy = (text: string) => text.replace(/^((?:[-*]|\d+\.) .*)\n(?!(?:[-*]|\d+\.) |\s*$)/gm, "$1\n\n");

function preview(m: LastMessage | undefined, me: string): string {
  if (!m) return "No messages yet";
  if (m.status === "thinking") return "Typing…";
  const data = (m.data ?? {}) as Record<string, unknown>;
  if (m.kind === "approval" && m.status === "pending") return `Waiting for approval: ${str(data.tool_label) || "a tool"}`;
  const text = m.content.replace(/[*_`#>|]+/g, "").replace(/\s+/g, " ").trim();
  return m.author_kind === "user" && m.author_id === me ? `You: ${text}` : text;
}

function argSummary(args: unknown): string {
  if (args && typeof args === "object") {
    const first = Object.values(args as Record<string, unknown>).find((v) => typeof v === "string");
    if (typeof first === "string") return first;
  }
  return JSON.stringify(args ?? {});
}

/** One face for a one-agent space, a little cluster of up to three for a group. */
function SpaceAvatar({ colors, size = 48 }: { colors: string[]; size?: number }) {
  if (colors.length <= 1) return <AgentFace color={colors[0]} size={size} />;
  const f = Math.round(size * 0.58), far = size - f;
  const spots = colors.length === 2 ? [[0, 0], [far, far]] : [[far / 2, 0], [0, far], [far, far]];
  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }}>
      {spots.map(([x, y], i) => (
        <span key={i} className="absolute rounded-full ring-2 ring-sidebar" style={{ left: x, top: y }}><AgentFace color={colors[i]} size={f} /></span>
      ))}
    </span>
  );
}

const PILL: Record<string, [string, string]> = {
  done: ["Done", "bg-ok/10 text-ok"], completed: ["Done", "bg-ok/10 text-ok"], allowed: ["Allowed", "bg-ok/10 text-ok"],
  failed: ["Failed", "bg-bad/10 text-bad"], timed_out: ["Timed out", "bg-bad/10 text-bad"], denied: ["Denied", "bg-white/5 text-ink-3"],
  cancelled: ["Cancelled", "bg-white/5 text-ink-3"], pending: ["Needs approval", "bg-warn/10 text-warn"],
  awaiting_approval: ["Awaiting approval", "bg-warn/10 text-warn"],
};

function Pill({ status }: { status: string }) {
  const [label, tone] = PILL[status] ?? ["Working", "bg-white/[0.06] text-ink-2"];
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", tone)}>
      <span className={cx("size-1.5 rounded-full bg-current", label === "Working" && "animate-pulse")} />{label}
    </span>
  );
}

function Thinking({ color, activity }: { color?: string; activity: string }) {
  return (
    <div className="flex h-8 items-center gap-2.5 text-[15px] text-ink-3">
      <span className="flex gap-1">
        {[0, 1, 2].map((d) => (
          <span key={d} className="size-2 animate-pulse rounded-full" style={{ background: personaHex(color), opacity: 0.45 + d * 0.25, animationDelay: `${d * 180}ms` }} />
        ))}
      </span>
      {activity ? activity.charAt(0).toUpperCase() + activity.slice(1) : "Thinking"}
    </div>
  );
}

export default function SpacesPage() {
  const { org, can, session } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const me = session?.user.id ?? "";
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("s"));
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [spaceModal, setSpaceModal] = useState<"new" | "edit" | null>(null);
  const [agentModal, setAgentModal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

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
    // ponytail: two small queries per space; fine for tens of spaces, move to one RPC if lists get long
    const meta = Object.fromEntries(await Promise.all(spaces.map(async (s) => {
      const since = reads.find((r) => r.space_id === s.id)?.last_read_at ?? "1970-01-01T00:00:00Z";
      const [unread, last] = await Promise.all([
        supabase.from("space_messages").select("id", { count: "exact", head: true }).eq("space_id", s.id)
          .is("thread_id", null).gt("created_at", since).neq("author_id", me),
        supabase.from("space_messages").select("content, author_kind, author_id, status, kind, data").eq("space_id", s.id)
          .is("thread_id", null).order("created_at", { ascending: false }).limit(1).then(unwrap),
      ]);
      return [s.id, { unread: unread.count ?? 0, last: last[0] as LastMessage | undefined }] as const;
    })));
    return { spaces, links, agents: info, meta };
  }, [orgId, me], { orgId, tables: ["spaces", "space_agents", "agents", "space_messages"] });

  const spaces = useMemo(() => base?.spaces ?? [], [base]);
  const sid = selected && spaces.some((s) => s.id === selected) ? selected : spaces[0]?.id ?? null;
  const space = spaces.find((s) => s.id === sid) ?? null;
  const agentsIn = (spaceId: string) => (base?.links ?? []).filter((l) => l.space_id === spaceId)
    .map((l) => base?.agents.find((a) => a.id === l.agent_id)).filter((a): a is AgentInfo => !!a && a.status === "active");
  const agentById = (id: string | null) => base?.agents.find((a) => a.id === id);
  const members = space ? agentsIn(space.id) : [];
  const primary = space ? agentById(space.primary_agent_id) : undefined;
  const q = query.trim().toLowerCase();
  const shown = q ? spaces.filter((s) => [s.name, ...agentsIn(s.id).map((a) => a.name)].some((n) => n.toLowerCase().includes(q))) : spaces;

  const { data: messages } = useLive(async () => {
    if (!sid) return [];
    return supabase.from("space_messages").select("*").eq("space_id", sid).order("created_at").limit(500).then(unwrap);
  }, [sid], { orgId, tables: ["space_messages"] });

  const top = (messages ?? []).filter((m) => !m.thread_id);
  const threadOf = (id: string) => (messages ?? []).filter((m) => m.thread_id === id);
  const lastId = top.at(-1)?.id;
  const lastShape = `${lastId}:${top.at(-1)?.status}:${top.at(-1)?.content.length}`;  // a "thinking" bubble grows into the reply in place

  useEffect(() => {  // keep the newest message in view
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [sid, lastShape]);

  useEffect(() => {  // and mark the space read
    if (orgId && sid && lastId) void api.markRead(orgId, sid).then(() => reloadBase(), () => {});
  }, [orgId, sid, lastId, reloadBase]);

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
    setMenuOpen(false);
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
      <div className="grid h-[calc(100vh-7.5rem)] min-h-[560px] grid-cols-[76px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line bg-panel lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* Space list */}
        <aside className="flex min-h-0 flex-col border-r border-line bg-sidebar">
          <div className="flex h-14 items-center px-3 lg:px-4">
            <span className="hidden flex-1 text-sm font-medium text-ink-2 lg:block">Spaces</span>
            {canPost && (
              <button title="New space" onClick={() => setSpaceModal("new")}
                className="mx-auto grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink lg:mx-0">
                <Plus className="size-5" />
              </button>
            )}
          </div>
          <label className="mx-4 mb-2 hidden items-center gap-2 rounded-xl border border-line-strong px-3 focus-within:border-white/25 lg:flex">
            <Search className="size-4 shrink-0 text-ink-3" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search"
              className="h-10 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3" />
          </label>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 lg:px-3">
            {!base ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-2xl" />) : shown.map((s) => {
              const meta = base.meta[s.id];
              const unread = s.id === sid ? 0 : meta?.unread ?? 0;
              return (
                <button key={s.id} title={s.name} onClick={() => { setSelected(s.id); setExpanded(new Set()); }}
                  className={cx("flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors lg:px-3 lg:py-2.5",
                    s.id === sid ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}>
                  <span className="relative mx-auto lg:mx-0">
                    <SpaceAvatar colors={agentsIn(s.id).map((a) => a.color)} />
                    {unread > 0 && <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-bad ring-2 ring-sidebar" />}
                  </span>
                  <span className="hidden min-w-0 flex-1 lg:block">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[15px] text-ink">{s.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-ink-3 tabular">{listTime(s.last_message_at, now)}</span>
                    </span>
                    <span className={cx("block truncate text-[13px]", unread ? "font-medium text-ink-2" : "text-ink-3")}>{preview(meta?.last, me)}</span>
                  </span>
                </button>
              );
            })}
            {base && q && shown.length === 0 && <p className="px-3 py-6 text-center text-xs text-ink-3">No spaces match “{query}”.</p>}
          </nav>
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
                    className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.02] p-4 text-left transition-colors hover:border-line-strong hover:bg-white/[0.04] disabled:opacity-60">
                    <SpaceAvatar colors={st.agents.map((slug) => STARTER_COLORS[slug])} size={44} />
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
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
              <AgentFace color={primary?.color ?? members[0]?.color} size={28} />
              <h1 className="truncate text-base font-medium text-ink">{space.name}</h1>
              <span className="hidden truncate text-sm text-ink-3 md:block">{space.description}</span>
              {canPost && (
                <button title="Agents in this space" onClick={() => setSpaceModal("edit")}
                  className="ml-auto grid size-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink">
                  <Settings2 className="size-[18px]" />
                </button>
              )}
            </header>

            <div ref={scroller} className="flex-1 overflow-y-auto px-4 pb-4 sm:px-8">
              {!messages ? <Skeleton className="mt-4 h-40" /> : top.length === 0 ? (
                <EmptyState icon={<Sparkles className="size-5" />} title="Start the conversation"
                  description={members.length ? `Try “${members[0].name}, …” or @${members[0].slug}. Messages that mention nobody go to ${primary?.name ?? "the primary agent"}.`
                    : "Add an agent to this space first."} />
              ) : top.map((m, i) => {
                const prev = top[i - 1];
                const day = dayLabel(m.created_at, now);
                const stamp = !prev || day !== dayLabel(prev.created_at, now) || Date.parse(m.created_at) - Date.parse(prev.created_at) > 15 * 60_000;
                const first = stamp || prev.author_id !== m.author_id || prev.author_kind !== m.author_kind || prev.kind !== "text" || m.kind !== "text";
                return (
                  <div key={m.id}>
                    {stamp && <div className="pb-1 pt-5 text-center text-xs text-ink-3">{day === "Today" ? clock(m.created_at) : `${day} · ${clock(m.created_at)}`}</div>}
                    <MessageRow m={m} me={me} first={first} agent={agentById(m.author_id)} withAgent={agentById(str((m.data as Record<string, unknown>)?.with_id) || null)}
                      thread={threadOf(m.id)} expanded={expanded.has(m.id)} canDecide={can("admin")} busy={busy}
                      onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                      onDecide={(allow, remember) => act(`decide-${m.id}`, async () => { await api.decideTool(org.id, m.id, allow, remember); })}
                      agentColor={(id) => agentById(id)?.color} />
                  </div>
                );
              })}
            </div>

            <div className="px-4 pb-4 sm:px-8 sm:pb-5">
              <div className="relative flex items-end gap-2 rounded-[26px] border border-line-strong bg-white/[0.02] p-1.5 focus-within:border-white/25">
                {menuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-2xl border border-line-strong bg-panel-2 py-1 shadow-xl">
                    {members.map((a) => (
                      <button key={a.id} onClick={() => { setDraft((d) => `${d.replace(/@$/, "")}@${a.slug} `); setMenuOpen(false); input.current?.focus(); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-white/5">
                        <AgentFace color={a.color} size={22} /><span className="text-ink">{a.name}</span><span className="ml-auto font-mono text-[11px] text-ink-3">@{a.slug}</span>
                      </button>
                    ))}
                    <button onClick={() => { setMenuOpen(false); setSpaceModal("edit"); }}
                      className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2 text-left text-sm text-ink-2 hover:bg-white/5">
                      <Settings2 className="size-4" /> Manage agents
                    </button>
                  </div>
                )}
                <button title="Mention an agent" disabled={!canPost} onClick={() => setMenuOpen((v) => !v)}
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-ink-2 transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-40">
                  {menuOpen ? <AtSign className="size-[18px]" /> : <Plus className="size-5" />}
                </button>
                <textarea ref={input} value={draft} rows={1} disabled={!canPost} onKeyDown={onKey}
                  onChange={(e) => { setDraft(e.target.value); setMenuOpen(e.target.value.endsWith("@")); }}
                  placeholder={canPost ? `Message ${primary?.name ?? space.name}` : "Viewers can read but not post"}
                  className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent py-[7px] text-[15px] leading-snug text-ink outline-none placeholder:text-ink-3" />
                <button aria-label="Send" onClick={send} disabled={!draft.trim() || busy === "send"}
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-canvas transition-opacity hover:bg-white disabled:opacity-25">
                  {busy === "send" ? <Spinner /> : <ArrowUp className="size-[18px]" strokeWidth={2.5} />}
                </button>
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

function MessageRow({ m, me, first, agent, withAgent, thread, expanded, canDecide, busy, onToggle, onDecide, agentColor }: {
  m: SpaceMessage; me: string; first: boolean; agent?: AgentInfo; withAgent?: AgentInfo; thread: SpaceMessage[]; expanded: boolean; canDecide: boolean;
  busy: string | null; onToggle: () => void; onDecide: (allow: boolean, remember?: boolean) => void; agentColor: (id: string | null) => string | undefined;
}) {
  const data = (m.data ?? {}) as Record<string, unknown>;
  const space = first ? "mt-4" : "mt-1";

  if (m.kind === "collaboration") return (
    <div className="my-4 flex flex-col items-center">
      <button onClick={onToggle} className="flex flex-wrap items-center justify-center gap-1.5 rounded-full px-3 py-1 text-sm text-ink-3 transition-colors hover:bg-white/[0.04]">
        <AgentFace color={agent?.color} size={18} /><span className="text-ink">{m.author_label}</span> asked
        <AgentFace color={withAgent?.color ?? str(data.with_color)} size={18} /><span className="text-ink">{withAgent?.name ?? str(data.with_name)}</span>
        <Pill status={m.status} />
        <ChevronDown className={cx("size-4 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="mt-2 w-full max-w-2xl space-y-3 rounded-3xl bg-white/[0.03] p-4">
          {thread.map((t) => (
            <div key={t.id} className="flex gap-2.5">
              <AgentFace color={agentColor(t.author_id)} size={24} />
              <div className="min-w-0">
                <div className="text-xs"><span className="font-medium text-ink">{t.author_label}</span> <span className="text-ink-3">{clock(t.created_at)}</span></div>
                <Markdown className="chat-markdown compact break-words text-ink-2">{tidy(t.content)}</Markdown>
              </div>
            </div>
          ))}
          {thread.length === 0 && <p className="text-center text-xs text-ink-3">Waiting for the first reply…</p>}
        </div>
      )}
    </div>
  );

  const workflowCard = m.kind === "workflow" && (
    <div className="w-[min(34rem,100%)] rounded-3xl bg-panel-2 p-4 text-left">
      <div className="flex items-center gap-3">
        <span className="flex-1 font-semibold text-ink">{m.author_kind === "agent" ? "Verified workflow" : "Workflow result"}</span>
        <Pill status={str(data.status) || "running"} />
      </div>
      <Markdown className="chat-markdown compact mt-1.5 break-words text-ink-2">{tidy(m.content)}</Markdown>
      {str(data.workflow_id) && (
        <Link href={`/tasks/${str(data.workflow_id)}`} className="mt-2 inline-flex items-center gap-1 text-xs text-[#a99fff] hover:underline">Open workflow <ExternalLink className="size-3" /></Link>
      )}
    </div>
  );

  if (m.author_kind === "system") return m.kind === "workflow"
    ? <div className="my-4 flex justify-center">{workflowCard}</div>
    : <p className="my-3 text-center text-sm text-ink-3">{m.content}</p>;

  if (m.author_kind === "user" && m.author_id === me) return (
    <div className={cx("flex justify-end", space)}>
      <p className="max-w-[78%] whitespace-pre-wrap break-words rounded-3xl bg-[#ececea] px-4 py-2.5 text-[15px] leading-relaxed text-[#1a1a1a]">{m.content}</p>
    </div>
  );

  const isAgent = m.author_kind === "agent";
  const thinking = m.kind === "text" && m.status === "thinking";
  let body;
  if (thinking) body = <Thinking color={agent?.color} activity={str(data.activity)} />;
  else if (m.kind === "workflow") body = workflowCard;
  else if (m.kind === "approval") body = (
    <div className="w-[min(34rem,100%)] rounded-3xl bg-panel-2 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink">{str(data.tool_label) || "Tool"}</div>
          <div className="text-[15px] text-ink-2">{m.content}</div>
        </div>
        <Pill status={m.status} />
      </div>
      <div className="mt-3 break-words rounded-2xl bg-black/25 px-3.5 py-2.5 font-mono text-[13px] text-ink">{argSummary(data.args)}</div>
      {str(data.description) && <p className="mt-2 text-xs text-ink-3">{str(data.description)}</p>}
      {m.status === "pending" ? (canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" className="rounded-full" loading={busy === `decide-${m.id}`} onClick={() => onDecide(true)}>Allow</Button>
          <Button size="sm" className="rounded-full" disabled={busy === `decide-${m.id}`} onClick={() => onDecide(true, true)}
            title={`Don't ask again for ${str(data.tool_label) || "this tool"} in this reply`}>Allow for this reply</Button>
          <Button size="sm" variant="ghost" className="rounded-full" disabled={busy === `decide-${m.id}`} onClick={() => onDecide(false)}>Deny</Button>
        </div>
      ) : <p className="mt-3 text-xs text-ink-3">Waiting for an admin to allow or deny.</p>)
        : (data.for_reply || str(data.decided_by)) && (
          <p className="mt-3 text-xs text-ink-3">{data.for_reply ? "For the rest of this reply" : ""}{data.for_reply && str(data.decided_by) ? " · " : ""}{str(data.decided_by) && `by ${str(data.decided_by)}`}</p>
        )}
    </div>
  );
  else if (isAgent && m.status !== "failed") body = (
    <div className="rounded-3xl bg-panel-2 px-4 py-2.5"><Markdown className="chat-markdown break-words text-ink">{tidy(m.content)}</Markdown></div>
  );
  else body = (  // people's messages stay verbatim, and so do failures
    <p className={cx("whitespace-pre-wrap break-words rounded-3xl bg-panel-2 px-4 py-2.5 text-[15px] leading-relaxed", m.status === "failed" ? "text-bad/90" : "text-ink")}>{m.content}</p>
  );

  return (
    <div className={cx("flex items-start gap-2.5", space)}>
      <div className="w-8 shrink-0">{first && (isAgent ? <AgentFace color={agent?.color} size={32} /> : <PersonFace label={m.author_label} size={32} />)}</div>
      <div className="min-w-0 max-w-[78%]">
        {first && !thinking && <div className="mb-1 ml-1 text-xs text-ink-3">{isAgent ? m.author_label : personName(m.author_label)}</div>}
        {body}
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
