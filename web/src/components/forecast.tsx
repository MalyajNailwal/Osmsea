"use client";

import { Gauge } from "lucide-react";
import type { Forecast } from "@/lib/api";
import { duration, usd } from "@/lib/format";
import type { Workflow } from "@/lib/supabase";
import { Badge, Card, CardHeader } from "./ui";

const pct = (p: number | null | undefined) => (p == null ? null : `${Math.round(p * 100)}%`);

function secs(s: number | null | undefined): string | null {
  if (s == null) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function Figure({ label, value, actual }: { label: string; value: string | null; actual?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={value ? "text-xl font-semibold tabular text-ink" : "text-sm text-ink-3"}>{value ?? "unknown"}</div>
      {actual !== undefined && <div className="text-[11px] text-ink-3">actual <span className="tabular text-ink-2">{actual ?? "—"}</span></div>}
    </div>
  );
}

/** Forecast computed at planning time from this organization's verified history; after a run, shown next to actuals. */
export function ForecastCard({ forecast, wf, now }: { forecast: Forecast; wf: Workflow; now: number }) {
  const finished = ["completed", "failed", "cancelled"].includes(wf.status);
  const partial = forecast.known_tasks < forecast.total_tasks;
  return (
    <Card className="mb-4">
      <CardHeader title={finished ? "Forecast vs actual" : "Forecast"} icon={<Gauge className="size-4" />}
        subtitle={partial
          ? `From verified history for ${forecast.known_tasks} of ${forecast.total_tasks} tasks. Tasks without history have no estimate, so totals stay unknown.`
          : "From this organization's verified runs and evaluations of each agent on the model it will use. Excludes planning."} />
      <div className="grid gap-5 px-5 pb-4 sm:grid-cols-3">
        <Figure label="Chance every task is verified" value={pct(forecast.success)}
          actual={finished ? (wf.status === "completed" ? "all verified" : wf.status) : undefined} />
        <Figure label="Expected cost (with retries)" value={forecast.cost_usd == null ? null : usd(forecast.cost_usd)}
          actual={finished ? usd(Number(wf.cost_usd)) : undefined} />
        <Figure label="Expected duration (critical path)" value={secs(forecast.duration_s)}
          actual={finished && wf.started_at ? duration(wf.started_at, wf.completed_at, now) : finished ? null : undefined} />
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">
              <th className="px-5 py-2">Task</th><th className="px-2 py-2">Model</th><th className="px-2 py-2 text-right">History</th>
              <th className="px-2 py-2 text-right">Pass / attempt</th><th className="px-2 py-2 text-right">Verified within</th>
              <th className="px-2 py-2 text-right">Cost</th><th className="px-5 py-2 text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {forecast.tasks.map((t) => (
              <tr key={t.key}>
                <td className="px-5 py-2"><span className="font-mono text-ink">{t.key}</span> <span className="text-ink-3">· {t.agent}</span></td>
                <td className="max-w-[200px] truncate px-2 py-2 font-mono text-ink-2" title={t.model ?? ""}>{t.model ?? "default"}</td>
                <td className="px-2 py-2 text-right tabular text-ink-2">{t.runs ? `${t.runs} runs` : <Badge>no history</Badge>}</td>
                <td className="px-2 py-2 text-right tabular text-ink-2">{pct(t.pass_rate) ?? "—"}</td>
                <td className="px-2 py-2 text-right tabular text-ink-2">{t.success == null ? "—" : `${pct(t.success)} · ${t.max_attempts} tries`}</td>
                <td className="px-2 py-2 text-right tabular text-ink-2">{t.cost_usd == null ? "—" : usd(t.cost_usd)}</td>
                <td className="px-5 py-2 text-right tabular text-ink-2">{secs(t.duration_s) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
