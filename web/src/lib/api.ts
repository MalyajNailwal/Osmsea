import { type Integration, type McpServer, type Organization, supabase, type Workflow } from "./supabase";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors: string[] = []) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Cannot reach the OSMSEA API at ${API_URL}. Is the backend running?`, 0);
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof json?.detail === "string" ? json.detail : Array.isArray(json?.detail)
      ? json.detail.map((d: { loc?: string[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ")
      : res.statusText;
    throw new ApiError(detail || `Request failed (${res.status})`, res.status, json?.errors ?? []);
  }
  return json as T;
}

// --- contracts (mirror backend/src/osmsea/api.py) ---------------------------------------------

export type ToolInfo = { name: string; description: string; integrations: string[] };
export type OutputSchemaInfo = { name: string; description: string; has_sources: boolean; has_files: boolean };
export type ProviderInfo = {
  id: string; name: string; kind: "llm" | "search"; description: string; secret_label: string;
  docs_url: string; config_fields: Record<string, string>; enables: string[];
};
export type OrgSettings = {
  require_plan_approval: boolean; max_concurrent_tasks: number; task_timeout_seconds: number; max_attempts: number;
  workflow_token_budget: number; max_tasks_per_plan: number; default_model: string | null;
  tool_policy: Record<string, { enabled: boolean; requires_approval: boolean }>;
};
export type Catalog = { tools: ToolInfo[]; output_schemas: OutputSchemaInfo[]; providers: ProviderInfo[]; default_settings: OrgSettings };
export type DraftAgent = { id: string; source_md: string; valid: boolean; errors: string[] };
export type DraftDepartment = { id: string; name: string; description: string };
export type Proposal = {
  name: string; description: string; departments: DraftDepartment[]; agents: DraftAgent[];
  gaps?: string[]; errors?: string[]; model?: string; tokens?: number; cost_usd?: number | null;
};
export type Validation = {
  valid: boolean; errors: string[]; spec?: AgentSpec;
  effective_tools?: { allowed: string[]; unavailable: Record<string, string> };
};
export type AgentSpec = {
  id: string; name: string; department: string; role: string; mission: string; responsibilities: string[];
  capabilities: string[]; limitations: string[]; allowed_tools: string[]; inputs: string[]; outputs: string[];
  output_schema: string; acceptance_criteria: string[];
  verification: { require_cited_evidence: boolean; min_sources: number; syntax_check: boolean; independent_review: boolean };
  escalation: { max_attempts: number; on_failure: string }; limits: { max_steps: number; timeout_seconds: number };
  model?: string | null; instructions: string;
};
export type OrgStatus = {
  llm: { configured: boolean; provider?: string; model?: string; message?: string };
  worker: { enabled: boolean; last_tick: string | null; running_tasks: number };
  invalid_agents: Record<string, string[]>; providers: string[];
};

export type McpToolInfo = { name: string; description: string; input_schema: Record<string, unknown>; approvable: boolean };
export type OrgTools = {
  builtin: { name: string; description: string; integrations: string[]; enabled: boolean; available: boolean }[];
  mcp: { name: string; server: string; server_name: string; tool: string; description: string; require_approval: boolean }[];
};
export type McpServerInput = { name: string; slug: string; url: string; auth_header?: string; secret?: string; require_approval?: boolean };
export type McpServerUpdate = { approved_tools?: string[]; require_approval?: boolean; enabled?: boolean; secret?: string; clear_secret?: boolean };

export const api = {
  catalog: () => request<Catalog>("GET", "/catalog"),
  template: () => request<Proposal>("GET", "/templates/default"),
  health: () => request<{ status: string }>("GET", "/health"),
  propose: (goal: string, orgId?: string) => request<Proposal>("POST", "/orgs/propose", { goal, org_id: orgId ?? null }),
  createOrg: (body: { template?: "default"; name?: string; description?: string; departments?: DraftDepartment[]; agents?: { source_md: string }[] }) =>
    request<Organization>("POST", "/orgs", body),
  updateOrg: (orgId: string, body: { name?: string; description?: string }) => request<Organization>("PATCH", `/orgs/${orgId}`, body),
  status: (orgId: string) => request<OrgStatus>("GET", `/orgs/${orgId}/status`),
  updateSettings: (orgId: string, settings: OrgSettings) => request<OrgSettings>("PUT", `/orgs/${orgId}/settings`, { settings }),
  createDepartment: (orgId: string, body: { slug: string; name: string; description: string }) =>
    request<{ id: string }>("POST", `/orgs/${orgId}/departments`, body),
  updateDepartment: (orgId: string, deptId: string, body: { name: string; description: string }) =>
    request<{ id: string }>("PATCH", `/orgs/${orgId}/departments/${deptId}`, body),
  validateAgent: (orgId: string, source_md: string) => request<Validation>("POST", `/orgs/${orgId}/agents/validate`, { source_md }),
  validateDraft: (source_md: string) => request<Validation>("POST", "/agents/validate", { source_md }),
  createAgent: (orgId: string, source_md: string, note = "") => request<{ id: string }>("POST", `/orgs/${orgId}/agents`, { source_md, note }),
  updateAgent: (orgId: string, agentId: string, source_md: string, note = "") =>
    request<{ id: string; version: number }>("PUT", `/orgs/${orgId}/agents/${agentId}`, { source_md, note }),
  setAgentStatus: (orgId: string, agentId: string, status: "active" | "disabled") =>
    request<{ id: string }>("POST", `/orgs/${orgId}/agents/${agentId}/status`, { status }),
  submitGoal: (orgId: string, goal: string) => request<Workflow>("POST", `/orgs/${orgId}/workflows`, { goal }),
  approve: (orgId: string, workflowId: string, comment?: string) =>
    request<{ status: string }>("POST", `/orgs/${orgId}/workflows/${workflowId}/approve`, { comment: comment ?? null }),
  reject: (orgId: string, workflowId: string, comment?: string) =>
    request<{ status: string }>("POST", `/orgs/${orgId}/workflows/${workflowId}/reject`, { comment: comment ?? null }),
  cancel: (orgId: string, workflowId: string) => request<{ status: string }>("POST", `/orgs/${orgId}/workflows/${workflowId}/cancel`),
  saveIntegration: (orgId: string, provider: string, body: { secret?: string; config?: Record<string, string> }) =>
    request<Integration>("PUT", `/orgs/${orgId}/integrations/${provider}`, body),
  testIntegration: (orgId: string, provider: string) => request<Integration>("POST", `/orgs/${orgId}/integrations/${provider}/test`),
  deleteIntegration: (orgId: string, provider: string) => request<void>("DELETE", `/orgs/${orgId}/integrations/${provider}`),
  orgTools: (orgId: string) => request<OrgTools>("GET", `/orgs/${orgId}/tools`),
  createMcpServer: (orgId: string, body: McpServerInput) => request<McpServer>("POST", `/orgs/${orgId}/mcp-servers`, body),
  refreshMcpServer: (orgId: string, serverId: string) => request<McpServer>("POST", `/orgs/${orgId}/mcp-servers/${serverId}/refresh`),
  updateMcpServer: (orgId: string, serverId: string, body: McpServerUpdate) =>
    request<McpServer>("PATCH", `/orgs/${orgId}/mcp-servers/${serverId}`, body),
  deleteMcpServer: (orgId: string, serverId: string) => request<void>("DELETE", `/orgs/${orgId}/mcp-servers/${serverId}`),
  addMemory: (orgId: string, body: { kind: "note" | "decision"; title: string; content: string; tags: string[] }) =>
    request<{ id: string }>("POST", `/orgs/${orgId}/memory`, body),
  deleteMemory: (orgId: string, memoryId: string) => request<void>("DELETE", `/orgs/${orgId}/memory/${memoryId}`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.errors.length ? `${e.message}: ${e.errors.join("; ")}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
