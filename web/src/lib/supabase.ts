import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Browser client with the publishable key. Every read is protected by Postgres RLS
 * (members see only their organization's rows); client roles cannot write at all —
 * mutations go through the OSMSEA API, which checks the member's role.
 */
export const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: true, autoRefreshToken: true } },
);

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  (window as unknown as { __osmseaSupabase: typeof supabase }).__osmseaSupabase = supabase; // debugging aid
}

type Tables = Database["public"]["Tables"];
export type Row<T extends keyof Tables> = Tables[T]["Row"];

export type Organization = Row<"organizations">;
export type Department = Row<"departments">;
export type Agent = Row<"agents">;
export type AgentVersion = Row<"agent_versions">;
export type Workflow = Row<"workflows">;
export type Task = Row<"tasks">;
export type Execution = Row<"agent_executions">;
export type ExecutionEvent = Row<"execution_events">;
export type Approval = Row<"approvals">;
export type Artifact = Row<"artifacts">;
export type MemoryItem = Row<"memory_items">;
export type Integration = Row<"integrations">;
export type AuditEvent = Row<"audit_events">;
export type Member = Row<"organization_members">;
export type McpServer = Row<"mcp_servers">;
export type EvalRun = Row<"eval_runs">;
export type EvalResult = Row<"eval_results">;
export type AgentProposal = Row<"agent_proposals">;
export type ApiToken = Row<"api_tokens">;
export type Trigger = Row<"triggers">;
export type Replay = Row<"replays">;
export type Invitation = Row<"invitations">;
export type KnowledgeDocument = Row<"documents">;
export type Action = Row<"actions">;
