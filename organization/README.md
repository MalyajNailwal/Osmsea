---
name: OSMSEA Starter Organization
description: A small research and engineering organization used as the default template for new organizations.
---

# OSMSEA starter organization

This directory is the **approved template** new organizations can be created from
(Organization Builder → *Start from template*). It contains human-readable documentation and
validated agent specifications. It is **not** executable configuration.

## Layout

| Path | Purpose | Read by the runtime? |
|------|---------|----------------------|
| `README.md` | Organization name and description (frontmatter) + overview | Yes: frontmatter only |
| `departments/<id>/README.md` | Department `id`, `name`, `description` (frontmatter) + standards | Yes: stored as department docs |
| `departments/<id>/agents/<agent>.md` | Agent specification (YAML frontmatter) + execution instructions (body) | Yes: validated by `osmsea.specs.AgentSpec` |
| `workflows/README.md` | How a goal becomes a plan and a run | No: documentation |
| `policies/README.md` | Governance rules and where each is enforced | No: documentation |

When an organization is created from this template, each file is validated and copied into
Supabase as version 1 of that organization's configuration. Later edits happen per organization
(Agent Management → *Instructions*) and create new, validated versions; this directory is not modified.

## What these files do *not* do

- **They do not grant permissions.** `allowed_tools` is a request. The backend intersects it with the
  organization's tool policy, the integrations that are actually configured, and the permissions the
  user approved for a workflow.
- **They do not schedule, retry, authorize or persist anything.** That is Python runtime code in
  `backend/src/osmsea`.
- **They are not injected wholesale into prompts.** A task receives only its own agent's
  instructions and its department's one-line description.
