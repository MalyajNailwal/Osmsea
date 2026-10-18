"use client";

import { ExternalLink, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useApp } from "./providers";
import { Badge, Banner, Button, Card, CardHeader, StatusBadge } from "./ui";

type Payload = {
  repo: string; base: string | null; branch: string; title: string; tests: string | null;
  files: { path: string; action: string; bytes: number }[]; blocked_paths: string[];
};

const STATUS: Record<string, string> = { pending: "awaiting_approval", running: "running", succeeded: "completed", failed: "failed", rejected: "rejected" };

/** Deliveries proposed from this workflow's verified output (e.g. a draft pull request), each run only after an admin approves. */
export function DeliveriesCard({ orgId, workflowId }: { orgId: string; workflowId: string }) {
  const { can } = useApp();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, reload } = useLive(
    async () => supabase.from("actions").select("*").eq("workflow_id", workflowId).order("created_at").then(unwrap),
    [workflowId], { orgId, tables: ["actions"] });

  if (!data?.length) return null;
  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(`${decision}-${id}`);
    setError(null);
    try {
      await api.decideAction(orgId, id, decision);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4">
      <CardHeader title="Deliveries" icon={<GitPullRequest className="size-4" />}
        subtitle="Built from the verified output by OSMSEA itself, not by the model, and run only after an admin approves." />
      {error && <Banner tone="bad" className="mx-5 mb-3">{error}</Banner>}
      <div className="divide-y divide-line border-t border-line">
        {data.map((a) => {
          const p = a.payload as unknown as Payload;
          const result = a.result as { url?: string; number?: number } | null;
          return (
            <div key={a.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <StatusBadge status={STATUS[a.status] ?? a.status} />
                <span className="text-sm font-medium text-ink">{a.summary}</span>
                <span className="text-[11px] text-ink-3">{timeAgo(a.created_at, now)}</span>
                {result?.url && (
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-sm text-[#b4abff] hover:underline">
                    Pull request #{result.number} <ExternalLink className="size-3.5" />
                  </a>
                )}
                {a.status === "pending" && can("admin") && (
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="ghost" loading={busy === `reject-${a.id}`} onClick={() => decide(a.id, "reject")}>Reject</Button>
                    <Button size="sm" variant="success" loading={busy === `approve-${a.id}`} disabled={p.blocked_paths.length > 0}
                      title={p.blocked_paths.length ? "Contains .github/ changes, which are never delivered automatically" : undefined}
                      onClick={() => decide(a.id, "approve")}>
                      Approve & open PR
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-ink-3">
                <span>Repository <span className="font-mono text-ink-2">{p.repo}</span></span>
                <span>Branch <span className="font-mono text-ink-2">{p.branch}</span> → <span className="font-mono text-ink-2">{p.base ?? "default branch"}</span></span>
                <span>Draft pull request</span>
                {p.tests && <span>Tests: <span className="text-ink-2">{p.tests}</span></span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.files.map((f) => (
                  <Badge key={f.path} tone={p.blocked_paths.includes(f.path) ? "bad" : "neutral"}>
                    <span className="font-mono">{f.path}</span> · {f.bytes.toLocaleString()} B
                  </Badge>
                ))}
              </div>
              {p.blocked_paths.length > 0 && a.status === "pending" && (
                <Banner tone="warn" className="mt-2 text-xs">Changes under .github/ (CI workflows) are never delivered automatically. Copy them from the output if you want them.</Banner>
              )}
              {a.error && <p className="mt-2 text-xs text-bad">{a.error}</p>}
              {a.status === "pending" && !can("admin") && <p className="mt-2 text-xs text-ink-3">Waiting for an admin to approve.</p>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
