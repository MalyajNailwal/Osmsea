"use client";

import {
  Bell, Bot, Brain, Building2, Check, ChevronDown, LayoutDashboard, ListChecks, LogOut, Network, Plug, Plus, Search,
  BookOpen, ShieldCheck, Workflow, Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useApp } from "./providers";
import { Banner, Button, cx, Input, Modal, Spinner } from "./ui";

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="osm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9b8cff" />
          <stop offset="1" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 28 9.25v13.5L16 29.5 4 22.75V9.25z" fill="url(#osm-g)" opacity="0.18" stroke="url(#osm-g)" strokeWidth="1.5" />
      <circle cx="16" cy="10" r="2.6" fill="#c9c2ff" />
      <circle cx="10" cy="20" r="2.6" fill="#8fa8ff" />
      <circle cx="22" cy="20" r="2.6" fill="#8fa8ff" />
      <path d="M16 12.6v3.2M14.4 16.6 11.6 18M17.6 16.6l2.8 1.4" stroke="#c9c2ff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const NAV: { section: string; items: { href: string; label: string; icon: typeof Bot; badge?: "approvals" }[] }[] = [
  { section: "Overview", items: [{ href: "/", label: "Command Center", icon: LayoutDashboard }] },
  { section: "Build", items: [
    { href: "/builder", label: "Org Builder", icon: Workflow },
    { href: "/map", label: "Org Map", icon: Network },
    { href: "/agents", label: "Agents", icon: Bot },
  ] },
  { section: "Operate", items: [
    { href: "/tasks", label: "Tasks & Runs", icon: ListChecks, badge: "approvals" },
    { href: "/memory", label: "Shared Memory", icon: Brain },
    { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
    { href: "/automations", label: "Automations", icon: Zap },
  ] },
  { section: "Admin", items: [
    { href: "/integrations", label: "Integrations", icon: Plug },
    { href: "/settings", label: "Governance", icon: ShieldCheck },
  ] },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function PlatformStatus() {
  const { status, apiError, org } = useApp();
  const now = useNow(15_000);
  if (!org) return null;
  const workerOk = !!status?.worker.last_tick && now - new Date(status.worker.last_tick).getTime() < 60_000;
  const ok = !apiError && workerOk && status?.llm.configured;
  const label = apiError ? "API unreachable" : !status ? "Checking…" : !status.llm.configured ? "No LLM provider" : !workerOk ? "Worker idle / stopped" : "All systems operational";
  return (
    <div className="surface mx-3 mb-3 rounded-xl p-3.5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        Platform status
        <span className={cx("size-1.5 rounded-full", ok ? "bg-ok shadow-[0_0_8px] shadow-ok" : status || apiError ? "bg-warn" : "bg-ink-3")} />
      </div>
      <p className={cx("mt-1 text-xs", ok ? "text-ok/90" : "text-warn/90")}>{label}</p>
      {status?.llm.configured && <p className="mt-1 truncate text-[11px] text-ink-3" title={status.llm.model}>{status.llm.provider} · {status.llm.model}</p>}
      {status && !status.llm.configured && (
        <Link href="/integrations" className="mt-1.5 inline-block text-xs text-[#a99fff] hover:underline">Configure a provider →</Link>
      )}
    </div>
  );
}

function OrgSwitcher() {
  const { orgs, org, selectOrg } = useApp();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  if (!org) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-sm text-ink hover:bg-panel-2">
        <Building2 className="size-4 text-ink-3" />
        <span className="max-w-40 truncate">{org.name}</span>
        <span className="rounded bg-white/8 px-1.5 text-[10px] uppercase tracking-wide text-ink-3">{org.role}</span>
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>
      {open && (
        <div className="surface absolute right-0 z-40 mt-1.5 w-64 p-1.5 shadow-2xl" onMouseLeave={() => setOpen(false)}>
          {orgs.map((o) => (
            <button key={o.id} onClick={() => { selectOrg(o.id); setOpen(false); }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/5">
              <span className="truncate">{o.name}</span>
              {o.id === org.id && <Check className="size-4 text-accent" />}
            </button>
          ))}
          <button onClick={() => { setOpen(false); router.push("/builder?new=1"); }}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-line px-2.5 py-2 text-left text-sm text-ink-2 hover:bg-white/5">
            <Plus className="size-4" /> New organization
          </button>
        </div>
      )}
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org } = useApp();
  const router = useRouter();
  const [q, setQ] = useState("");
  const { data } = useLive(async () => {
    if (!org || !open) return { agents: [], workflows: [] };
    const [agents, workflows] = await Promise.all([
      supabase.from("agents").select("id, name, role").eq("org_id", org.id).order("name").then(unwrap),
      supabase.from("workflows").select("id, goal, status").eq("org_id", org.id).order("created_at", { ascending: false }).limit(30).then(unwrap),
    ]);
    return { agents, workflows };
  }, [org?.id, open]);
  const items = useMemo(() => {
    const pages = NAV.flatMap((s) => s.items).map((i) => ({ key: i.href, label: i.label, hint: "Page", href: i.href }));
    const agents = (data?.agents ?? []).map((a) => ({ key: a.id, label: a.name, hint: `Agent · ${a.role}`, href: `/agents/${a.id}` }));
    const runs = (data?.workflows ?? []).map((w) => ({ key: w.id, label: w.goal, hint: `Workflow · ${w.status}`, href: `/tasks/${w.id}` }));
    const term = q.trim().toLowerCase();
    return [...pages, ...agents, ...runs].filter((i) => !term || i.label.toLowerCase().includes(term) || i.hint.toLowerCase().includes(term)).slice(0, 12);
  }, [data, q]);
  const go = (href: string) => { onClose(); setQ(""); router.push(href); };
  return (
    <Modal open={open} onClose={onClose} title="Search">
      <Input autoFocus placeholder="Search pages, agents, workflows…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && items[0] && go(items[0].href)} />
      <div className="mt-3 max-h-80 space-y-0.5 overflow-y-auto">
        {items.map((i) => (
          <button key={i.key} onClick={() => go(i.href)} className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-white/5">
            <span className="truncate text-sm text-ink">{i.label}</span>
            <span className="shrink-0 text-[11px] text-ink-3">{i.hint}</span>
          </button>
        ))}
        {!items.length && <p className="px-2.5 py-6 text-center text-sm text-ink-3">No matches</p>}
      </div>
    </Modal>
  );
}

function Onboarding() {
  const { reloadOrgs, selectOrg } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromTemplate = async () => {
    setBusy(true);
    setError(null);
    try {
      const org = await api.createOrg({ template: "default", name: "My Organization" });
      await reloadOrgs();
      selectOrg(org.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto mt-16 max-w-xl text-center">
      <div className="mx-auto mb-5 w-fit"><Logo size={52} /></div>
      <h1 className="text-2xl font-semibold">Create your first agent organization</h1>
      <p className="mt-2 text-sm text-ink-2">
        Start from the validated starter template (a Research and an Engineering department), or describe a goal and let the
        Builder propose a structure you can review and edit.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button variant="primary" loading={busy} onClick={fromTemplate}>Start from template</Button>
        <Button onClick={() => router.push("/builder?new=1")}>Open Builder</Button>
      </div>
      {error && <Banner tone="bad" className="mt-4 text-left">{error}</Banner>}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { session, authReady, orgs, orgsLoading, org, apiError } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (authReady && !session) router.replace("/login");
  }, [authReady, session, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data: pending } = useLive(async () => {
    if (!org) return [];
    const [approvals, actions] = await Promise.all([  // plans and deliveries (e.g. pull requests) awaiting an admin
      supabase.from("approvals").select("id, created_at").eq("org_id", org.id).eq("status", "pending").then(unwrap),
      supabase.from("actions").select("id, created_at").eq("org_id", org.id).eq("status", "pending").then(unwrap),
    ]);
    return [...approvals, ...actions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [org?.id], { orgId: org?.id, tables: ["approvals", "actions"] });

  if (!authReady || !session) {
    return <div className="grid min-h-screen place-items-center"><Spinner className="size-6" /></div>;
  }
  const email = session.user.email ?? "";
  const needsOrg = !orgsLoading && orgs.length === 0 && pathname !== "/builder";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-sidebar md:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <Logo />
          <div>
            <div className="text-[17px] font-semibold tracking-tight">OSMSEA</div>
            <div className="-mt-0.5 text-[10.5px] text-ink-3">Agent Organization Platform</div>
          </div>
        </Link>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3">
          {NAV.map((section) => (
            <div key={section.section}>
              <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">{section.section}</div>
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                const count = item.badge === "approvals" ? pending?.length ?? 0 : 0;
                return (
                  <Link key={item.href} href={item.href}
                    className={cx("group mb-0.5 flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      active ? "bg-accent-soft text-ink shadow-[inset_2px_0_0] shadow-accent" : "text-ink-2 hover:bg-white/[0.04] hover:text-ink")}>
                    <Icon className={cx("size-[18px]", active ? "text-[#a99fff]" : "text-ink-3 group-hover:text-ink-2")} />
                    <span className="flex-1">{item.label}</span>
                    {count > 0 && <span className="rounded-md bg-warn/15 px-1.5 text-[11px] font-semibold text-warn">{count}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <PlatformStatus />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-canvas/85 px-6 backdrop-blur">
          <button onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2.5 rounded-lg border border-line bg-panel px-3 text-sm text-ink-3 hover:border-line-strong">
            <Search className="size-4" />
            <span className="flex-1 text-left">Search workflows, agents, approvals…</span>
            <kbd className="rounded border border-line px-1.5 text-[10px]">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/tasks?view=approvals" className="relative rounded-lg p-2 text-ink-2 hover:bg-white/5" aria-label="Pending approvals"
              title={pending?.length ? `${pending.length} pending approval(s), oldest ${timeAgo(pending[pending.length - 1]?.created_at)}` : "No pending approvals"}>
              <Bell className="size-[18px]" />
              {!!pending?.length && <span className="absolute top-1 right-1 size-2 rounded-full bg-warn" />}
            </Link>
            <OrgSwitcher />
            <div className="flex items-center gap-2 pl-2">
              <div className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-xs font-semibold uppercase">
                {email.slice(0, 1)}
              </div>
              <div className="hidden text-xs lg:block">
                <div className="max-w-44 truncate text-ink">{email}</div>
                <div className="text-ink-3 capitalize">{org?.role ?? "—"}</div>
              </div>
              <button onClick={() => supabase.auth.signOut()} className="rounded-lg p-2 text-ink-3 hover:bg-white/5 hover:text-ink" aria-label="Sign out" title="Sign out">
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-6 py-6 xl:px-8">
          {apiError && <Banner tone="warn" className="mb-4">OSMSEA API: {apiError}</Banner>}
          {orgsLoading ? <div className="grid place-items-center py-24"><Spinner className="size-6" /></div> : needsOrg ? <Onboarding /> : children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
