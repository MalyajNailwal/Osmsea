"use client";

import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type Catalog, errorMessage, type OrgStatus } from "@/lib/api";
import { type Organization, supabase } from "@/lib/supabase";

export type Role = "viewer" | "member" | "admin" | "owner";
export type OrgEntry = Organization & { role: Role };
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const ORG_KEY = "osmsea.org";

type AppContext = {
  session: Session | null;
  authReady: boolean;
  orgs: OrgEntry[];
  orgsLoading: boolean;
  org: OrgEntry | null;
  selectOrg: (id: string) => void;
  reloadOrgs: () => Promise<OrgEntry[]>;
  can: (minimum: Role) => boolean;
  catalog: Catalog | null;
  apiError: string | null;
  status: OrgStatus | null;
  reloadStatus: () => Promise<void>;
};

const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside <Providers>");
  return ctx;
}

/** Convenience for pages that need an organization: org is non-null once loaded. */
export function useOrg() {
  const app = useApp();
  return { ...app, orgId: app.org?.id ?? null };
}

export function Providers({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [orgsLoadedFor, setOrgsLoadedFor] = useState<string | null | undefined>(undefined);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusEntry, setStatusEntry] = useState<{ orgId: string; status: OrgStatus | null } | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  const reloadOrgs = useCallback(async (): Promise<OrgEntry[]> => {
    if (!userId) return [];
    const { data, error } = await supabase
      .from("organization_members")
      .select("role, organizations(*)")
      .eq("user_id", userId);
    if (error) {
      setApiError(error.message);
      setOrgsLoadedFor(userId);
      return [];
    }
    const list = (data ?? [])
      .filter((m) => m.organizations)
      .map((m) => ({ ...(m.organizations as unknown as Organization), role: m.role as Role }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    setOrgs(list);
    setOrgsLoadedFor(userId);
    setOrgId((current) => {
      const saved = current ?? localStorage.getItem(ORG_KEY);
      return list.find((o) => o.id === saved)?.id ?? list[0]?.id ?? null;
    });
    return list;
  }, [userId]);

  useEffect(() => {
    if (!authReady || !userId) return;
    const t = setTimeout(() => void reloadOrgs(), 0);
    api.catalog().then((c) => { setCatalog(c); setApiError(null); }).catch((e) => setApiError(errorMessage(e)));
    return () => clearTimeout(t);
  }, [authReady, userId, reloadOrgs]);

  const reloadStatus = useCallback(async () => {
    if (!orgId) return;
    try {
      const s = await api.status(orgId);
      setStatusEntry({ orgId, status: s });
      setApiError(null);
    } catch (e) {
      setApiError(errorMessage(e));
      setStatusEntry({ orgId, status: null });
    }
  }, [orgId]);

  useEffect(() => {
    const first = setTimeout(() => void reloadStatus(), 0);
    const id = setInterval(() => void reloadStatus(), 20_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [reloadStatus]);

  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    localStorage.setItem(ORG_KEY, id);
  }, []);

  const org = userId ? orgs.find((o) => o.id === orgId) ?? null : null;
  const orgsLoading = !!userId && orgsLoadedFor !== userId;
  const status = statusEntry && statusEntry.orgId === orgId ? statusEntry.status : null;
  const value = useMemo<AppContext>(() => ({
    session, authReady, orgs, orgsLoading, org, selectOrg, reloadOrgs,
    can: (minimum) => !!org && RANK[org.role] >= RANK[minimum],
    catalog, apiError, status, reloadStatus,
  }), [session, authReady, orgs, orgsLoading, org, selectOrg, reloadOrgs, catalog, apiError, status, reloadStatus]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
