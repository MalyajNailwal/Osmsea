"use client";

import { AlertTriangle, Check, Copy, Info, Loader2, X } from "lucide-react";
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, forwardRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

// --- layout ---------------------------------------------------------------------------------------

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("surface", className)} {...rest}>{children}</div>;
}

export function CardHeader({ title, subtitle, icon, actions, className }: {
  title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={cx("flex items-start justify-between gap-3 px-5 pt-4 pb-3", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="text-ink-3">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs text-ink-3">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// --- controls -------------------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref,
) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const sizes = { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm" };
  const variants = {
    primary: "bg-ink text-canvas hover:bg-white",
    secondary: "border border-line-strong bg-panel-2 text-ink hover:bg-panel-3",
    ghost: "text-ink-2 hover:bg-white/5 hover:text-ink",
    danger: "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
    success: "border border-ok/40 bg-ok/10 text-ok hover:bg-ok/20",
  };
  return (
    <button ref={ref} disabled={disabled || loading} className={cx(base, sizes[size], variants[variant], className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

const fieldBase = "rounded-lg border border-line-strong bg-[#161616] px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

/** Full width unless the caller sets its own width (Tailwind can't tell which of two w-* classes wins). */
function field(className?: string) {
  return cx(fieldBase, !/(^|\s)w-/.test(className ?? "") && "w-full", className);
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(field(className), "h-9")} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(field(className), "py-2 leading-relaxed")} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(field(className), "h-9 pr-8")} {...rest}>{children}</select>;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-accent" : "bg-white/15")}>
      <span className={cx("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: ReactNode; count?: number | string }[]; value: T; onChange: (id: T) => void; className?: string;
}) {
  return (
    <div className={cx("flex gap-1 overflow-x-auto border-b border-line", className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx("-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm transition-colors",
            value === t.id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>
          {t.label}
          {t.count !== undefined && <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-ink-2">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-[#161616] p-0.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)}
          className={cx("rounded-md px-2.5 py-1 text-xs transition-colors", value === o.id ? "bg-panel-3 text-ink" : "text-ink-3 hover:text-ink-2")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// --- feedback -------------------------------------------------------------------------------------

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const toneClass: Record<Tone, string> = {
  neutral: "border-white/10 bg-white/5 text-ink-2",
  accent: "border-accent/30 bg-accent/12 text-[#b4abff]",
  ok: "border-ok/25 bg-ok/10 text-ok",
  warn: "border-warn/25 bg-warn/10 text-warn",
  bad: "border-bad/25 bg-bad/10 text-bad",
  info: "border-info/25 bg-info/10 text-info",
};

export function Badge({ tone = "neutral", children, dot, pulse, className }: {
  tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; className?: string;
}) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium", toneClass[tone], className)}>
      {dot && <span className={cx("size-1.5 rounded-full bg-current", pulse && "animate-pulse")} />}
      {children}
    </span>
  );
}

const STATUS: Record<string, { tone: Tone; label: string; pulse?: boolean }> = {
  planning: { tone: "info", label: "Planning", pulse: true },
  plan_failed: { tone: "bad", label: "Plan failed" },
  awaiting_approval: { tone: "warn", label: "Awaiting approval" },
  running: { tone: "accent", label: "Running", pulse: true },
  verifying: { tone: "accent", label: "Verifying", pulse: true },
  completed: { tone: "ok", label: "Completed" },
  succeeded: { tone: "ok", label: "Succeeded" },
  failed: { tone: "bad", label: "Failed" },
  timed_out: { tone: "bad", label: "Timed out" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  rejected: { tone: "neutral", label: "Rejected" },
  pending: { tone: "neutral", label: "Pending" },
  queued: { tone: "info", label: "Queued" },
  blocked: { tone: "warn", label: "Blocked" },
  abandoned: { tone: "warn", label: "Abandoned" },
  active: { tone: "ok", label: "Active" },
  disabled: { tone: "neutral", label: "Disabled" },
  draft: { tone: "neutral", label: "Draft" },
  approved: { tone: "ok", label: "Approved" },
  success: { tone: "ok", label: "Success" },
  failure: { tone: "bad", label: "Failure" },
  denied: { tone: "warn", label: "Denied" },
  proposed: { tone: "info", label: "Proposed" },
  accepted: { tone: "ok", label: "Accepted" },
  superseded: { tone: "neutral", label: "Superseded" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge tone={s.tone} dot pulse={s.pulse} className={className}>{s.label}</Badge>;
}

export function statusTone(status: string): Tone {
  return STATUS[status]?.tone ?? "neutral";
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-ink-3", className)} />;
}

export function Banner({ tone = "info", children, action, className }: {
  tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; action?: ReactNode; className?: string;
}) {
  const Icon = tone === "ok" ? Check : tone === "info" ? Info : AlertTriangle;
  return (
    <div className={cx("flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm", toneClass[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: {
  icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && <div className="mb-3 grid size-11 place-items-center rounded-xl border border-line bg-panel-2 text-ink-3">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-white/5", className)} />;
}

export function Stat({ icon, label, value, sub, accent = "accent" }: {
  icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; accent?: "accent" | "ok" | "warn" | "bad" | "info";
}) {
  const ring = { accent: "text-[#a99fff] bg-accent/12 border-accent/25", ok: "text-ok bg-ok/10 border-ok/25",
    warn: "text-warn bg-warn/10 border-warn/25", bad: "text-bad bg-bad/10 border-bad/25", info: "text-info bg-info/10 border-info/25" }[accent];
  return (
    <Card className="flex items-center gap-4 px-5 py-4">
      <div className={cx("grid size-11 shrink-0 place-items-center rounded-full border", ring)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-ink-3">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold tracking-tight text-ink">{value}</div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</div>}
      </div>
    </Card>
  );
}

// --- overlays -------------------------------------------------------------------------------------

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  // Portal to <body>: a modal opened inside a sticky or transformed container would otherwise be trapped in its stacking context.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal className={cx("surface w-full shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-white/5 hover:text-ink" aria-label="Close"><X className="size-4" /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// --- content --------------------------------------------------------------------------------------

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("markdown text-sm", className)}>
      {/* react-markdown does not render raw HTML, so agent output cannot inject markup. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{c}</a> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="ghost" icon={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({ code, className, maxHeight = "28rem" }: { code: string; className?: string; maxHeight?: string }) {
  return (
    <pre className={cx("overflow-auto rounded-lg border border-line bg-[#161616] p-3.5 font-mono text-[12px] leading-relaxed text-ink-2", className)}
      style={{ maxHeight }}>
      {code}
    </pre>
  );
}

export function download(filename: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
