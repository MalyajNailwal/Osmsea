import { cx } from "./ui";

/** Persona colours (backend: specs.PERSONA_COLORS). */
export const PERSONA_HEX: Record<string, string> = {
  blue: "#4aa3e8", green: "#3fbf6e", yellow: "#f2c94c", orange: "#f2994a", red: "#eb6262",
  pink: "#f17ab8", violet: "#9b74f2", teal: "#2ebfb3", gray: "#8a8f98",
};

export const personaHex = (color: string | null | undefined) => PERSONA_HEX[color ?? ""] ?? PERSONA_HEX.gray;

/** An agent's face: a persona-coloured circle with two tall, slightly tilted eyes. */
export function AgentFace({ color, size = 36, className, title }: { color?: string | null; size?: number; className?: string; title?: string }) {
  const eye = { width: Math.max(2, size * 0.1), height: Math.max(4, size * 0.27) };
  return (
    <span title={title} aria-hidden={!title} className={cx("inline-flex shrink-0 items-center justify-center rounded-full", className)}
      style={{ width: size, height: size, background: personaHex(color) }}>
      <span className="flex" style={{ gap: size * 0.13, transform: `translate(${size * 0.04}px, ${-size * 0.06}px) rotate(12deg)` }}>
        <span className="rounded-full bg-[#161616]" style={eye} />
        <span className="rounded-full bg-[#161616]" style={eye} />
      </span>
    </span>
  );
}

/** A person's avatar: initials on a neutral circle. */
export function PersonFace({ label, size = 36 }: { label: string; size?: number }) {
  const initials = label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#333333] font-semibold text-ink-2"
      style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {initials}
    </span>
  );
}
