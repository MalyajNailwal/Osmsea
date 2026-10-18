export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      actions: {
        Row: {
          completed_at: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          error: string | null
          id: string
          kind: string
          org_id: string
          payload: Json
          result: Json | null
          status: string
          summary: string
          task_id: string
          workflow_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          error?: string | null
          id?: string
          kind: string
          org_id: string
          payload?: Json
          result?: Json | null
          status?: string
          summary: string
          task_id: string
          workflow_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          error?: string | null
          id?: string
          kind?: string
          org_id?: string
          payload?: Json
          result?: Json | null
          status?: string
          summary?: string
          task_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_executions: {
        Row: {
          agent_id: string | null
          agent_version_id: string | null
          attempt: number
          cost_usd: number | null
          error: string | null
          finished_at: string | null
          id: string
          input_tokens: number
          model: string | null
          org_id: string
          output: Json | null
          output_tokens: number
          provider: string | null
          routing: Json | null
          started_at: string
          status: string
          steps: Json
          task_id: string
          tool_recordings: Json
          verification: Json | null
          worker_id: string | null
          workflow_id: string
        }
        Insert: {
          agent_id?: string | null
          agent_version_id?: string | null
          attempt: number
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number
          model?: string | null
          org_id: string
          output?: Json | null
          output_tokens?: number
          provider?: string | null
          routing?: Json | null
          started_at?: string
          status?: string
          steps?: Json
          task_id: string
          tool_recordings?: Json
          verification?: Json | null
          worker_id?: string | null
          workflow_id: string
        }
        Update: {
          agent_id?: string | null
          agent_version_id?: string | null
          attempt?: number
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number
          model?: string | null
          org_id?: string
          output?: Json | null
          output_tokens?: number
          provider?: string | null
          routing?: Json | null
          started_at?: string
          status?: string
          steps?: Json
          task_id?: string
          tool_recordings?: Json
          verification?: Json | null
          worker_id?: string | null
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_executions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_executions_agent_version_id_fkey"
            columns: ["agent_version_id"]
            isOneToOne: false
            referencedRelation: "agent_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_executions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_executions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_executions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_proposals: {
        Row: {
          agent_id: string
          base_version_id: string | null
          changes: Json
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          eval_run_id: string | null
          failure_report: Json
          id: string
          model: string | null
          org_id: string
          rationale: string
          source_md: string
          status: string
        }
        Insert: {
          agent_id: string
          base_version_id?: string | null
          changes?: Json
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          eval_run_id?: string | null
          failure_report?: Json
          id?: string
          model?: string | null
          org_id: string
          rationale: string
          source_md: string
          status?: string
        }
        Update: {
          agent_id?: string
          base_version_id?: string | null
          changes?: Json
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          eval_run_id?: string | null
          failure_report?: Json
          id?: string
          model?: string | null
          org_id?: string
          rationale?: string
          source_md?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_proposals_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_proposals_base_version_id_fkey"
            columns: ["base_version_id"]
            isOneToOne: false
            referencedRelation: "agent_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_proposals_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_proposals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_versions: {
        Row: {
          agent_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string
          org_id: string
          source_md: string
          spec: Json
          version: number
        }
        Insert: {
          agent_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string
          org_id: string
          source_md: string
          spec: Json
          version: number
        }
        Update: {
          agent_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string
          org_id?: string
          source_md?: string
          spec?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_versions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          active_version_id: string | null
          created_at: string
          department_id: string
          id: string
          name: string
          org_id: string
          role: string
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          active_version_id?: string | null
          created_at?: string
          department_id: string
          id?: string
          name: string
          org_id: string
          role?: string
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          active_version_id?: string | null
          created_at?: string
          department_id?: string
          id?: string
          name?: string
          org_id?: string
          role?: string
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_active_version_fk"
            columns: ["active_version_id"]
            isOneToOne: false
            referencedRelation: "agent_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          last_used_at: string | null
          name: string
          org_id: string
          prefix: string
          revoked_at: string | null
          token_hash: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          org_id: string
          prefix: string
          revoked_at?: string | null
          token_hash: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          org_id?: string
          prefix?: string
          revoked_at?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          comment: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          kind: string
          org_id: string
          payload: Json
          status: string
          summary: string
          workflow_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind?: string
          org_id: string
          payload?: Json
          status?: string
          summary?: string
          workflow_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind?: string
          org_id?: string
          payload?: Json
          status?: string
          summary?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          content: string
          created_at: string
          execution_id: string
          id: string
          kind: string
          name: string
          org_id: string
          sha256: string
          size_bytes: number
          task_id: string
          workflow_id: string
        }
        Insert: {
          content: string
          created_at?: string
          execution_id: string
          id?: string
          kind: string
          name: string
          org_id: string
          sha256: string
          size_bytes: number
          task_id: string
          workflow_id: string
        }
        Update: {
          content?: string
          created_at?: string
          execution_id?: string
          id?: string
          kind?: string
          name?: string
          org_id?: string
          sha256?: string
          size_bytes?: number
          task_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "agent_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifacts_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifacts_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          actor_label: string
          actor_type: string
          created_at: string
          details: Json
          id: number
          org_id: string | null
          outcome: string
          resource_id: string | null
          resource_name: string | null
          resource_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_label?: string
          actor_type: string
          created_at?: string
          details?: Json
          id?: never
          org_id?: string | null
          outcome?: string
          resource_id?: string | null
          resource_name?: string | null
          resource_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_label?: string
          actor_type?: string
          created_at?: string
          details?: Json
          id?: never
          org_id?: string | null
          outcome?: string
          resource_id?: string | null
          resource_name?: string | null
          resource_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          description: string
          id: string
          name: string
          org_id: string
          readme_md: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          name: string
          org_id: string
          readme_md?: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          name?: string
          org_id?: string
          readme_md?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          content: string
          document_id: string
          fts: unknown
          heading: string | null
          id: string
          ordinal: number
          org_id: string
          page: number | null
        }
        Insert: {
          content: string
          document_id: string
          fts?: unknown
          heading?: string | null
          id?: string
          ordinal: number
          org_id: string
          page?: number | null
        }
        Update: {
          content?: string
          document_id?: string
          fts?: unknown
          heading?: string | null
          id?: string
          ordinal?: number
          org_id?: string
          page?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_chunks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          bytes: number
          chunks: number
          created_at: string
          created_by: string | null
          filename: string | null
          id: string
          mime: string | null
          org_id: string
          pages: number | null
          sha256: string
          source: string
          source_url: string | null
          title: string
        }
        Insert: {
          bytes?: number
          chunks?: number
          created_at?: string
          created_by?: string | null
          filename?: string | null
          id?: string
          mime?: string | null
          org_id: string
          pages?: number | null
          sha256: string
          source: string
          source_url?: string | null
          title: string
        }
        Update: {
          bytes?: number
          chunks?: number
          created_at?: string
          created_by?: string | null
          filename?: string | null
          id?: string
          mime?: string | null
          org_id?: string
          pages?: number | null
          sha256?: string
          source?: string
          source_url?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_cases: {
        Row: {
          agent_id: string
          baseline: Json
          created_at: string
          id: string
          org_id: string
          prerequisites: Json
          recordings: Json
          source_execution_id: string | null
          source_task_id: string | null
          status: string
          task: Json
          title: string
        }
        Insert: {
          agent_id: string
          baseline?: Json
          created_at?: string
          id?: string
          org_id: string
          prerequisites?: Json
          recordings?: Json
          source_execution_id?: string | null
          source_task_id?: string | null
          status?: string
          task: Json
          title: string
        }
        Update: {
          agent_id?: string
          baseline?: Json
          created_at?: string
          id?: string
          org_id?: string
          prerequisites?: Json
          recordings?: Json
          source_execution_id?: string | null
          source_task_id?: string | null
          status?: string
          task?: Json
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "eval_cases_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_cases_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_cases_source_execution_id_fkey"
            columns: ["source_execution_id"]
            isOneToOne: true
            referencedRelation: "agent_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_cases_source_task_id_fkey"
            columns: ["source_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_results: {
        Row: {
          agent_id: string | null
          cost_usd: number | null
          created_at: string
          duration_ms: number | null
          error: string | null
          eval_case_id: string | null
          eval_run_id: string
          id: string
          live_calls: number
          model: string | null
          org_id: string
          passed: boolean
          replayed: number
          steps: Json
          tokens: number
          verification: Json | null
        }
        Insert: {
          agent_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          eval_case_id?: string | null
          eval_run_id: string
          id?: string
          live_calls?: number
          model?: string | null
          org_id: string
          passed: boolean
          replayed?: number
          steps?: Json
          tokens?: number
          verification?: Json | null
        }
        Update: {
          agent_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          eval_case_id?: string | null
          eval_run_id?: string
          id?: string
          live_calls?: number
          model?: string | null
          org_id?: string
          passed?: boolean
          replayed?: number
          steps?: Json
          tokens?: number
          verification?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "eval_results_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_results_eval_case_id_fkey"
            columns: ["eval_case_id"]
            isOneToOne: false
            referencedRelation: "eval_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_results_eval_run_id_fkey"
            columns: ["eval_run_id"]
            isOneToOne: false
            referencedRelation: "eval_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_results_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_runs: {
        Row: {
          agent_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          kind: string
          model: string | null
          org_id: string
          proposal_id: string | null
          source_md: string
          source_sha256: string
          started_at: string | null
          status: string
          summary: Json
        }
        Insert: {
          agent_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind?: string
          model?: string | null
          org_id: string
          proposal_id?: string | null
          source_md: string
          source_sha256: string
          started_at?: string | null
          status?: string
          summary?: Json
        }
        Update: {
          agent_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind?: string
          model?: string | null
          org_id?: string
          proposal_id?: string | null
          source_md?: string
          source_sha256?: string
          started_at?: string | null
          status?: string
          summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "eval_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      execution_events: {
        Row: {
          agent_id: string | null
          created_at: string
          data: Json
          execution_id: string | null
          id: number
          level: string
          message: string
          org_id: string
          task_id: string | null
          type: string
          workflow_id: string | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          data?: Json
          execution_id?: string | null
          id?: never
          level?: string
          message: string
          org_id: string
          task_id?: string | null
          type: string
          workflow_id?: string | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          data?: Json
          execution_id?: string | null
          id?: never
          level?: string
          message?: string
          org_id?: string
          task_id?: string | null
          type?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "execution_events_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_events_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "agent_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_events_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_secrets: {
        Row: {
          integration_id: string
          secret_id: string
        }
        Insert: {
          integration_id: string
          secret_id: string
        }
        Update: {
          integration_id?: string
          secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: true
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          id: string
          last_test_message: string | null
          last_test_ok: boolean | null
          last_tested_at: string | null
          org_id: string
          provider: string
          secret_hint: string
          status: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          last_test_message?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          org_id: string
          provider: string
          secret_hint?: string
          status?: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          last_test_message?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          org_id?: string
          provider?: string
          secret_hint?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          org_id: string
          revoked_at: string | null
          role: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          org_id: string
          revoked_at?: string | null
          role: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          org_id?: string
          revoked_at?: string | null
          role?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_server_secrets: {
        Row: {
          secret_id: string
          server_id: string
        }
        Insert: {
          secret_id: string
          server_id: string
        }
        Update: {
          secret_id?: string
          server_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_server_secrets_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: true
            referencedRelation: "mcp_servers"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_servers: {
        Row: {
          approved_tools: string[]
          auth_header: string
          created_at: string
          created_by: string | null
          id: string
          last_checked_at: string | null
          last_error: string | null
          name: string
          org_id: string
          require_approval: boolean
          secret_hint: string
          server_info: Json
          slug: string
          status: string
          tool_catalog: Json
          updated_at: string
          url: string
        }
        Insert: {
          approved_tools?: string[]
          auth_header?: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_checked_at?: string | null
          last_error?: string | null
          name: string
          org_id: string
          require_approval?: boolean
          secret_hint?: string
          server_info?: Json
          slug: string
          status?: string
          tool_catalog?: Json
          updated_at?: string
          url: string
        }
        Update: {
          approved_tools?: string[]
          auth_header?: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_checked_at?: string | null
          last_error?: string | null
          name?: string
          org_id?: string
          require_approval?: boolean
          secret_hint?: string
          server_info?: Json
          slug?: string
          status?: string
          tool_catalog?: Json
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_servers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_items: {
        Row: {
          agent_id: string | null
          content: string
          created_at: string
          created_by: string | null
          fts: unknown
          id: string
          kind: string
          org_id: string
          source: Json
          tags: string[]
          task_id: string | null
          title: string
          workflow_id: string | null
        }
        Insert: {
          agent_id?: string | null
          content: string
          created_at?: string
          created_by?: string | null
          fts?: unknown
          id?: string
          kind: string
          org_id: string
          source?: Json
          tags?: string[]
          task_id?: string | null
          title: string
          workflow_id?: string | null
        }
        Update: {
          agent_id?: string | null
          content?: string
          created_at?: string
          created_by?: string | null
          fts?: unknown
          id?: string
          kind?: string
          org_id?: string
          source?: Json
          tags?: string[]
          task_id?: string | null
          title?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memory_items_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_items_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          email: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string
          org_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          id: string
          name: string
          readme_md: string
          settings: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          name: string
          readme_md?: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          name?: string
          readme_md?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: []
      }
      replays: {
        Row: {
          agent_id: string | null
          completed_at: string | null
          cost_usd: number | null
          created_at: string
          created_by: string | null
          duration_ms: number | null
          error: string | null
          execution_id: string
          id: string
          live_calls: number
          model: string | null
          org_id: string
          output: Json | null
          passed: boolean | null
          replayed: number
          source_md: string
          status: string
          steps: Json
          tokens: number
          verification: Json | null
        }
        Insert: {
          agent_id?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          error?: string | null
          execution_id: string
          id?: string
          live_calls?: number
          model?: string | null
          org_id: string
          output?: Json | null
          passed?: boolean | null
          replayed?: number
          source_md: string
          status?: string
          steps?: Json
          tokens?: number
          verification?: Json | null
        }
        Update: {
          agent_id?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          error?: string | null
          execution_id?: string
          id?: string
          live_calls?: number
          model?: string | null
          org_id?: string
          output?: Json | null
          passed?: boolean | null
          replayed?: number
          source_md?: string
          status?: string
          steps?: Json
          tokens?: number
          verification?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "replays_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replays_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "agent_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replays_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          acceptance_criteria: Json
          agent_id: string | null
          agent_slug: string
          agent_version_id: string | null
          attempt: number
          completed_at: string | null
          created_at: string
          depends_on: string[]
          description: string
          error: string | null
          expected_output: string
          id: string
          key: string
          lease_expires_at: string | null
          lease_owner: string | null
          max_attempts: number
          next_attempt_at: string | null
          org_id: string
          output: Json | null
          started_at: string | null
          status: string
          title: string
          updated_at: string
          verification: Json | null
          workflow_id: string
        }
        Insert: {
          acceptance_criteria?: Json
          agent_id?: string | null
          agent_slug: string
          agent_version_id?: string | null
          attempt?: number
          completed_at?: string | null
          created_at?: string
          depends_on?: string[]
          description?: string
          error?: string | null
          expected_output?: string
          id?: string
          key: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_attempts?: number
          next_attempt_at?: string | null
          org_id: string
          output?: Json | null
          started_at?: string | null
          status?: string
          title: string
          updated_at?: string
          verification?: Json | null
          workflow_id: string
        }
        Update: {
          acceptance_criteria?: Json
          agent_id?: string | null
          agent_slug?: string
          agent_version_id?: string | null
          attempt?: number
          completed_at?: string | null
          created_at?: string
          depends_on?: string[]
          description?: string
          error?: string | null
          expected_output?: string
          id?: string
          key?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_attempts?: number
          next_attempt_at?: string | null
          org_id?: string
          output?: Json | null
          started_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          verification?: Json | null
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_agent_version_id_fkey"
            columns: ["agent_version_id"]
            isOneToOne: false
            referencedRelation: "agent_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      triggers: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          goal: string
          id: string
          interval_minutes: number | null
          kind: string
          last_error: string | null
          last_run_at: string | null
          last_workflow_id: string | null
          name: string
          next_run_at: string | null
          org_id: string
          require_approval: boolean
          runs: number
          secret_hash: string | null
          secret_prefix: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          goal: string
          id?: string
          interval_minutes?: number | null
          kind: string
          last_error?: string | null
          last_run_at?: string | null
          last_workflow_id?: string | null
          name: string
          next_run_at?: string | null
          org_id: string
          require_approval?: boolean
          runs?: number
          secret_hash?: string | null
          secret_prefix?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          goal?: string
          id?: string
          interval_minutes?: number | null
          kind?: string
          last_error?: string | null
          last_run_at?: string | null
          last_workflow_id?: string | null
          name?: string
          next_run_at?: string | null
          org_id?: string
          require_approval?: boolean
          runs?: number
          secret_hash?: string | null
          secret_prefix?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "triggers_last_workflow_id_fkey"
            columns: ["last_workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "triggers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          acceptance_criteria: Json
          approved_at: string | null
          approved_by: string | null
          completed_at: string | null
          context: Json | null
          cost_usd: number
          created_at: string
          created_by: string | null
          error: string | null
          force_approval: boolean
          forecast: Json | null
          goal: string
          id: string
          objective: string | null
          org_id: string
          plan: Json | null
          plan_errors: Json
          required_permissions: Json
          requires_approval: boolean
          started_at: string | null
          status: string
          token_budget: number
          tokens_used: number
          trigger_id: string | null
          updated_at: string
        }
        Insert: {
          acceptance_criteria?: Json
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          context?: Json | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          force_approval?: boolean
          forecast?: Json | null
          goal: string
          id?: string
          objective?: string | null
          org_id: string
          plan?: Json | null
          plan_errors?: Json
          required_permissions?: Json
          requires_approval?: boolean
          started_at?: string | null
          status?: string
          token_budget?: number
          tokens_used?: number
          trigger_id?: string | null
          updated_at?: string
        }
        Update: {
          acceptance_criteria?: Json
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          context?: Json | null
          cost_usd?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          force_approval?: boolean
          forecast?: Json | null
          goal?: string
          id?: string
          objective?: string | null
          org_id?: string
          plan?: Json | null
          plan_errors?: Json
          required_permissions?: Json
          requires_approval?: boolean
          started_at?: string | null
          status?: string
          token_budget?: number
          tokens_used?: number
          trigger_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflows_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflows_trigger_id_fkey"
            columns: ["trigger_id"]
            isOneToOne: false
            referencedRelation: "triggers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_workflow_usage: {
        Args: { p_cost?: number; p_tokens: number; p_workflow: string }
        Returns: number
      }
      get_integration_secret: {
        Args: { p_integration: string }
        Returns: string
      }
      get_mcp_secret: { Args: { p_server: string }; Returns: string }
      is_org_member: { Args: { p_org: string }; Returns: boolean }
      search_documents: {
        Args: { p_limit?: number; p_org: string; p_query: string }
        Returns: {
          chunk_id: string
          content: string
          document_id: string
          heading: string
          ordinal: number
          page: number
          rank: number
          title: string
        }[]
      }
      search_memory: {
        Args: { p_limit?: number; p_org: string; p_query: string }
        Returns: {
          agent_id: string | null
          content: string
          created_at: string
          created_by: string | null
          fts: unknown
          id: string
          kind: string
          org_id: string
          source: Json
          tags: string[]
          task_id: string | null
          title: string
          workflow_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "memory_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_integration_secret: {
        Args: { p_integration: string; p_secret: string }
        Returns: undefined
      }
      set_mcp_secret: {
        Args: { p_secret: string; p_server: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
