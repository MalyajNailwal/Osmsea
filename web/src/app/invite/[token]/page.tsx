"use client";

import { Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/providers";
import { Logo } from "@/components/shell";
import { Badge, Banner, Button, Card, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useLive } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { session, authReady, reloadOrgs, selectOrg } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user.id ?? null;
  const next = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;

  const { data: invite, error: loadError } = useLive(async () => (userId ? api.previewInvite(token) : null), [token, userId]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const { org_id } = await api.acceptInvite(token);
      await reloadOrgs();
      selectOrg(org_id);
      router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const wrongAccount = invite && session?.user.email && session.user.email.toLowerCase() !== invite.email;

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
      <Card className="relative w-full max-w-md p-7">
        <div className="mb-6"><Logo /></div>
        {!authReady ? <Spinner /> : !session ? (
          <>
            <h1 className="text-xl font-semibold">You have been invited to an OSMSEA organization</h1>
            <p className="mt-2 text-sm text-ink-2">Sign in, or create an account with the email address the invitation was sent to.</p>
            <Link href={next} className="mt-5 block"><Button variant="primary" className="w-full">Sign in to accept</Button></Link>
          </>
        ) : loadError ? (
          <Banner tone="bad">{loadError.includes("not found") ? "This invitation link is not valid." : loadError}</Banner>
        ) : !invite ? <Spinner /> : (
          <>
            <div className="mb-4 grid size-11 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-[#b4abff]"><Users className="size-5" /></div>
            <h1 className="text-xl font-semibold">Join {invite.organization}</h1>
            <p className="mt-2 text-sm text-ink-2">
              as <Badge tone="accent">{invite.role}</Badge> · invitation for <span className="text-ink">{invite.email}</span>
            </p>
            <p className="mt-1 text-xs text-ink-3">{invite.status === "pending" ? `Expires ${dateTime(invite.expires_at)}` : `This invitation is ${invite.status}.`}</p>
            {wrongAccount && (
              <Banner tone="warn" className="mt-4">
                You are signed in as {session.user.email}. This invitation only works for {invite.email}.
                <button className="ml-1 underline" onClick={() => void supabase.auth.signOut().then(() => router.replace(next))}>Switch account</button>
              </Banner>
            )}
            {error && <Banner tone="bad" className="mt-4">{error}</Banner>}
            <Button variant="primary" className="mt-5 w-full" loading={busy} disabled={invite.status !== "pending" || !!wrongAccount} onClick={accept}>
              Accept invitation
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
