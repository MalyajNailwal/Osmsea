"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { useApp } from "@/components/providers";
import { Logo } from "@/components/shell";
import { Banner, Button, Field, Input, Segmented } from "@/components/ui";
import { supabase } from "@/lib/supabase";

/** Where to go after signing in: only same-site paths (no open redirects). */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function LoginPage() {
  const { session } = useApp();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "bad" | "ok"; text: string } | null>(null);

  useEffect(() => {
    if (session) router.replace(nextPath());
  }, [session, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { data, error } = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + nextPath() } });
    setBusy(false);
    if (error) return setMessage({ tone: "bad", text: error.message });
    if (mode === "signup" && !data.session) {
      setMessage({ tone: "ok", text: "Account created. Check your email to confirm it, then sign in." });
      setMode("signin");
    }
  };

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
      <div className="surface relative w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <div className="text-lg font-semibold tracking-tight">OSMSEA</div>
            <div className="text-xs text-ink-3">AI agent organizations, verified.</div>
          </div>
        </div>
        <Segmented options={[{ id: "signin", label: "Sign in" }, { id: "signup", label: "Create account" }]} value={mode} onChange={setMode} />
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password" hint={mode === "signup" ? "At least 6 characters." : undefined}>
            <Input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} required minLength={6}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {message && <Banner tone={message.tone}>{message.text}</Banner>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-3">
          Sessions are handled by Supabase Auth. Data access is enforced by row-level security and server-side role checks.
        </p>
      </div>
    </div>
  );
}
