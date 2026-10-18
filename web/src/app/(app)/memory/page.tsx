"use client";

import { Brain, ExternalLink, Maximize2, Minus, Plus, Search, Tags, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type GraphEdge, type GraphNode, KindGlyph, KINDS, MemoryGraph } from "@/components/memory-graph";
import { useApp } from "@/components/providers";
import {
  Badge, Banner, Button, Card, cx, EmptyState, Field, Input, Markdown, Modal, Segmented, Select, Spinner, Tabs, Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

type Source = { url?: string; title?: string; verified?: boolean | "human"; added_by?: string; agent?: string; task_key?: string };
type Item = {
  id: string; kind: string; title: string; content: string; source: Source; tags: string[];
  agent_id: string | null; workflow_id: string | null; created_at: string;
};
type Provenance = "all" | "agent" | "human";

function hostname(url?: string): string | null {
  if (!url || url.startsWith("memory:")) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function AddNoteModal({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId: string }) {
  const [kind, setKind] = useState<"note" | "decision">("note");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addMemory(orgId, { kind, title: title.trim(), content: content.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
      setTitle(""); setContent(""); setTags("");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to shared memory" footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!title.trim() || !content.trim()} onClick={save}>Save</Button>
      </>
    }>
      <div className="space-y-3">
        <p className="text-xs text-ink-3">Member-added items are labelled as human-added; agents can find them with memory_search but they are not runtime-verified.</p>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "note" | "decision")}>
            <option value="note">Note</option>
            <option value="decision">Decision</option>
          </Select>
        </Field>
        <Field label="Title"><Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Content" hint="Markdown supported."><Textarea rows={6} value={content} maxLength={20000} onChange={(e) => setContent(e.target.value)} /></Field>
        <Field label="Tags" hint="Comma separated, up to 10."><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pricing, competitors" /></Field>
        {error && <Banner tone="bad">{error}</Banner>}
      </div>
    </Modal>
  );
}

export default function MemoryPage() {
  const { org, can } = useApp();
  const orgId = org?.id ?? null;
  const now = useNow();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(KINDS));
  const [provenance, setProvenance] = useState<Provenance>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"inspect" | "legend">("inspect");
  const [labels, setLabels] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [zoom, setZoom] = useState({ n: 0, factor: 1 });
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data, loading, error } = useLive(async () => {
    if (!orgId) return null;
    const [items, agents, total] = await Promise.all([
      supabase.rpc("search_memory", { p_org: orgId, p_query: query, p_limit: 200 }).then(unwrap),
      supabase.from("agents").select("id, name").eq("org_id", orgId).then(unwrap),
      supabase.from("memory_items").select("id", { count: "exact", head: true }).eq("org_id", orgId)
        .then((r) => { if (r.error) throw new Error(r.error.message); return r.count ?? 0; }),
    ]);
    return { items: items as unknown as Item[], agents: new Map(agents.map((a) => [a.id, a.name])), total };
  }, [orgId, query], { orgId, tables: ["memory_items"] });

  const items = useMemo(() => (data?.items ?? []).filter((i) => {
    if (!kinds.has(i.kind)) return false;
    const verified = i.source?.verified;
    if (provenance === "agent") return verified === true;
    if (provenance === "human") return verified === "human";
    return true;
  }), [data, kinds, provenance]);

  const graph = useMemo(() => {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    for (const i of items) {
      const id = `m:${i.id}`;
      nodes.set(id, { id, type: "item", label: i.title, kind: i.kind });
      const host = hostname(i.source?.url);
      if (host) {
        if (!nodes.has(`s:${host}`)) nodes.set(`s:${host}`, { id: `s:${host}`, type: "source", label: host });
        edges.push({ source: id, target: `s:${host}`, rel: "cites" });
      }
      if (i.agent_id) {
        const aid = `a:${i.agent_id}`;
        if (!nodes.has(aid)) nodes.set(aid, { id: aid, type: "agent", label: data?.agents.get(i.agent_id) ?? "Unknown agent" });
        edges.push({ source: id, target: aid, rel: "produced_by" });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }, [items, data]);

  const sourceCount = useMemo(() => new Set((data?.items ?? []).map((i) => hostname(i.source?.url)).filter(Boolean)).size, [data]);

  const select = (id: string | null) => {
    setSelected(id);
    setConfirmDelete(false);
    setDeleteError(null);
    if (id) setPanel("inspect");
  };

  const selectedItem = selected?.startsWith("m:") ? items.find((i) => `m:${i.id}` === selected) : undefined;
  const related = selected && !selectedItem
    ? items.filter((i) => (selected.startsWith("s:") ? `s:${hostname(i.source?.url)}` === selected : `a:${i.agent_id}` === selected))
    : [];

  const remove = async (id: string) => {
    if (!orgId) return;
    try {
      await api.deleteMemory(orgId, id);
      select(null);
    } catch (e) {
      setDeleteError(errorMessage(e));
    }
  };

  const toggleKind = (k: string) => setKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  if (!org) return null;
  const empty = !loading && data && data.total === 0;

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Shared Memory</h1>
          <p className="mt-1 text-sm text-ink-2">
            {data?.total ?? 0} items · {sourceCount} sources · verified findings, decisions and evidence from completed tasks
          </p>
        </div>
        {can("member") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add note</Button>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[280px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder='Search memory… (supports "quoted phrases", or, -exclude)'
            className="h-11 rounded-full pl-10" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => (
            <button key={k} onClick={() => toggleKind(k)} aria-pressed={kinds.has(k)}
              className={cx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize transition-colors",
                kinds.has(k) ? "border-line-strong bg-panel-2 text-ink" : "border-line text-ink-3 line-through")}>
              <KindGlyph kind={k} size={11} /> {k}
            </button>
          ))}
        </div>
        <Segmented<Provenance> options={[{ id: "all", label: "All" }, { id: "agent", label: "Agent-verified" }, { id: "human", label: "Human-added" }]}
          value={provenance} onChange={setProvenance} />
      </div>

      {error && <Banner tone="bad" className="mb-4">{error}</Banner>}

      {empty ? (
        <Card>
          <EmptyState icon={<Brain className="size-5" />} title="Shared memory is empty"
            description="When a task passes verification, its summary, cited findings and decisions are stored here with their sources. Members can also add notes and decisions that agents can search."
            action={can("member") ? <Button variant="primary" onClick={() => setAdding(true)}>Add the first note</Button> : undefined} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[290px_minmax(0,1fr)_330px]">
          <Card className="flex max-h-[680px] flex-col">
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
              <span className="text-[13px] font-semibold">Results</span>
              <span className="text-[11px] text-ink-3">{items.length}{data && data.items.length === 200 ? "+" : ""} shown</span>
            </div>
            <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {loading && !data && <div className="grid place-items-center py-10"><Spinner /></div>}
              {items.map((i) => (
                <button key={i.id} onClick={() => select(`m:${i.id}`)}
                  className={cx("w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                    selected === `m:${i.id}` ? "bg-accent-soft" : "hover:bg-white/[0.04]")}>
                  <div className="flex items-start gap-2">
                    <span className="mt-1"><KindGlyph kind={i.kind} size={11} /></span>
                    <span className="line-clamp-2 text-[13px] text-ink">{i.title}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-[19px] text-[11px] text-ink-3">
                    <span className="capitalize">{i.kind}</span>
                    {hostname(i.source?.url) && <span className="truncate">· {hostname(i.source?.url)}</span>}
                    <span className="ml-auto shrink-0">{timeAgo(i.created_at, now)}</span>
                  </div>
                </button>
              ))}
              {data && !items.length && <p className="px-2.5 py-8 text-center text-xs text-ink-3">No items match these filters.</p>}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="text-[13px] font-semibold">Knowledge graph</span>
              <Badge>{graph.nodes.length} nodes · {graph.edges.length} edges</Badge>
              <div className="ml-auto flex items-center gap-1 rounded-xl border border-line bg-[#090b14] p-1">
                <button onClick={() => setLabels((v) => !v)} aria-pressed={labels} title="Toggle labels"
                  className={cx("rounded-lg p-1.5", labels ? "bg-accent-soft text-[#a99fff]" : "text-ink-3 hover:text-ink")}><Tags className="size-4" /></button>
                <button onClick={() => setZoom((z) => ({ n: z.n + 1, factor: 1.3 }))} title="Zoom in" className="rounded-lg p-1.5 text-ink-3 hover:text-ink"><Plus className="size-4" /></button>
                <button onClick={() => setZoom((z) => ({ n: z.n + 1, factor: 1 / 1.3 }))} title="Zoom out" className="rounded-lg p-1.5 text-ink-3 hover:text-ink"><Minus className="size-4" /></button>
                <button onClick={() => setFitSignal((s) => s + 1)} title="Fit to view" className="rounded-lg p-1.5 text-ink-3 hover:text-ink"><Maximize2 className="size-4" /></button>
              </div>
            </div>
            <div className="dot-grid">
              {graph.nodes.length ? (
                <MemoryGraph nodes={graph.nodes} edges={graph.edges} selectedId={selected} onSelect={select}
                  showLabels={labels} fitSignal={fitSignal} zoomSignal={zoom} height={620} />
              ) : (
                <div className="grid h-[620px] place-items-center text-xs text-ink-3">{loading ? <Spinner /> : "Nothing to draw for these filters."}</div>
              )}
            </div>
            <div className="border-t border-line px-4 py-2 text-[11px] text-ink-3">
              Scroll to zoom · drag the canvas to pan · drag nodes to rearrange · click a node to inspect
            </div>
          </Card>

          <Card className="flex max-h-[680px] flex-col">
            <div className="px-3 pt-2">
              <Tabs tabs={[{ id: "inspect" as const, label: "Inspection" }, { id: "legend" as const, label: "Legend" }]} value={panel} onChange={setPanel} />
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {panel === "legend" ? (
                <div className="space-y-4 text-sm">
                  <div>
                    <div className="mb-2 text-xs font-medium text-ink-2">Memory kinds (color + shape)</div>
                    {KINDS.map((k) => (
                      <div key={k} className="flex items-center gap-2.5 py-1 capitalize text-ink-2"><KindGlyph kind={k} size={14} /> {k}</div>
                    ))}
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium text-ink-2">Other nodes</div>
                    <div className="flex items-center gap-2.5 py-1 text-ink-2"><KindGlyph kind="source" size={14} /> Source (website cited)</div>
                    <div className="flex items-center gap-2.5 py-1 text-ink-2"><KindGlyph kind="agent" size={14} /> Agent (produced the item)</div>
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium text-ink-2">Edges</div>
                    <div className="flex items-center gap-2.5 py-1 text-ink-2"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#a5abc4" /></svg> cites</div>
                    <div className="flex items-center gap-2.5 py-1 text-ink-2"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#a5abc4" strokeDasharray="3 3" /></svg> produced by</div>
                  </div>
                </div>
              ) : selectedItem ? (
                <div className="space-y-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-md border border-line bg-white/5 px-2 py-0.5 text-[11px] capitalize text-ink-2">
                      <KindGlyph kind={selectedItem.kind} size={11} /> {selectedItem.kind}
                    </span>
                    {selectedItem.source?.verified === true
                      ? <Badge tone="ok" dot>Verified by runtime checks</Badge>
                      : <Badge tone="info" dot>Added by a member</Badge>}
                  </div>
                  <h3 className="text-[15px] font-semibold leading-snug text-ink">{selectedItem.title}</h3>
                  <Markdown>{selectedItem.content}</Markdown>
                  {selectedItem.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">{selectedItem.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
                  )}
                  <dl className="space-y-2 border-t border-line pt-3 text-xs">
                    {selectedItem.source?.url && !selectedItem.source.url.startsWith("memory:") && (
                      <div>
                        <dt className="text-ink-3">Source</dt>
                        <dd><a href={selectedItem.source.url} target="_blank" rel="noopener noreferrer nofollow"
                          className="inline-flex items-center gap-1 break-all text-[#a99fff] hover:underline">
                          {selectedItem.source.title || selectedItem.source.url} <ExternalLink className="size-3 shrink-0" /></a></dd>
                      </div>
                    )}
                    {selectedItem.agent_id && (
                      <div><dt className="text-ink-3">Produced by</dt>
                        <dd><Link href={`/agents/${selectedItem.agent_id}`} className="text-ink hover:underline">{data?.agents.get(selectedItem.agent_id) ?? "Unknown agent"}</Link></dd></div>
                    )}
                    {selectedItem.workflow_id && (
                      <div><dt className="text-ink-3">Workflow</dt>
                        <dd><Link href={`/tasks/${selectedItem.workflow_id}`} className="text-ink hover:underline">
                          Open run{selectedItem.source?.task_key ? ` · task ${selectedItem.source.task_key}` : ""} →</Link></dd></div>
                    )}
                    {selectedItem.source?.added_by && <div><dt className="text-ink-3">Added by</dt><dd className="text-ink">{selectedItem.source.added_by}</dd></div>}
                    <div><dt className="text-ink-3">Created</dt><dd className="text-ink tabular">{dateTime(selectedItem.created_at)}</dd></div>
                  </dl>
                  {can("admin") && (
                    <div className="border-t border-line pt-3">
                      {confirmDelete ? (
                        <div className="flex gap-2">
                          <Button size="sm" variant="danger" onClick={() => remove(selectedItem.id)}>Confirm delete</Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>Delete item</Button>
                      )}
                      {deleteError && <Banner tone="bad" className="mt-2">{deleteError}</Banner>}
                    </div>
                  )}
                </div>
              ) : selected ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <KindGlyph kind={selected.startsWith("s:") ? "source" : "agent"} size={14} />
                    <span className="text-xs text-ink-3">{selected.startsWith("s:") ? "Source" : "Agent"}</span>
                  </div>
                  <h3 className="text-[15px] font-semibold text-ink">
                    {graph.nodes.find((n) => n.id === selected)?.label}
                  </h3>
                  {selected.startsWith("a:") && (
                    <Link href={`/agents/${selected.slice(2)}`} className="text-xs text-[#a99fff] hover:underline">Open agent →</Link>
                  )}
                  <div className="text-xs text-ink-3">{related.length} linked item(s)</div>
                  <div className="space-y-1">
                    {related.map((i) => (
                      <button key={i.id} onClick={() => select(`m:${i.id}`)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]">
                        <span className="mt-1"><KindGlyph kind={i.kind} size={11} /></span>
                        <span className="line-clamp-2 text-[13px] text-ink-2">{i.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState icon={<Brain className="size-5" />} title="Select a node"
                  description="Click a memory item, source or agent in the graph or the results list to see its content and provenance." />
              )}
            </div>
          </Card>
        </div>
      )}
      {orgId && <AddNoteModal open={adding} onClose={() => setAdding(false)} orgId={orgId} />}
    </div>
  );
}
