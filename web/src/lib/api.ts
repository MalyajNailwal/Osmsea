import { type Action, type AgentProposal, type ApiToken, type EvalRun, type Integration, type KnowledgeDocument, type McpServer, type Organization, type Replay, type Space, type SpaceMessage, supabase, type Trigger, type Workflow } from "./supabase";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors: string[] = []) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const form = body instanceof FormData;  // file uploads: the browser sets the multipart boundary
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
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
  id: string; name: string; kind: "llm" | "search" | "code"; description: string; secret_label: string;
  docs_url: string; config_fields: Record<string, string>; enables: string[];
};
export type OrgSettings = {
  require_plan_approval: boolean; max_concurrent_tasks: number; task_timeout_seconds: number; max_attempts: number;
  workflow_token_budget: number; max_tasks_per_plan: number; default_model: string | null;
  tool_policy: Record<string, { enabled: boolean; requires_approval: boolean }>;
  require_eval_for_activation: boolean; eval_min_pass_rate: number; eval_max_cases: number;
  model_routing: "fixed" | "auto"; routing_models: string[]; routing_min_runs: number; routing_target_pass_rate: number;
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
  verification: { require_cited_evidence: boolean; min_sources: number; syntax_check: boolean; run_tests?: boolean; independent_review: boolean };
  escalation: { max_attempts: number; on_failure: string }; limits: { max_steps: number; timeout_seconds: number };
  model?: string | null; instructions: string;
};
export type OrgStatus = {
  llm: { configured: boolean; provider?: string; model?: string; message?: string };
  worker: { enabled: boolean; last_tick: string | null; running_tasks: number };
  invalid_agents: Record<string, string[]>; providers: string[];
  sandbox: { available: boolean; image: string; detail: string };
};
export type ForecastTask = {
  key: string; agent: string; model: string | null; runs: number; max_attempts: number;
  pass_rate: number | null; success: number | null; cost_usd: number | null; duration_s: number | null; expected_attempts?: number;
};
export type Forecast = {
  tasks: ForecastTask[]; success: number | null; cost_usd: number | null; duration_s: number | null;
  known_tasks: number; total_tasks: number; computed_at: string;
};
export type Persona = { tagline: string; voice: string; color: string };
export type LibraryAgent = {
  id: string; name: string; role: string; mission: string; department: string; tools: string[]; persona: Persona | null; source_md: string;
};
export type AgentDraft = { valid: boolean; errors: string[]; source_md: string; model?: string };
export type DocumentHit = {
  chunk_id: string; document_id: string; title: string; ordinal: number; page: number | null; heading: string | null; content: string;
};
export type InvitePreview = { organization: string; role: string; email: string; status: string; expires_at: string };
export type TriggerInput = {
  name: string; kind: "schedule" | "webhook"; goal: string; interval_minutes?: number; start_at?: string; require_approval: boolean;
};

export type McpToolInfo = { name: string; description: string; input_schema: Record<string, unknown>; approvable: boolean };
export type OrgTools = {
  builtin: { name: string; description: string; integrations: string[]; enabled: boolean; available: boolean }[];
  mcp: { name: string; server: string; server_name: string; tool: string; description: string; require_approval: boolean }[];
};
export type McpServerInput = { name: string; slug: string; url: string; auth_header?: string; secret?: string; require_approval?: boolean };
export type McpServerUpdate = { approved_tools?: string[]; require_approval?: boolean; enabled?: boolean; secret?: string; clear_secret?: boolean };

export type ModelStat = {
  agent_id: string; model: string; runs: number; passed: number; pass_rate: number; live_runs: number; eval_runs: number;
  avg_tokens: number; total_cost_usd: number | null; cost_per_pass: number | null;
};
export type AgentInsights = {
  failures: {
    window: number; verified_runs: number; passed: number; failed: number; infra_failures: number;
    failed_checks: Record<string, number>; unmet_criteria: { criterion: string; count: number }[];
    examples: { execution_id: string; failed: string[] }[]; infra_errors: string[];
  };
  models: ModelStat[];
  routing: { model: string | null; reason: string };
  eval_cases: number;
};
export type EvalSummary = {
  cases: number; passed: number; pass_rate: number; baseline_passed: number; baseline_pass_rate: number;
  total_cost_usd: number | null; cost_per_pass: number | null; avg_tokens: number; replayed_calls: number; live_calls: number;
};

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
  insights: (orgId: string, agentId: string) => request<AgentInsights>("GET", `/orgs/${orgId}/agents/${agentId}/insights`),
  startEval: (orgId: string, agentId: string, body: { source_md?: string; models?: string[] }) =>
    request<EvalRun[]>("POST", `/orgs/${orgId}/agents/${agentId}/evals`, body),
  proposeRevision: (orgId: string, agentId: string) => request<AgentProposal>("POST", `/orgs/${orgId}/agents/${agentId}/proposals`),
  decideProposal: (orgId: string, proposalId: string, decision: "accept" | "reject") =>
    request<AgentProposal>("POST", `/orgs/${orgId}/proposals/${proposalId}/${decision}`),
  createToken: (orgId: string, name: string) => request<ApiToken & { token: string }>("POST", `/orgs/${orgId}/api-tokens`, { name }),
  revokeToken: (orgId: string, tokenId: string) => request<void>("DELETE", `/orgs/${orgId}/api-tokens/${tokenId}`),
  createTrigger: (orgId: string, body: TriggerInput) => request<Trigger & { secret: string | null }>("POST", `/orgs/${orgId}/triggers`, body),
  updateTrigger: (orgId: string, triggerId: string, body: { enabled?: boolean; require_approval?: boolean; name?: string; goal?: string }) =>
    request<Trigger>("PATCH", `/orgs/${orgId}/triggers/${triggerId}`, body),
  deleteTrigger: (orgId: string, triggerId: string) => request<void>("DELETE", `/orgs/${orgId}/triggers/${triggerId}`),
  runTrigger: (orgId: string, triggerId: string) => request<Workflow>("POST", `/orgs/${orgId}/triggers/${triggerId}/run`),
  invite: (orgId: string, email: string, role: string) =>
    request<{ id: string; email: string; role: string; expires_at: string; url: string }>("POST", `/orgs/${orgId}/invitations`, { email, role }),
  revokeInvite: (orgId: string, invitationId: string) => request<void>("DELETE", `/orgs/${orgId}/invitations/${invitationId}`),
  previewInvite: (token: string) => request<InvitePreview>("POST", "/invitations/preview", { token }),
  acceptInvite: (token: string) => request<{ org_id: string; role: string }>("POST", "/invitations/accept", { token }),
  setMemberRole: (orgId: string, userId: string, role: string) => request<unknown>("PATCH", `/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) => request<void>("DELETE", `/orgs/${orgId}/members/${userId}`),
  replay: (orgId: string, executionId: string, body: { source_md?: string; model?: string }) =>
    request<Replay>("POST", `/orgs/${orgId}/executions/${executionId}/replays`, body),
  uploadDocument: (orgId: string, file: File, title?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    return request<KnowledgeDocument>("POST", `/orgs/${orgId}/documents`, form);
  },
  addDocumentUrl: (orgId: string, url: string) => request<KnowledgeDocument>("POST", `/orgs/${orgId}/documents/url`, { url }),
  deleteDocument: (orgId: string, documentId: string) => request<void>("DELETE", `/orgs/${orgId}/documents/${documentId}`),
  searchDocuments: (orgId: string, q: string) =>
    request<DocumentHit[]>("GET", `/orgs/${orgId}/documents/search?q=${encodeURIComponent(q)}`),
  decideAction: (orgId: string, actionId: string, decision: "approve" | "reject") =>
    request<Action>("POST", `/orgs/${orgId}/actions/${actionId}/${decision}`),
  library: () => request<LibraryAgent[]>("GET", "/library"),
  addLibraryAgent: (orgId: string, template: string) => request<{ id: string }>("POST", `/orgs/${orgId}/agents/from-library`, { template }),
  draftAgent: (orgId: string, description: string) => request<AgentDraft>("POST", `/orgs/${orgId}/agents/draft`, { description }),
  createQuickAgent: (orgId: string, source_md: string) => request<{ id: string }>("POST", `/orgs/${orgId}/agents/quick`, { source_md }),
  createSpace: (orgId: string, body: { name: string; description?: string; agent_ids: string[]; primary_agent_id?: string | null }) =>
    request<Space>("POST", `/orgs/${orgId}/spaces`, body),
  updateSpace: (orgId: string, spaceId: string, body: { name?: string; description?: string; agent_ids?: string[]; primary_agent_id?: string | null }) =>
    request<Space>("PATCH", `/orgs/${orgId}/spaces/${spaceId}`, body),
  deleteSpace: (orgId: string, spaceId: string) => request<void>("DELETE", `/orgs/${orgId}/spaces/${spaceId}`),
  postMessage: (orgId: string, spaceId: string, content: string) =>
    request<SpaceMessage>("POST", `/orgs/${orgId}/spaces/${spaceId}/messages`, { content }),
  markRead: (orgId: string, spaceId: string) => request<void>("POST", `/orgs/${orgId}/spaces/${spaceId}/read`),
  decideTool: (orgId: string, messageId: string, allow: boolean, remember = false) =>
    request<SpaceMessage>("POST", `/orgs/${orgId}/space-messages/${messageId}/decision`, { allow, remember }),
  addMemory: (orgId: string, body: { kind: "note" | "decision"; title: string; content: string; tags: string[] }) =>
    request<{ id: string }>("POST", `/orgs/${orgId}/memory`, body),
  deleteMemory: (orgId: string, memoryId: string) => request<void>("DELETE", `/orgs/${orgId}/memory/${memoryId}`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.errors.length ? `${e.message}: ${e.errors.join("; ")}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
