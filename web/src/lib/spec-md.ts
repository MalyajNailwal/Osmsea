import { parse, stringify } from "yaml";

/**
 * Agent spec Markdown: YAML frontmatter + instructions body. The backend (osmsea.specs) is the
 * validator of record; this module only splits/joins so forms and the raw editor stay in sync.
 */
export type Frontmatter = Record<string, unknown>;

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function splitSpec(md: string): { front: Frontmatter; body: string; error: string | null } {
  const m = FRONTMATTER.exec(md);
  if (!m) return { front: {}, body: md, error: "missing YAML frontmatter (the file must start with a '---' block)" };
  try {
    const front = parse(m[1]);
    if (!front || typeof front !== "object" || Array.isArray(front)) return { front: {}, body: m[2].trim(), error: "frontmatter must be a YAML mapping" };
    return { front: front as Frontmatter, body: m[2].trim(), error: null };
  } catch (e) {
    return { front: {}, body: m[2].trim(), error: `invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function joinSpec(front: Frontmatter, body: string): string {
  return `---\n${stringify(front, { lineWidth: 100 })}---\n\n${body.trim()}\n`;
}

/** Update frontmatter fields (undefined removes a key) while keeping the body. */
export function patchSpec(md: string, patch: Frontmatter, body?: string): string {
  const { front, body: oldBody } = splitSpec(md);
  const next: Frontmatter = { ...front };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return joinSpec(next, body ?? oldBody);
}

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));
export const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A minimal spec that passes backend validation, used for "+ Add agent". */
export function newAgentMarkdown(id: string, department: string): string {
  return joinSpec(
    {
      id,
      name: "New Agent",
      department,
      role: "Specialist",
      mission: "Describe the outcome this agent is responsible for.",
      responsibilities: ["Describe one responsibility"],
      capabilities: ["summarization"],
      limitations: ["Cannot execute code or modify external systems"],
      allowed_tools: ["memory_search"],
      inputs: ["The task description and outputs of prerequisite tasks"],
      outputs: ["A structured written report"],
      output_schema: "report_v1",
      acceptance_criteria: ["The report directly answers the task"],
      verification: { independent_review: true },
      escalation: { max_attempts: 2, on_failure: "Explain what information is missing and stop." },
      limits: { max_steps: 10, timeout_seconds: 300 },
    },
    "1. Read the task and any prerequisite outputs.\n2. Use `memory_search` to find relevant verified knowledge.\n" +
      "3. Write a concise, well-structured report.\n4. Call submit_result exactly once with output matching report_v1.",
  );
}
