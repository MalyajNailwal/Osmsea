"use client";

import { BookOpen, FileText, Globe, Search, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/components/providers";
import { Badge, Banner, Button, Card, CardHeader, cx, EmptyState, Input, PageHeader, Skeleton } from "@/components/ui";
import { api, type DocumentHit, errorMessage } from "@/lib/api";
import { compact, timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

const ACCEPT = ".pdf,.txt,.md,.markdown,.csv,.html,.htm,.json,.yaml,.yml,.py,.ts,.tsx,.js";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function KnowledgePage() {
  const { org, can } = useApp();
  const now = useNow();
  const orgId = org?.id;
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data, reload } = useLive(async () => {
    if (!orgId) return null;
    return supabase.from("documents").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).then(unwrap);
  }, [orgId], { orgId, tables: ["documents"] });

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await fn() });
      reload();
    } catch (e) {
      setMessage({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = (files: FileList | File[]) => act("upload", async () => {
    const added: string[] = [];
    for (const file of Array.from(files)) {  // sequential: each upload is parsed and indexed before the next
      const doc = await api.uploadDocument(orgId!, file);
      added.push(`${doc.title} (${doc.chunks} passages)`);
    }
    return `Added ${added.join(", ")}.`;
  });

  if (!org) return null;
  const canAdd = can("member");

  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader title="Knowledge Base"
        subtitle="Documents your agents can search and cite. Citations point to exact passages and are checked like any other source." />
      {message && <Banner tone={message.tone} className="mb-4">{message.text}</Banner>}

      {canAdd && (
        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
            className={cx("surface flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed px-6 py-8 text-center transition-colors",
              dragging ? "border-accent/60 bg-accent/[0.06]" : "hover:border-line-strong")}>
            <input type="file" multiple accept={ACCEPT} className="sr-only" disabled={!!busy}
              onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} />
            <div className="grid size-11 place-items-center rounded-xl border border-line bg-panel-2 text-[#a99fff]">
              <Upload className={cx("size-5", busy === "upload" && "animate-pulse")} />
            </div>
            <div className="text-sm font-medium text-ink">{busy === "upload" ? "Indexing…" : "Drop files here or click to upload"}</div>
            <div className="text-xs text-ink-3">PDF, Markdown, text, HTML, CSV, JSON, YAML or code · up to 10 MB each · only extracted text is stored</div>
          </label>
          <Card className="p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink"><Globe className="size-4 text-ink-3" /> Save a web page</div>
            <form className="flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              void act("url", async () => { const doc = await api.addDocumentUrl(org.id, url.trim()); setUrl(""); return `Saved “${doc.title}” (${doc.chunks} passages).`; });
            }}>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.com/policy" />
              <Button type="submit" loading={busy === "url"} disabled={!url.trim().startsWith("http")}>Add</Button>
            </form>
            <p className="mt-2 text-[11px] text-ink-3">Fetched once with the same SSRF protection as agents (public addresses only). Re-add to refresh.</p>
          </Card>
        </div>
      )}

      <Card className="mb-4">
        <CardHeader title="Try a search" icon={<Search className="size-4" />} subtitle="What an agent sees when it calls knowledge_search." />
        <div className="px-5 pb-5">
          <form className="flex gap-2" onSubmit={(e) => {
            e.preventDefault();
            void act("search", async () => { const r = await api.searchDocuments(org.id, query.trim()); setHits(r); return `${r.length} passage(s) found.`; });
          }}>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="refund policy" />
            <Button type="submit" loading={busy === "search"} disabled={!query.trim()}>Search</Button>
          </form>
          {hits && (
            <div className="mt-3 space-y-2">
              {hits.map((h) => (
                <div key={h.chunk_id} className="rounded-lg border border-line bg-panel-2/40 p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-ink">{h.title}</span>
                    {h.page != null && <Badge>page {h.page}</Badge>}
                    {h.heading && <span className="text-ink-3">· {h.heading}</span>}
                    <span className="ml-auto font-mono text-[10.5px] text-ink-3">doc:{h.document_id.slice(0, 8)}…/{h.ordinal}</span>
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap text-xs text-ink-2">{h.content}</p>
                </div>
              ))}
              {!hits.length && <p className="text-xs text-ink-3">No passages match. Search uses full-text matching on words, not meaning.</p>}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Documents" icon={<BookOpen className="size-4" />}
          subtitle="Agents need knowledge_search in their spec. The template Research Agent and Software Developer have it." />
        <div className="divide-y divide-line border-t border-line">
          {!data ? <Skeleton className="m-5 h-24" /> : data.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              {d.source === "url" ? <Globe className="size-4 text-ink-3" /> : <FileText className="size-4 text-ink-3" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{d.title}</div>
                <div className="truncate text-[11px] text-ink-3">{d.source === "url" ? d.source_url : d.filename}</div>
              </div>
              {d.pages != null && <Badge>{d.pages} pages</Badge>}
              <Badge tone="accent">{compact(d.chunks)} passages</Badge>
              <span className="w-16 text-right text-[11px] text-ink-3 tabular">{size(d.bytes)}</span>
              <span className="w-20 text-right text-[11px] text-ink-3">{timeAgo(d.created_at, now)}</span>
              {can("admin") && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={busy === `delete-${d.id}`} aria-label={`Delete ${d.title}`}
                  onClick={() => window.confirm(`Remove “${d.title}” from the knowledge base? Past citations keep their recorded text.`) &&
                    act(`delete-${d.id}`, async () => { await api.deleteDocument(org.id, d.id); return `Removed “${d.title}”.`; })} />
              )}
            </div>
          ))}
          {data && !data.length && (
            <EmptyState icon={<BookOpen className="size-5" />} title="No documents yet"
              description="Upload handbooks, policies, specs or contracts, and agents will cite exact passages instead of guessing." />
          )}
        </div>
      </Card>
    </div>
  );
}
