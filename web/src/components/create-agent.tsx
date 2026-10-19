"use client";

import { Check, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { type AgentDraft, api, errorMessage } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { list, obj, splitSpec, str } from "@/lib/spec-md";
import { AgentFace } from "./agent-face";
import { Badge, Banner, Button, Modal, Segmented, Skeleton, Textarea } from "./ui";

type Tab = "library" | "describe";

const IDEAS = [
  "Plan our team offsite in Goa: flights from Delhi and Bangalore, a villa for 12, under ₹3 lakh",
  "Answer customer questions about our refund and shipping policy from our docs",
  "Write three LinkedIn posts a week in our founder's voice",
  "Keep me going to the gym three times a week with simple plans",
];

/** Add an agent to the organization: pick a ready-made persona, or describe a use case and get a drafted agent to review. */
export function CreateAgentModal({ orgId, open, onClose, existingSlugs, onCreated }: {
  orgId: string; open: boolean; onClose: () => void; existingSlugs: Set<string>; onCreated: (agentId: string, name: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("library");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const { data: library } = useLive(async () => (open ? api.library() : null), [open]);

  const run = async (key: string, fn: () => Promise<void>) => {
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

  const preview = draft ? splitSpec(draft.source_md) : null;
  const persona = obj(preview?.front.persona);

  return (
    <Modal open={open} onClose={onClose} wide title="Add an agent">
      <div className="space-y-4">
        <Segmented value={tab} onChange={setTab} options={[{ id: "library", label: "Persona library" }, { id: "describe", label: "Describe your own" }]} />
        {error && <Banner tone="bad">{error}</Banner>}

        {tab === "library" && (
          <div className="grid max-h-[60vh] gap-2.5 overflow-y-auto sm:grid-cols-2">
            {!library ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />) : library.map((t) => {
              const added = existingSlugs.has(t.id);
              return (
                <div key={t.id} className="flex gap-3 rounded-xl border border-line bg-panel-2/40 p-3">
                  <AgentFace color={t.persona?.color} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{t.name}</span>
                      <Button size="sm" variant={added ? "ghost" : "secondary"} className="ml-auto" disabled={added || !!busy}
                        loading={busy === t.id} icon={added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                        onClick={() => run(t.id, async () => { const row = await api.addLibraryAgent(orgId, t.id); onCreated(row.id, t.name); })}>
                        {added ? "Added" : "Add"}
                      </Button>
                    </div>
                    <div className="text-xs text-ink-2">{t.persona?.tagline}</div>
                    <p className="mt-1 line-clamp-2 text-[11px] text-ink-3">{t.persona?.voice}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">{t.tools.map((tool) => <Badge key={tool}>{tool}</Badge>)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "describe" && (
          <div className="space-y-3">
            <Textarea rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this agent do for you? Who is it for, what does it need to know, what should it never do?" />
            <div className="flex flex-wrap gap-1.5">
              {IDEAS.map((idea) => (
                <button key={idea} onClick={() => setDescription(idea)}
                  className="rounded-full border border-line px-2.5 py-1 text-left text-[11px] text-ink-3 hover:border-line-strong hover:text-ink-2">
                  {idea}
                </button>
              ))}
            </div>
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === "draft"} disabled={description.trim().length < 10}
              onClick={() => run("draft", async () => setDraft(await api.draftAgent(orgId, description.trim())))}>
              Draft my agent
            </Button>

            {draft && preview && (
              <div className="space-y-3 rounded-xl border border-line bg-panel-2/40 p-4">
                <div className="flex items-center gap-3">
                  <AgentFace color={str(persona.color)} size={44} />
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{str(preview.front.name, "Unnamed agent")}</div>
                    <div className="text-xs text-ink-2">{str(persona.tagline) || str(preview.front.role)}</div>
                  </div>
                  {draft.valid ? <Badge tone="ok" className="ml-auto">Valid</Badge> : <Badge tone="bad" className="ml-auto">Needs fixes</Badge>}
                </div>
                {str(persona.voice) && <p className="text-xs text-ink-3">Voice: {str(persona.voice)}</p>}
                <div className="flex flex-wrap gap-1">{list(preview.front.allowed_tools).map((t) => <Badge key={t}>{t}</Badge>)}</div>
                {draft.errors.length > 0 && <Banner tone="warn"><ul className="list-disc pl-4 text-xs">{draft.errors.map((e) => <li key={e}>{e}</li>)}</ul></Banner>}
                <details>
                  <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">Edit the full spec</summary>
                  <Textarea rows={14} spellCheck={false} className="mt-2 font-mono text-[12px]" value={draft.source_md}
                    onChange={(e) => setDraft({ ...draft, source_md: e.target.value })} />
                </details>
                <Button variant="success" loading={busy === "create"}
                  onClick={() => run("create", async () => {
                    const row = await api.createQuickAgent(orgId, draft.source_md);
                    onCreated(row.id, str(preview.front.name, "Agent"));
                    setDraft(null);
                    setDescription("");
                  })}>
                  Create agent
                </Button>
                <p className="text-[11px] text-ink-3">The backend validates the spec again; tools are still limited by your organization&apos;s policy and integrations.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
