"use client";

import {
  Background, BackgroundVariant, type Edge, Panel, ReactFlow, useReactFlow,
} from "@xyflow/react";
import {
  ArrowLeft, Bot, CheckCircle2, FolderTree, LayoutGrid, Maximize, Minus, Plus, RotateCcw, Save, ShieldCheck, Sparkles, Trash2, X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  type AgentNodeData, type DeptNodeData, hierarchyEdges, type NodeStatus, nodeTypes, ORG_NODE_ID, type OrgFlowNode, tile,
  treeLayout, useFlowNodes,
} from "@/components/org-graph";
import { useApp } from "@/components/providers";
import { Banner, Button, Card, cx, Field, Input, Select, Spinner, Tabs, Textarea, Toggle } from "@/components/ui";
import { api, ApiError, errorMessage, type Proposal } from "@/lib/api";
import { unwrap, useLive } from "@/lib/hooks";
import { list, newAgentMarkdown, obj, patchSpec, splitSpec, str } from "@/lib/spec-md";
import { supabase } from "@/lib/supabase";

// --- draft model ---------------------------------------------------------------------------------

type Check = { valid: boolean; errors: string[]; unavailable?: Record<string, string> };
type DDept = { key: string; slug: string; name: string; description: string; dbId?: string; saved?: { name: string; description: string } };
type DAgent = { key: string; md: string; dbId?: string; savedMd?: string; version?: number; dbStatus?: string; check?: Check };
type Draft = { name: string; description: string; depts: DDept[]; agents: DAgent[] };
type Notice = { tone: "ok" | "bad" | "warn" | "info"; text: string; errors?: string[] } | null;

const SLUG = /^[a-z][a-z0-9-]{1,47}$/;
const UNASSIGNED = "d:__unassigned";
const key = () => Math.random().toString(36).slice(2, 10);

const agentDept = (a: DAgent) => str(splitSpec(a.md).front.department);
const agentDirty = (a: DAgent) => !a.dbId || a.md !== a.savedMd;
const deptDirty = (d: DDept) => !d.dbId || d.name !== d.saved?.name || d.description !== d.saved?.description;

function uniqueSlug(base: string, taken: Set<string>) {
  let s = base;
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
  return s;
}

function draftFromProposal(p: Proposal): Draft {
  return {
    name: p.name, description: p.description,
    depts: p.departments.map((d) => ({ key: key(), slug: d.id, name: d.name, description: d.description })),
    agents: p.agents.map((a) => ({ key: key(), md: a.source_md, check: { valid: a.valid, errors: a.errors } })),
  };
}

function agentStatus(a: DAgent): NodeStatus {
  const parsed = splitSpec(a.md);
  if (parsed.error) return { tone: "bad", text: "Invalid frontmatter" };
  if (a.check && !a.check.valid) return { tone: "bad", text: `${a.check.errors.length} validation error${a.check.errors.length === 1 ? "" : "s"}` };
  if (!a.dbId) return { tone: "warn", text: a.check?.valid ? "Valid · not saved yet" : "New · not saved" };
  if (a.md !== a.savedMd) return { tone: "warn", text: a.check?.valid ? "Valid · unsaved changes" : "Unsaved changes" };
  if (a.dbStatus === "disabled") return { tone: "neutral", text: `Disabled · v${a.version ?? "?"}` };
  return { tone: "ok", text: a.check?.valid ? `Valid · v${a.version ?? "?"}` : `Saved · v${a.version ?? "?"}` };
}

// --- page ----------------------------------------------------------------------------------------

export default function BuilderPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-24"><Spinner className="size-6" /></div>}>
      <BuilderRoot />
    </Suspense>
  );
}

function BuilderRoot() {
  const params = useSearchParams();
  const { org, orgs, orgsLoading } = useApp();
  if (orgsLoading) return <div className="grid place-items-center py-24"><Spinner className="size-6" /></div>;
  if (params.get("new") === "1" || !org || orgs.length === 0) return <NewOrgFlow />;
  return <ExistingOrg key={org.id} orgId={org.id} />;
}

function ExistingOrg({ orgId }: { orgId: string }) {
  const { data, error } = useLive(async () => {
    const [org, depts, agents] = await Promise.all([
      supabase.from("organizations").select("name, description").eq("id", orgId).single().then(unwrap),
      supabase.from("departments").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
      supabase.from("agents").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
    ]);
    const ids = agents.map((a) => a.active_version_id).filter((v): v is string => !!v);
    const versions = ids.length ? await supabase.from("agent_versions").select("id, source_md, version").in("id", ids).then(unwrap) : [];
    return { org, depts, agents, versions };
  }, [orgId]);

  const initial = useMemo<Draft | null>(() => {
    if (!data) return null;
    const byId = new Map(data.versions.map((v) => [v.id, v]));
    return {
      name: data.org.name, description: data.org.description,
      depts: data.depts.map((d) => ({ key: d.id, slug: d.slug, name: d.name, description: d.description, dbId: d.id,
        saved: { name: d.name, description: d.description } })),
      agents: data.agents.map((a) => {
        const v = a.active_version_id ? byId.get(a.active_version_id) : undefined;
        return { key: a.id, md: v?.source_md ?? "", savedMd: v?.source_md ?? "", dbId: a.id, version: v?.version, dbStatus: a.status };
      }),
    };
  }, [data]);

  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!initial) return <div className="grid place-items-center py-24"><Spinner className="size-6" /></div>;
  return <BuilderCanvas mode="existing" initial={initial} orgId={orgId} />;
}

const EXAMPLES = [
  "A market research team that tracks competitors' product launches and writes weekly briefs with sources.",
  "A developer-experience team that researches libraries and proposes small, reviewed code changes.",
];

function NewOrgFlow() {
  const { org, can } = useApp();
  const [draft, setDraft] = useState<{ draft: Draft; meta: Proposal | null; nonce: string } | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<"propose" | "template" | null>(null);
  const [error, setError] = useState<{ text: string; noProvider: boolean } | null>(null);

  const run = async (which: "propose" | "template") => {
    setBusy(which);
    setError(null);
    try {
      const p = which === "propose" ? await api.propose(goal.trim(), org && can("admin") ? org.id : undefined) : await api.template();
      setDraft({ draft: draftFromProposal(p), meta: which === "propose" ? p : null, nonce: key() });
    } catch (e) {
      setError({ text: errorMessage(e), noProvider: e instanceof ApiError && e.status === 400 });
    } finally {
      setBusy(null);
    }
  };

  if (draft) return <BuilderCanvas key={draft.nonce} mode="new" initial={draft.draft} meta={draft.meta} onReset={() => setDraft(null)} />;

  return (
    <div className="dot-grid -mx-6 -my-6 grid min-h-[calc(100vh-4rem)] place-items-center px-6 py-10 xl:-mx-8">
      <Card className="w-full max-w-2xl p-7">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white"><Sparkles className="size-5" /></div>
          <div>
            <h1 className="text-xl font-semibold">Design a new agent organization</h1>
            <p className="text-sm text-ink-2">Describe the goal. The Builder proposes departments and validated agent specs you can review and edit before anything is saved.</p>
          </div>
        </div>
        <Field label="Describe your organization's goal">
          <Textarea rows={5} value={goal} maxLength={4000} onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. A research team that monitors AI safety papers and summarizes what matters for our product, with citations." />
        </Field>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => setGoal(ex)} className="rounded-md border border-line px-2 py-1 text-left text-[11px] text-ink-3 hover:border-line-strong hover:text-ink-2">
              {ex.slice(0, 64)}…
            </button>
          ))}
        </div>
        {error && (
          <Banner tone={error.noProvider ? "warn" : "bad"} className="mt-4">
            {error.text}
            {error.noProvider && <> — <Link href="/integrations" className="underline">configure an LLM provider</Link>, or start from the validated template instead.</>}
          </Banner>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === "propose"} disabled={goal.trim().length < 3 || !!busy}
            onClick={() => run("propose")}>Generate structure</Button>
          <Button loading={busy === "template"} disabled={!!busy} onClick={() => run("template")}>Start from template</Button>
          {org && <Link href="/builder" className="ml-auto text-xs text-ink-3 hover:text-ink">Edit {org.name} instead →</Link>}
        </div>
        <p className="mt-4 text-[11px] text-ink-3">The template contains a Research department (Research Agent) and an Engineering department (Software Developer).</p>
      </Card>
    </div>
  );
}

// --- canvas --------------------------------------------------------------------------------------

function BuilderCanvas({ mode, initial, orgId, meta, onReset }: {
  mode: "new" | "existing"; initial: Draft; orgId?: string; meta?: Proposal | null; onReset?: () => void;
}) {
  const { can, reloadOrgs, selectOrg } = useApp();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(
    meta?.errors?.length ? { tone: "warn", text: "The proposal has structural problems to fix:", errors: meta.errors } : null);
  const admin = mode === "new" || can("admin");

  const groups = useMemo(() => {
    const slugs = new Set(draft.depts.map((d) => d.slug));
    const out = draft.depts.map((d) => ({ id: `d:${d.key}`, dept: d as DDept | null, agents: draft.agents.filter((a) => agentDept(a) === d.slug).map((a) => `a:${a.key}`) }));
    const orphans = draft.agents.filter((a) => !slugs.has(agentDept(a))).map((a) => `a:${a.key}`);
    if (orphans.length) out.push({ id: UNASSIGNED, dept: null, agents: orphans });
    return out;
  }, [draft]);

  const base = useMemo<OrgFlowNode[]>(() => {
    const pos = treeLayout(groups);
    const nodes: OrgFlowNode[] = [{
      id: ORG_NODE_ID, type: "org", position: pos[ORG_NODE_ID],
      data: { name: draft.name || "New organization", subtitle: `${draft.depts.length} departments · ${draft.agents.length} agents` },
    }];
    groups.forEach((g, gi) => {
      const status: NodeStatus | undefined = !g.dept ? { tone: "bad", text: "Agents with an unknown department" }
        : !SLUG.test(g.dept.slug) ? { tone: "bad", text: "Invalid department id" }
        : deptDirty(g.dept) ? { tone: "warn", text: g.dept.dbId ? "Unsaved changes" : "New · not saved" } : undefined;
      nodes.push({ id: g.id, type: "dept", position: pos[g.id],
        data: { name: g.dept?.name ?? "Unassigned", subtitle: g.dept ? `${g.dept.slug} · ${g.agents.length} agent(s)` : "fix each agent's department", color: gi, status } satisfies DeptNodeData });
      for (const id of g.agents) {
        const a = draft.agents.find((x) => `a:${x.key}` === id)!;
        const { front } = splitSpec(a.md);
        nodes.push({ id, type: "agent", position: pos[id],
          data: { name: str(front.name, "Untitled agent"), role: str(front.role, "—"), color: gi, status: agentStatus(a),
            meta: list(front.allowed_tools).join(" · ") || "no tools" } satisfies AgentNodeData });
      }
    });
    return nodes;
  }, [groups, draft]);
  const edges: Edge[] = useMemo(() => hierarchyEdges(groups), [groups]);
  const { nodes, onNodesChange, resetLayout } = useFlowNodes(base, selected);

  const dirtyAgents = draft.agents.filter(agentDirty);
  const dirtyDepts = draft.depts.filter(deptDirty);
  const dirtyCount = dirtyAgents.length + dirtyDepts.length;

  // --- mutations (pure state) ---
  const setAgent = (k: string, patch: Partial<DAgent>) =>
    setDraft((d) => ({ ...d, agents: d.agents.map((a) => (a.key === k ? { ...a, ...patch } : a)) }));
  const setDept = (k: string, patch: Partial<DDept>) =>
    setDraft((d) => ({ ...d, depts: d.depts.map((x) => (x.key === k ? { ...x, ...patch } : x)) }));

  const addDepartment = () => {
    const slug = uniqueSlug("new-department", new Set(draft.depts.map((d) => d.slug)));
    const k = key();
    setDraft((d) => ({ ...d, depts: [...d.depts, { key: k, slug, name: "New Department", description: "Describe what this department is responsible for." }] }));
    setSelected(`d:${k}`);
  };

  const addAgent = () => {
    const sel = selected?.startsWith("a:") ? draft.agents.find((a) => `a:${a.key}` === selected) : undefined;
    const deptSlug = selected?.startsWith("d:") ? draft.depts.find((d) => `d:${d.key}` === selected)?.slug
      : sel ? agentDept(sel) : draft.depts[0]?.slug;
    if (!deptSlug) {
      setNotice({ tone: "warn", text: "Add a department first." });
      return;
    }
    const taken = new Set(draft.agents.map((a) => str(splitSpec(a.md).front.id)));
    const id = uniqueSlug("new-agent", taken);
    const k = key();
    setDraft((d) => ({ ...d, agents: [...d.agents, { key: k, md: newAgentMarkdown(id, deptSlug) }] }));
    setSelected(`a:${k}`);
  };

  const remove = (nodeId: string) => {
    setDraft((d) => ({ ...d, agents: d.agents.filter((a) => `a:${a.key}` !== nodeId), depts: d.depts.filter((x) => `d:${x.key}` !== nodeId) }));
    setSelected(null);
  };

  // --- server actions ---
  const validate = async (a: DAgent): Promise<Check> => {
    const v = mode === "new" || !orgId ? await api.validateDraft(a.md) : await api.validateAgent(orgId, a.md);
    const check = { valid: v.valid, errors: v.errors, unavailable: v.effective_tools?.unavailable };
    setAgent(a.key, { check });
    return check;
  };

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof ApiError ? e.message : errorMessage(e), errors: e instanceof ApiError ? e.errors : undefined });
    } finally {
      setBusy(null);
    }
  };

  const validateAll = () => act("validate", async () => {
    let bad = 0;
    for (const a of draft.agents) if (!(await validate(a)).valid) bad++;
    const badDepts = draft.depts.filter((d) => !SLUG.test(d.slug)).length;
    setNotice(bad || badDepts
      ? { tone: "bad", text: `${bad} agent(s) and ${badDepts} department(s) need fixes. Select a red node to see its errors.` }
      : { tone: "ok", text: `All ${draft.agents.length} agents passed validation.` });
  });

  const saveDept = async (d: DDept) => {
    if (!orgId) return;
    if (d.dbId) await api.updateDepartment(orgId, d.dbId, { name: d.name, description: d.description });
    else {
      const row = await api.createDepartment(orgId, { slug: d.slug, name: d.name, description: d.description });
      setDept(d.key, { dbId: row.id });
    }
    setDept(d.key, { saved: { name: d.name, description: d.description } });
  };

  const saveAgent = async (a: DAgent, note: string): Promise<boolean> => {
    if (!orgId) return false;
    const check = await validate(a);
    if (!check.valid) return false;
    if (a.dbId) {
      const res = await api.updateAgent(orgId, a.dbId, a.md, note);
      setAgent(a.key, { savedMd: a.md, version: res.version });
    } else {
      const res = await api.createAgent(orgId, a.md, note);
      setAgent(a.key, { dbId: res.id, savedMd: a.md, version: 1, dbStatus: "active" });
    }
    return true;
  };

  const saveAll = () => act("save", async () => {
    for (const d of dirtyDepts) await saveDept(d); // departments first: new agents may reference them
    let failed = 0;
    for (const a of dirtyAgents) if (!(await saveAgent(a, "Saved from Builder"))) failed++;
    setNotice(failed ? { tone: "bad", text: `${failed} agent(s) failed validation and were not saved.` }
      : { tone: "ok", text: "All changes saved. Running tasks keep the spec version they were approved with." });
  });

  const createOrg = () => act("create", async () => {
    try {
      const org = await api.createOrg({
        name: draft.name.trim(), description: draft.description.trim(),
        departments: draft.depts.map((d) => ({ id: d.slug, name: d.name, description: d.description })),
        agents: draft.agents.map((a) => ({ source_md: a.md })),
      });
      await reloadOrgs();
      selectOrg(org.id);
      router.push("/map");
    } catch (e) {
      if (e instanceof ApiError && e.errors.length) {
        const perAgent = new Map<number, string[]>();
        for (const err of e.errors) {
          const m = /^agents\[(\d+)\]: (.*)$/.exec(err);
          if (m) perAgent.set(Number(m[1]), [...(perAgent.get(Number(m[1])) ?? []), m[2]]);
        }
        setDraft((d) => ({ ...d, agents: d.agents.map((a, i) => (perAgent.has(i) ? { ...a, check: { valid: false, errors: perAgent.get(i)! } } : a)) }));
      }
      throw e;
    }
  });

  const selAgent = selected?.startsWith("a:") ? draft.agents.find((a) => `a:${a.key}` === selected) : undefined;
  const selDept = selected?.startsWith("d:") ? draft.depts.find((d) => `d:${d.key}` === selected) : undefined;

  return (
    <div className="-mx-6 -my-6 flex h-[calc(100vh-4rem)] flex-col xl:-mx-8">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/80 px-5 py-3">
        <button onClick={() => (onReset ? onReset() : router.push("/"))} className="rounded-lg p-1.5 text-ink-2 hover:bg-white/5" aria-label="Back">
          <ArrowLeft className="size-5" />
        </button>
        <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white"><Sparkles className="size-[18px]" /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{draft.name || "New organization"}</div>
          <div className="truncate text-xs text-ink-3">
            {mode === "new" ? "Review the proposed structure, edit any agent, then create the organization. Nothing is saved until you do."
              : "Edit departments and agents. Saving an agent validates it and activates a new version."}
          </div>
        </div>
        {mode === "new" && meta?.model && <span className="hidden text-[11px] text-ink-3 lg:block">proposed by {meta.model}</span>}
        <Button icon={<ShieldCheck className="size-4" />} loading={busy === "validate"} disabled={!!busy} onClick={validateAll}>Validate all</Button>
        {mode === "new" ? (
          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={busy === "create"}
            disabled={!!busy || !draft.name.trim() || !draft.agents.length} onClick={createOrg}>Create organization</Button>
        ) : (
          <Button variant="primary" icon={<Save className="size-4" />} loading={busy === "save"} disabled={!!busy || !dirtyCount || !admin}
            title={admin ? undefined : "Only admins can change the organization"} onClick={saveAll}>
            Save changes{dirtyCount ? ` (${dirtyCount})` : ""}
          </Button>
        )}
      </div>
      {(notice || (mode === "new" && meta?.gaps?.length)) && (
        <div className="space-y-2 border-b border-line bg-panel/60 px-5 py-2.5">
          {notice && (
            <Banner tone={notice.tone} action={<button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="size-4" /></button>}>
              {notice.text}
              {notice.errors && <ul className="mt-1 list-disc pl-4 text-xs">{notice.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>}
            </Banner>
          )}
          {mode === "new" && !!meta?.gaps?.length && (
            <Banner tone="info">Capability gaps the model flagged (no agent will cover these): {meta.gaps.join("; ")}</Banner>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="dot-grid relative min-w-0 flex-1">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
            onNodeClick={(_, n) => setSelected(n.id === UNASSIGNED ? null : n.id)} onPaneClick={() => setSelected(null)}
            fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.3} maxZoom={1.6}
            nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null}>
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.08)" />
            <Toolbar onAutoLayout={resetLayout} onAddDept={addDepartment} onAddAgent={addAgent} canEdit={admin} />
          </ReactFlow>
        </div>

        {selected && (
          <aside className="w-[420px] shrink-0 overflow-y-auto border-l border-line bg-panel">
            {selected === ORG_NODE_ID && (
              <OrgInspector draft={draft} mode={mode} orgId={orgId} canEdit={admin} onClose={() => setSelected(null)}
                onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
            )}
            {selDept && (
              <DeptInspector dept={selDept} agentCount={draft.agents.filter((a) => agentDept(a) === selDept.slug).length}
                index={draft.depts.indexOf(selDept)} mode={mode} canEdit={admin} busy={busy}
                onClose={() => setSelected(null)} onChange={(patch) => {
                  if (patch.slug !== undefined && patch.slug !== selDept.slug) {
                    // keep agents attached when an unsaved department is renamed
                    const from = selDept.slug;
                    setDraft((d) => ({ ...d, agents: d.agents.map((a) => (agentDept(a) === from ? { ...a, md: patchSpec(a.md, { department: patch.slug }), check: undefined } : a)) }));
                  }
                  setDept(selDept.key, patch);
                }}
                onSave={() => act("dept", () => saveDept(selDept))} onRemove={() => remove(selected)} />
            )}
            {selAgent && (
              <AgentInspector agent={selAgent} depts={draft.depts} index={Math.max(0, draft.depts.findIndex((d) => d.slug === agentDept(selAgent)))}
                mode={mode} canEdit={admin} busy={busy} onClose={() => setSelected(null)}
                onChange={(md) => setAgent(selAgent.key, { md, check: undefined })}
                onValidate={() => act("validate-one", async () => { await validate(selAgent); })}
                onSave={(note) => act("agent", async () => {
                  const dept = draft.depts.find((d) => d.slug === agentDept(selAgent));
                  if (dept && !dept.dbId) await saveDept(dept);
                  if (await saveAgent(selAgent, note)) setNotice({ tone: "ok", text: "Agent saved and activated." });
                })}
                onRemove={() => remove(selected)} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Toolbar({ onAutoLayout, onAddDept, onAddAgent, canEdit }: {
  onAutoLayout: () => void; onAddDept: () => void; onAddAgent: () => void; canEdit: boolean;
}) {
  const rf = useReactFlow();
  const btn = "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs text-ink-2 hover:bg-white/5 hover:text-ink disabled:opacity-40";
  return (
    <Panel position="bottom-center">
      <div className="surface flex items-center gap-0.5 rounded-xl px-1.5 py-1 shadow-2xl">
        <button className={btn} onClick={() => rf.zoomIn()}><Plus className="size-3.5" /> Zoom in</button>
        <button className={btn} onClick={() => rf.zoomOut()}><Minus className="size-3.5" /> Zoom out</button>
        <button className={btn} onClick={() => rf.fitView({ padding: 0.25 })}><Maximize className="size-3.5" /> Fit view</button>
        <button className={btn} onClick={() => { onAutoLayout(); setTimeout(() => rf.fitView({ padding: 0.25 }), 50); }}><LayoutGrid className="size-3.5" /> Auto layout</button>
        <span className="mx-1 h-4 w-px bg-line" />
        <button className={cx(btn, "text-[#b4abff]")} disabled={!canEdit} onClick={onAddDept}><FolderTree className="size-3.5" /> Add department</button>
        <button className={cx(btn, "text-[#b4abff]")} disabled={!canEdit} onClick={onAddAgent}><Bot className="size-3.5" /> Add agent</button>
      </div>
    </Panel>
  );
}

// --- inspectors ------------------------------------------------------------------------------------

function InspectorHeader({ icon, title, subtitle, onClose }: { icon: React.ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-panel px-4 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        <div className="truncate text-[11px] text-ink-3">{subtitle}</div>
      </div>
      <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-white/5 hover:text-ink" aria-label="Close inspector"><X className="size-4" /></button>
    </div>
  );
}

function OrgInspector({ draft, mode, orgId, canEdit, onClose, onChange }: {
  draft: Draft; mode: "new" | "existing"; orgId?: string; canEdit: boolean; onClose: () => void;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const { reloadOrgs } = useApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice>(null);
  const save = async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      await api.updateOrg(orgId, { name: draft.name.trim(), description: draft.description.trim() });
      await reloadOrgs();
      setMsg({ tone: "ok", text: "Organization updated." });
    } catch (e) {
      setMsg({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <InspectorHeader icon={<div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white"><Sparkles className="size-4" /></div>}
        title={draft.name || "New organization"} subtitle="Organization" onClose={onClose} />
      <div className="space-y-4 p-4">
        <Field label="Name"><Input value={draft.name} maxLength={120} disabled={!canEdit} onChange={(e) => onChange({ name: e.target.value })} /></Field>
        <Field label="Description"><Textarea rows={4} value={draft.description} maxLength={2000} disabled={!canEdit} onChange={(e) => onChange({ description: e.target.value })} /></Field>
        {mode === "existing" && <Button variant="primary" size="sm" loading={busy} disabled={!canEdit || !draft.name.trim()} onClick={save}>Save organization</Button>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      </div>
    </>
  );
}

function DeptInspector({ dept, agentCount, index, mode, canEdit, busy, onClose, onChange, onSave, onRemove }: {
  dept: DDept; agentCount: number; index: number; mode: "new" | "existing"; canEdit: boolean; busy: string | null;
  onClose: () => void; onChange: (patch: Partial<DDept>) => void; onSave: () => void; onRemove: () => void;
}) {
  return (
    <>
      <InspectorHeader icon={<div className="grid size-8 place-items-center rounded-lg text-white" style={{ background: tile(index) }}><FolderTree className="size-4" /></div>}
        title={dept.name || "Department"} subtitle={`Department · ${agentCount} agent(s)`} onClose={onClose} />
      <div className="space-y-4 p-4">
        <Field label="Name"><Input value={dept.name} maxLength={80} disabled={!canEdit} onChange={(e) => onChange({ name: e.target.value })} /></Field>
        <Field label="Department id" hint={dept.dbId ? "Ids are stable once saved." : "Lowercase letters, digits and dashes. Agents reference this id."}>
          <Input value={dept.slug} disabled={!!dept.dbId || !canEdit} className="font-mono text-xs"
            onChange={(e) => onChange({ slug: e.target.value.toLowerCase() })} />
        </Field>
        {!SLUG.test(dept.slug) && <Banner tone="bad">Department id must match ^[a-z][a-z0-9-]&#123;1,47&#125;$.</Banner>}
        <Field label="Description"><Textarea rows={4} value={dept.description} maxLength={500} disabled={!canEdit} onChange={(e) => onChange({ description: e.target.value })} /></Field>
        <div className="flex gap-2">
          {mode === "existing" && (
            <Button variant="primary" size="sm" icon={<Save className="size-3.5" />} loading={busy === "dept"} disabled={!canEdit || !deptDirty(dept) || !SLUG.test(dept.slug) || !dept.name.trim()}
              onClick={onSave}>{dept.dbId ? "Save department" : "Create department"}</Button>
          )}
          {!dept.dbId && (
            <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} disabled={agentCount > 0} title={agentCount ? "Move or remove its agents first" : undefined}
              onClick={onRemove}>Remove</Button>
          )}
        </div>
      </div>
    </>
  );
}

function AgentInspector({ agent, depts, index, mode, canEdit, busy, onClose, onChange, onValidate, onSave, onRemove }: {
  agent: DAgent; depts: DDept[]; index: number; mode: "new" | "existing"; canEdit: boolean; busy: string | null;
  onClose: () => void; onChange: (md: string) => void; onValidate: () => void; onSave: (note: string) => void; onRemove: () => void;
}) {
  const { catalog, status, org } = useApp();
  const [tab, setTab] = useState<"config" | "markdown">("config");
  const [note, setNote] = useState("");
  const { data: orgTools } = useLive(async () => (org && mode === "existing" ? api.orgTools(org.id) : null),
    [org?.id, mode], { orgId: org?.id, tables: ["mcp_servers"] });
  const toolOptions = [
    ...(catalog?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
    ...(orgTools?.mcp ?? []).map((t) => ({ name: t.name, description: `MCP · ${t.server_name}: ${t.description}` })),
  ];
  const parsed = splitSpec(agent.md);
  const f = parsed.front;
  const verification = obj(f.verification);
  const limits = obj(f.limits);
  const tools = list(f.allowed_tools);
  const set = (patch: Record<string, unknown>, body?: string) => onChange(patchSpec(agent.md, patch, body));
  const num = (v: string) => (v === "" ? undefined : Number(v));
  const toolHint = (name: string): string | undefined => {
    if (agent.check?.unavailable?.[name]) return agent.check.unavailable[name];
    const t = catalog?.tools.find((x) => x.name === name);
    if (t?.integrations.length && status && !t.integrations.some((p) => status.providers.includes(p))) return `needs ${t.integrations.join(" or ")}`;
    return undefined;
  };
  const dirty = agentDirty(agent);
  const disabled = !canEdit;

  return (
    <>
      <InspectorHeader icon={<div className="grid size-8 place-items-center rounded-lg text-white" style={{ background: tile(index) }}><Bot className="size-4" /></div>}
        title={str(f.name, "Untitled agent")} subtitle={`${str(f.id, "no id")} · ${agent.dbId ? `v${agent.version ?? "?"}` : "not saved"}`} onClose={onClose} />
      <Tabs className="px-2" tabs={[{ id: "config", label: "Configuration" }, { id: "markdown", label: "Markdown" }]} value={tab} onChange={setTab} />
      <div className="space-y-4 p-4">
        {tab === "markdown" ? (
          <Field label="Agent specification (YAML frontmatter + instructions)" hint="This Markdown is the canonical format. It is validated on the server before activation.">
            <Textarea rows={30} value={agent.md} disabled={disabled} spellCheck={false} className="font-mono text-[11.5px]" onChange={(e) => onChange(e.target.value)} />
          </Field>
        ) : parsed.error ? (
          <Banner tone="bad">{parsed.error}. Fix it in the Markdown tab.</Banner>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={str(f.name)} disabled={disabled} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label="Role"><Input value={str(f.role)} disabled={disabled} onChange={(e) => set({ role: e.target.value })} /></Field>
              <Field label="Agent id" hint={agent.dbId ? "Stable once saved" : undefined}>
                <Input value={str(f.id)} disabled={disabled || !!agent.dbId} className="font-mono text-xs" onChange={(e) => set({ id: e.target.value.toLowerCase() })} />
              </Field>
              <Field label="Department">
                <Select value={str(f.department)} disabled={disabled} onChange={(e) => set({ department: e.target.value })}>
                  {!depts.some((d) => d.slug === str(f.department)) && <option value={str(f.department)}>{str(f.department) || "—"} (unknown)</option>}
                  {depts.map((d) => <option key={d.key} value={d.slug}>{d.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Mission"><Textarea rows={2} value={str(f.mission)} disabled={disabled} onChange={(e) => set({ mission: e.target.value })} /></Field>
            <Field label="Prompt (instructions)" hint="The Markdown body. Only this agent's instructions are sent with its tasks.">
              <Textarea rows={11} value={parsed.body} disabled={disabled} spellCheck={false} className="font-mono text-[11.5px]" onChange={(e) => set({}, e.target.value)} />
            </Field>

            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">Permitted tools</div>
              <div className="flex flex-wrap gap-2">
                {toolOptions.map((t) => {
                  const on = tools.includes(t.name);
                  const hint = on ? toolHint(t.name) : undefined;
                  return (
                    <button key={t.name} type="button" disabled={disabled} title={t.description}
                      onClick={() => set({ allowed_tools: on ? tools.filter((x) => x !== t.name) : [...tools, t.name] })}
                      className={cx("rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-60",
                        on ? hint ? "border-warn/40 bg-warn/10 text-warn" : "border-accent/40 bg-accent/12 text-[#c3bbff]" : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2")}>
                      <span className="font-mono">{t.name}</span>
                      {hint && <span className="block text-[10px] opacity-80">{hint}</span>}
                    </button>
                  );
                })}
                {tools.filter((t) => !toolOptions.some((x) => x.name === t)).map((t) => (
                  <span key={t} className="rounded-lg border border-bad/40 bg-bad/10 px-2.5 py-1.5 font-mono text-xs text-bad">
                    {t} ({t.startsWith("mcp__") ? "MCP tool not approved" : "unknown"})
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-3">Requested tools never grant access on their own: the backend intersects them with org policy, integrations and plan approval.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Output schema">
                <Select value={str(f.output_schema)} disabled={disabled} onChange={(e) => set({ output_schema: e.target.value })}>
                  {(catalog?.output_schemas ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Model (optional)"><Input value={str(f.model)} placeholder="org default" disabled={disabled} onChange={(e) => set({ model: e.target.value || undefined })} /></Field>
            </div>
            <Field label="Responsibilities" hint="One per line">
              <Textarea rows={3} value={list(f.responsibilities).join("\n")} disabled={disabled}
                onChange={(e) => set({ responsibilities: e.target.value.split("\n").filter((l) => l.trim()) })} />
            </Field>
            <Field label="Acceptance criteria" hint="One per line. The independent reviewer checks every criterion.">
              <Textarea rows={3} value={list(f.acceptance_criteria).join("\n")} disabled={disabled}
                onChange={(e) => set({ acceptance_criteria: e.target.value.split("\n").filter((l) => l.trim()) })} />
            </Field>

            <div className="rounded-xl border border-line p-3">
              <div className="mb-2 text-xs font-medium text-ink-2">Verification</div>
              {([["independent_review", "Independent review against acceptance criteria"], ["require_cited_evidence", "Cited sources must have been retrieved"],
                ["syntax_check", "Parse Python / JSON / YAML / TOML files"]] as const).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between py-1.5 text-xs text-ink-2">
                  {label}
                  <Toggle label={label} checked={verification[k] === true || (k === "independent_review" && verification[k] === undefined)} disabled={disabled}
                    onChange={(v) => set({ verification: { ...verification, [k]: v } })} />
                </div>
              ))}
              <div className="flex items-center justify-between py-1.5 text-xs text-ink-2">
                Minimum retrieved sources
                <Input type="number" min={0} max={20} className="h-7 w-20" value={str(verification.min_sources, "0")} disabled={disabled}
                  onChange={(e) => set({ verification: { ...verification, min_sources: num(e.target.value) ?? 0 } })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max steps"><Input type="number" min={1} max={40} value={str(limits.max_steps, "12")} disabled={disabled}
                onChange={(e) => set({ limits: { ...limits, max_steps: num(e.target.value) } })} /></Field>
              <Field label="Timeout (seconds)"><Input type="number" min={30} max={1800} value={str(limits.timeout_seconds, "300")} disabled={disabled}
                onChange={(e) => set({ limits: { ...limits, timeout_seconds: num(e.target.value) } })} /></Field>
            </div>
          </>
        )}

        {agent.check && (agent.check.valid
          ? <Banner tone="ok">Valid specification.{agent.check.unavailable && Object.keys(agent.check.unavailable).length > 0 &&
              ` Unavailable at runtime: ${Object.entries(agent.check.unavailable).map(([k, v]) => `${k} (${v})`).join("; ")}.`}</Banner>
          : <Banner tone="bad">Validation failed<ul className="mt-1 list-disc pl-4 text-xs">{agent.check.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}</ul></Banner>)}

        <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-line bg-panel px-4 py-3">
          {mode === "existing" && (
            <Input placeholder="Change note (optional), e.g. tighter limits" value={note} maxLength={300} disabled={disabled} onChange={(e) => setNote(e.target.value)} />
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<ShieldCheck className="size-3.5" />} loading={busy === "validate-one"} disabled={!!busy} onClick={onValidate}>Validate</Button>
            {mode === "existing" && (
              <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={busy === "agent"} disabled={!!busy || !dirty || disabled}
                onClick={() => { onSave(note); setNote(""); }}>{agent.dbId ? "Save new version" : "Create agent"}</Button>
            )}
            {agent.dbId && agent.savedMd !== undefined && dirty && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={disabled} onClick={() => onChange(agent.savedMd!)}>Revert</Button>
            )}
            {!agent.dbId && <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} disabled={disabled} onClick={onRemove}>Remove</Button>}
            {agent.dbId && <Link href={`/agents/${agent.dbId}`} className="ml-auto self-center text-xs text-ink-3 hover:text-ink">Agent details →</Link>}
          </div>
          {disabled && <p className="text-[11px] text-ink-3">Only admins can edit agents.</p>}
        </div>
      </div>
    </>
  );
}
