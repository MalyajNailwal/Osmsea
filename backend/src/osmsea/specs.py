"""Organization specifications: Markdown with YAML frontmatter, validated by Pydantic.

Specs describe *intended* behaviour. They never grant permissions: effective tool access is
computed at runtime (``registry.effective_tools``) from org policy, integrations and plan approval.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator, model_validator

from .mcp_client import parse_tool_name
from .schemas import OUTPUT_SCHEMAS
from .tools import TOOLS

SLUG = r"^[a-z][a-z0-9-]{1,47}$"
MAX_SPEC_BYTES = 64 * 1024
_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)(.*)\Z", re.S)

Line = Annotated[str, StringConstraints(min_length=1, max_length=500)]
Tag = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,47}$")]


class SpecError(ValueError):
    """Validation failure carrying every human-readable problem found."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Agent spec ----------------------------------------------------------------------------------


class VerificationSpec(_Strict):
    require_cited_evidence: bool = False  # every cited source must have been retrieved in this execution
    min_sources: int = Field(0, ge=0, le=20)  # distinct retrieved sources the output must cite
    syntax_check: bool = False  # parse Python/JSON files in code outputs
    run_tests: bool = False  # run the output's test_command against its files in the offline Docker sandbox
    independent_review: bool = True  # separate model call judges output against acceptance criteria


class EscalationSpec(_Strict):
    max_attempts: int = Field(2, ge=1, le=5)
    on_failure: str = Field(min_length=1, max_length=1000)


class LimitsSpec(_Strict):
    max_steps: int = Field(12, ge=1, le=40)
    timeout_seconds: int = Field(300, ge=30, le=1800)


class AgentSpec(_Strict):
    id: str = Field(pattern=SLUG)
    name: str = Field(min_length=1, max_length=80)
    department: str = Field(pattern=SLUG)
    role: str = Field(min_length=1, max_length=120)
    mission: str = Field(min_length=1, max_length=1000)
    responsibilities: list[Line] = Field(min_length=1, max_length=20)
    capabilities: list[Tag] = Field(min_length=1, max_length=20)
    limitations: list[Line] = Field(default_factory=list, max_length=20)
    allowed_tools: list[str] = Field(default_factory=list, max_length=10)
    inputs: list[Line] = Field(min_length=1, max_length=10)
    outputs: list[Line] = Field(min_length=1, max_length=10)
    output_schema: str
    acceptance_criteria: list[Line] = Field(min_length=1, max_length=15)
    verification: VerificationSpec = VerificationSpec()
    escalation: EscalationSpec
    limits: LimitsSpec = LimitsSpec()
    model: str | None = Field(None, max_length=120)
    instructions: str = Field(min_length=1, max_length=20_000)  # Markdown body of the spec file

    @field_validator("allowed_tools")
    @classmethod
    def _known_tools(cls, tools: list[str]) -> list[str]:
        # MCP tools (mcp__<server>__<tool>) are org-specific: whether one is approved is checked at
        # runtime by the registry. Here only their name format is validated.
        unknown = [t for t in tools if t not in TOOLS and parse_tool_name(t) is None]
        if unknown:
            raise ValueError(f"unknown tools {unknown}; known tools: {sorted(TOOLS)} "
                             "or approved MCP tools named mcp__<server>__<tool>")
        if len(set(tools)) != len(tools):
            raise ValueError("tools must not repeat")
        return tools

    @field_validator("output_schema")
    @classmethod
    def _known_schema(cls, name: str) -> str:
        if name not in OUTPUT_SCHEMAS:
            raise ValueError(f"unknown output schema '{name}'; known: {sorted(OUTPUT_SCHEMAS)}")
        return name

    @model_validator(mode="after")
    def _verification_matches_schema(self) -> AgentSpec:
        schema = OUTPUT_SCHEMAS[self.output_schema]
        v = self.verification
        if (v.require_cited_evidence or v.min_sources) and not schema.has_sources:
            raise ValueError(f"evidence checks need an output schema with sources, not {self.output_schema}")
        if v.syntax_check and not schema.has_files:
            raise ValueError(f"syntax_check needs an output schema with files, not {self.output_schema}")
        return self

    def frontmatter(self) -> dict[str, Any]:
        return self.model_dump(exclude={"instructions"}, exclude_none=True)


# --- Organization settings (policy) --------------------------------------------------------------


class ToolPolicy(_Strict):
    enabled: bool = True
    requires_approval: bool = False


class OrgSettings(_Strict):
    require_plan_approval: bool = True
    max_concurrent_tasks: int = Field(2, ge=1, le=10)
    task_timeout_seconds: int = Field(300, ge=30, le=1800)
    max_attempts: int = Field(2, ge=1, le=5)
    workflow_token_budget: int = Field(300_000, ge=1_000, le=5_000_000)
    max_tasks_per_plan: int = Field(8, ge=1, le=20)
    default_model: str | None = Field(None, max_length=120)
    tool_policy: dict[str, ToolPolicy] = Field(default_factory=dict)
    # Self-improvement: evaluation gate for activating new agent versions.
    require_eval_for_activation: bool = False
    eval_min_pass_rate: float = Field(0.0, ge=0.0, le=1.0)
    eval_max_cases: int = Field(10, ge=1, le=50)
    # Cost-aware routing: pick the cheapest candidate model that meets the quality bar.
    model_routing: Literal["fixed", "auto"] = "fixed"
    routing_models: list[Annotated[str, StringConstraints(min_length=1, max_length=120)]] = Field(default_factory=list, max_length=8)
    routing_min_runs: int = Field(3, ge=1, le=100)
    routing_target_pass_rate: float = Field(0.8, ge=0.0, le=1.0)

    @field_validator("tool_policy")
    @classmethod
    def _known_policy_tools(cls, policy: dict[str, ToolPolicy]) -> dict[str, ToolPolicy]:
        unknown = [t for t in policy if t not in TOOLS]
        if unknown:
            raise ValueError(f"policy for unknown tools {unknown}")
        return policy

    def policy_for(self, tool: str) -> ToolPolicy:
        return self.tool_policy.get(tool, ToolPolicy())


# --- Department / organization -------------------------------------------------------------------


class DepartmentSpec(_Strict):
    id: str = Field(pattern=SLUG)
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=500)
    readme: str = Field("", max_length=20_000)


class OrganizationSpec(_Strict):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    readme: str = Field("", max_length=20_000)
    departments: list[DepartmentSpec] = Field(min_length=1, max_length=20)
    agents: list[AgentSpec] = Field(min_length=1, max_length=50)


def organization_errors(org: OrganizationSpec) -> list[str]:
    """Cross-object rules Pydantic field validation cannot express."""
    errors = []
    dept_ids = [d.id for d in org.departments]
    errors += [f"duplicate department id '{d}'" for d in sorted({d for d in dept_ids if dept_ids.count(d) > 1})]
    agent_ids = [a.id for a in org.agents]
    errors += [f"duplicate agent id '{a}'" for a in sorted({a for a in agent_ids if agent_ids.count(a) > 1})]
    errors += [f"agent '{a.id}' references unknown department '{a.department}'"
               for a in org.agents if a.department not in dept_ids]
    return errors


# --- Parsing -------------------------------------------------------------------------------------


def _format(e: ValidationError) -> list[str]:
    out = []
    for err in e.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "spec"
        out.append(f"{loc}: {err['msg']}")
    return out


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if len(text.encode()) > MAX_SPEC_BYTES:
        raise SpecError([f"spec exceeds {MAX_SPEC_BYTES} bytes"])
    m = _FRONTMATTER.match(text.lstrip("﻿"))
    if not m:
        raise SpecError(["missing YAML frontmatter: the file must start with a '---' block"])
    try:
        meta = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        raise SpecError([f"invalid YAML frontmatter: {e}"]) from e
    if not isinstance(meta, dict):
        raise SpecError(["frontmatter must be a YAML mapping"])
    return meta, m.group(2).strip()


def parse_agent_markdown(text: str) -> AgentSpec:
    meta, body = split_frontmatter(text)
    if "instructions" in meta:
        raise SpecError(["instructions belong in the Markdown body, not the frontmatter"])
    try:
        return AgentSpec(**meta, instructions=body)
    except ValidationError as e:
        raise SpecError(_format(e)) from e
    except TypeError as e:  # non-string keys in YAML
        raise SpecError([f"frontmatter: {e}"]) from e


def render_agent_markdown(spec: AgentSpec) -> str:
    front = yaml.safe_dump(spec.frontmatter(), sort_keys=False, allow_unicode=True, width=100)
    return f"---\n{front}---\n\n{spec.instructions.strip()}\n"


def parse_department_markdown(text: str) -> DepartmentSpec:
    meta, body = split_frontmatter(text)
    try:
        return DepartmentSpec(**meta, readme=body)
    except ValidationError as e:
        raise SpecError(_format(e)) from e


def parse_settings(raw: dict[str, Any] | None) -> OrgSettings:
    try:
        return OrgSettings(**(raw or {}))
    except ValidationError as e:
        raise SpecError(_format(e)) from e


def _read_spec_file(root: Path, path: Path) -> str:
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise SpecError([f"{path}: resolves outside the organization directory"])
    if not resolved.is_file() or resolved.suffix != ".md":
        raise SpecError([f"{path}: not a Markdown file"])
    if resolved.stat().st_size > MAX_SPEC_BYTES:
        raise SpecError([f"{path}: exceeds {MAX_SPEC_BYTES} bytes"])
    try:
        return resolved.read_text("utf-8")
    except UnicodeDecodeError as e:
        raise SpecError([f"{path}: not valid UTF-8"]) from e


def load_organization_dir(root: Path) -> OrganizationSpec:
    """Load and validate an organization directory. Collects every error before raising."""
    root = root.resolve()
    errors: list[str] = []

    def rel(p: Path) -> str:
        return str(p.relative_to(root)) if p.is_relative_to(root) else str(p)

    org_meta, org_body = {}, ""
    try:
        org_meta, org_body = split_frontmatter(_read_spec_file(root, root / "README.md"))
    except SpecError as e:
        errors += [f"README.md: {m}" for m in e.errors]

    departments: list[DepartmentSpec] = []
    agents: list[AgentSpec] = []
    dept_root = root / "departments"
    for dept_dir in sorted(p for p in dept_root.iterdir() if p.is_dir()) if dept_root.is_dir() else []:
        readme = dept_dir / "README.md"
        try:
            dept = parse_department_markdown(_read_spec_file(root, readme))
            if dept.id != dept_dir.name:
                errors.append(f"{rel(readme)}: id '{dept.id}' must match directory '{dept_dir.name}'")
            departments.append(dept)
        except SpecError as e:
            errors += [f"{rel(readme)}: {m}" for m in e.errors]
        agents_dir = dept_dir / "agents"
        for path in sorted(agents_dir.glob("*.md")) if agents_dir.is_dir() else []:
            try:
                spec = parse_agent_markdown(_read_spec_file(root, path))
                if spec.department != dept_dir.name:
                    errors.append(f"{rel(path)}: department '{spec.department}' must match directory '{dept_dir.name}'")
                agents.append(spec)
            except SpecError as e:
                errors += [f"{rel(path)}: {m}" for m in e.errors]

    if errors:
        raise SpecError(errors)
    try:
        org = OrganizationSpec(
            name=org_meta.get("name", ""), description=org_meta.get("description", ""),
            readme=org_body, departments=departments, agents=agents,
        )
    except ValidationError as e:
        raise SpecError(_format(e)) from e
    if cross := organization_errors(org):
        raise SpecError(cross)
    return org
