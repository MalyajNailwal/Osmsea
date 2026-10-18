"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

type LiveTable =
  | "workflows" | "tasks" | "agent_executions" | "execution_events" | "approvals" | "agents" | "memory_items"
  | "mcp_servers" | "eval_runs" | "eval_results" | "agent_proposals" | "api_tokens" | "triggers";

type LiveState<T> = { data: T | undefined; error: string | null; loading: boolean };

/**
 * Load data, then re-load whenever Supabase Realtime reports a change to one of `tables` for this
 * organization. Realtime respects RLS, so only the member's own organization's changes arrive.
 * Previous data stays visible while a reload is in flight.
 */
export function useLive<T>(
  load: () => Promise<T>,
  deps: unknown[],
  opts: { orgId?: string | null; tables?: LiveTable[] } = {},
) {
  const [state, setState] = useState<LiveState<T>>({ data: undefined, error: null, loading: true });
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => { if (!cancelled) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (!cancelled) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })); },
    );
    return () => { cancelled = true; };
    // `load` is a fresh closure every render; `key` captures the inputs it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const tablesKey = (opts.tables ?? []).join(",");
  useEffect(() => {
    if (!opts.orgId || !tablesKey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase.channel(`live:${tablesKey}:${opts.orgId}:${Math.random().toString(36).slice(2)}`);
    for (const table of tablesKey.split(",")) {
      // Throttle, not debounce: a running task emits events continuously, and a debounce would
      // postpone every refresh until the run went quiet.
      channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `org_id=eq.${opts.orgId}` }, () => {
        if (timer) return;
        timer = setTimeout(() => { timer = undefined; reload(); }, 300);
      });
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [opts.orgId, tablesKey, reload]);

  return { ...state, reload };
}

/** Throw on Supabase query errors so useLive surfaces them. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** Current time that re-renders periodically, so relative times stay fresh without impure renders. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
