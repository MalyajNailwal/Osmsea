"use client";

import { Link2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { unwrap, useLive, useNow } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { useApp } from "./providers";
import { Badge, Banner, Button, Card, CardHeader, CopyButton, Input, Modal, Select, Skeleton } from "./ui";

const ROLES = ["viewer", "member", "admin"] as const;
const ROLE_HINT: Record<string, string> = {
  viewer: "read everything", member: "+ submit goals", admin: "+ approve plans, edit agents, settings and integrations",
};

export function MembersSection() {
  const { org, can, session, reloadOrgs } = useApp();
  const router = useRouter();
  const now = useNow();
  const orgId = org?.id;
  const isAdmin = can("admin");
  const me = session?.user.id;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("member");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const { data, reload } = useLive(async () => {
    if (!orgId) return null;
    const [members, invitations] = await Promise.all([
      supabase.from("organization_members").select("*").eq("org_id", orgId).order("created_at").then(unwrap),
      supabase.from("invitations").select("id, email, role, created_at, expires_at, accepted_at, revoked_at").eq("org_id", orgId)
        .is("accepted_at", null).is("revoked_at", null).order("created_at", { ascending: false }).then(unwrap),
    ]);
    return { members, invitations };
  }, [orgId], { orgId, tables: ["organization_members", "invitations"] });

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ tone: "ok", text });
      reload();
    } catch (e) {
      setMessage({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!orgId) return null;
  return (
    <Card>
      <CardHeader title="Members" icon={<UserPlus className="size-4" />}
        subtitle="Roles are enforced by the backend on every write and by row-level security on every read." />
      {message && <Banner tone={message.tone} className="mx-5 mb-3">{message.text}</Banner>}

      {isAdmin && (
        <form className="mx-5 mb-4 flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault();
          void act("invite", async () => {
            const row = await api.invite(orgId, email.trim(), role);
            setLink({ email: row.email, url: row.url });
            setEmail("");
          });
        }}>
          <Input className="min-w-0 flex-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
          <Select className="w-32" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Button type="submit" variant="primary" icon={<Link2 className="size-4" />} loading={busy === "invite"} disabled={!email.includes("@")}>
            Create invite link
          </Button>
          <p className="w-full text-[11px] text-ink-3">{role}: {ROLE_HINT[role]}</p>
        </form>
      )}

      <div className="divide-y divide-line border-t border-line">
        {!data ? <Skeleton className="m-5 h-24" /> : data.members.map((m) => {
          const self = m.user_id === me;
          return (
            <div key={m.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-xs font-semibold uppercase">
                {(m.email || "?").slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1 truncate text-sm text-ink">{m.email || m.user_id}{self && <span className="text-ink-3"> (you)</span>}</div>
              {isAdmin && !self && m.role !== "owner" ? (
                <Select className="w-28" value={m.role} disabled={!!busy}
                  onChange={(e) => act(`role-${m.user_id}`, async () => { await api.setMemberRole(orgId, m.user_id, e.target.value); return `${m.email} is now ${e.target.value}.`; })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              ) : <Badge tone={m.role === "owner" || m.role === "admin" ? "accent" : "neutral"}>{m.role}</Badge>}
              <span className="w-28 text-right text-[11px] text-ink-3">joined {timeAgo(m.created_at, now)}</span>
              {m.role !== "owner" && (self || isAdmin) && (
                <Button size="sm" variant="danger" loading={busy === `remove-${m.user_id}`}
                  onClick={() => window.confirm(self ? `Leave ${org?.name}? You lose access immediately.` : `Remove ${m.email}? Their API tokens stop working too.`) &&
                    act(`remove-${m.user_id}`, async () => {
                      await api.removeMember(orgId, m.user_id);
                      if (self) {
                        await reloadOrgs();
                        router.push("/");
                        return;
                      }
                      return `${m.email} removed.`;
                    })}>
                  {self ? "Leave" : "Remove"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {!!data?.invitations.length && (
        <div className="border-t border-line px-5 py-3">
          <div className="mb-2 text-xs font-medium text-ink-2">Pending invitations</div>
          <div className="space-y-1.5">
            {data.invitations.map((i) => {
              const expired = new Date(i.expires_at).getTime() <= now;
              return (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel-2/40 px-3 py-2 text-xs">
                  <span className="text-ink">{i.email}</span>
                  <Badge>{i.role}</Badge>
                  {expired ? <Badge tone="warn">expired</Badge> : <span className="text-ink-3">expires {dateTime(i.expires_at)}</span>}
                  {isAdmin && (
                    <Button size="sm" variant="ghost" className="ml-auto" loading={busy === `revoke-${i.id}`}
                      onClick={() => act(`revoke-${i.id}`, async () => { await api.revokeInvite(orgId, i.id); return `Invitation for ${i.email} revoked.`; })}>
                      Revoke
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Modal open={!!link} onClose={() => setLink(null)} wide title={`Invite link for ${link?.email ?? ""}`}
        footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        {link && (
          <div className="space-y-3">
            <Banner tone="warn">Copy it now: the link is shown once. It works once, only for {link.email}, and expires in 7 days.</Banner>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-[#161616] px-3 py-2 font-mono text-[12px] text-ink">{link.url}</code>
              <CopyButton text={link.url} />
            </div>
            <p className="text-xs text-ink-3">Send it to them however you like. They sign in or create an account with {link.email}, confirm the address, and accept.</p>
          </div>
        )}
      </Modal>
    </Card>
  );
}
