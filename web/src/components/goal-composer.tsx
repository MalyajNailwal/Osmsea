"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApp } from "./providers";
import { Banner, Button, Modal, Textarea } from "./ui";

const EXAMPLES = [
  "Research the trade-offs between httpx and requests for async Python services and propose a starter client module.",
  "Summarize recent guidance on securing LLM tool use against prompt injection, with sources.",
];

export function GoalComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org, status, can } = useApp();
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noLlm = status && !status.llm.configured;

  const submit = async () => {
    if (!org) return;
    setBusy(true);
    setError(null);
    try {
      const wf = await api.submitGoal(org.id, goal.trim());
      setGoal("");
      onClose();
      router.push(`/tasks/${wf.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Submit a goal" wide footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy}
          disabled={goal.trim().length < 3 || !can("member") || !!noLlm} onClick={submit}>
          Propose plan
        </Button>
      </>
    }>
      <p className="mb-3 text-sm text-ink-2">
        The planner turns your goal into tasks for <span className="text-ink">{org?.name}</span>&apos;s active agents.
        Plans are validated (agents, dependencies, permissions) and, when your policy requires it, wait for approval before anything runs.
      </p>
      <Textarea rows={5} autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={4000}
        placeholder="Describe the outcome you want…" />
      <div className="mt-2 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => setGoal(ex)} className="rounded-md border border-line px-2 py-1 text-left text-[11px] text-ink-3 hover:border-line-strong hover:text-ink-2">
            {ex.slice(0, 70)}…
          </button>
        ))}
      </div>
      {noLlm && (
        <Banner tone="warn" className="mt-3">
          No LLM provider is configured for this organization. <Link href="/integrations" className="underline">Add an OpenRouter key</Link> to enable planning.
        </Banner>
      )}
      {!can("member") && <Banner tone="info" className="mt-3">Viewers cannot submit goals.</Banner>}
      {error && <Banner tone="bad" className="mt-3">{error}</Banner>}
    </Modal>
  );
}
