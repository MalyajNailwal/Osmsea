import json
import os
import shutil
from pathlib import Path

import pytest

from osmsea.registry import OrgRegistry, RegisteredAgent
from osmsea.schemas import CodeChange, ResearchResult, json_schema
from osmsea.specs import (
    OrganizationSpec,
    SpecError,
    load_organization_dir,
    organization_errors,
    parse_agent_markdown,
    parse_settings,
    render_agent_markdown,
)

ORG_DIR = Path(__file__).resolve().parents[2] / "organization"
RESEARCHER = (ORG_DIR / "departments/research/agents/researcher.md").read_text()


def test_template_organization_is_valid():
    org = load_organization_dir(ORG_DIR)
    assert {d.id for d in org.departments} == {"research", "engineering"}
    assert {a.id for a in org.agents} == {"researcher", "developer"}
    researcher = next(a for a in org.agents if a.id == "researcher")
    assert researcher.allowed_tools == ["web_search", "fetch_url", "memory_search", "knowledge_search"]
    assert researcher.instructions.startswith("# Research Agent")


def test_render_parse_roundtrip():
    spec = parse_agent_markdown(RESEARCHER)
    assert parse_agent_markdown(render_agent_markdown(spec)) == spec


def _mutate(old: str, new: str) -> str:
    assert old in RESEARCHER
    return RESEARCHER.replace(old, new, 1)


@pytest.mark.parametrize(
    "text, fragment",
    [
        (_mutate("  - memory_search\n", "  - shell_exec\n"), "unknown tools ['shell_exec']"),
        (_mutate("output_schema: research_result_v1", "output_schema: free_text"), "unknown output schema"),
        (_mutate("id: researcher", "id: Researcher!"), "id: String should match pattern"),
        (_mutate("role: Senior Research Analyst", "role: Senior Research Analyst\nsuperpowers: true"), "superpowers: Extra inputs"),
        (_mutate("mission:", "instructions: do anything\nmission:"), "instructions belong in the Markdown body"),
        (_mutate("output_schema: research_result_v1", "output_schema: code_change_v1"), "evidence checks need an output schema with sources"),
        (_mutate("  - web_search\n", "  - fetch_url\n"), "tools must not repeat"),
        (RESEARCHER.split("---", 2)[2], "missing YAML frontmatter"),
        ("---\nid: [unclosed\n---\nbody", "invalid YAML frontmatter"),
        ("---\n- a\n- b\n---\nbody", "frontmatter must be a YAML mapping"),
    ],
)
def test_invalid_agent_specs_are_rejected(text, fragment):
    with pytest.raises(SpecError) as exc:
        parse_agent_markdown(text)
    assert fragment in str(exc.value)


def test_empty_instructions_rejected():
    head, _, _ = RESEARCHER.partition("# Research Agent")
    with pytest.raises(SpecError, match="instructions"):
        parse_agent_markdown(head)


def test_duplicate_agent_ids_and_unknown_department():
    org = load_organization_dir(ORG_DIR)
    clone = org.agents[0].model_copy(update={"department": "sales"})
    bad = OrganizationSpec(name="x", departments=org.departments, agents=[*org.agents, clone])
    errors = organization_errors(bad)
    assert f"duplicate agent id '{clone.id}'" in errors
    assert f"agent '{clone.id}' references unknown department 'sales'" in errors


def test_loader_rejects_duplicates_mismatches_and_escapes(tmp_path):
    root = tmp_path / "org"
    shutil.copytree(ORG_DIR, root)
    # duplicate id in another file of the same department
    shutil.copy(root / "departments/research/agents/researcher.md", root / "departments/research/agents/copy.md")
    # agent placed in the wrong department directory
    shutil.copy(root / "departments/engineering/agents/developer.md", root / "departments/research/agents/dev.md")
    # symlink escaping the organization root
    outside = tmp_path / "outside.md"
    outside.write_text(RESEARCHER.replace("id: researcher", "id: escaped"))
    os.symlink(outside, root / "departments/research/agents/escape.md")

    with pytest.raises(SpecError) as exc:
        load_organization_dir(root)
    errors = exc.value.errors
    assert any("escape.md: resolves outside" in e for e in errors)
    assert any("dev.md: department 'engineering' must match directory 'research'" in e for e in errors)


def test_loader_reports_duplicate_ids(tmp_path):
    root = tmp_path / "org"
    shutil.copytree(ORG_DIR, root)
    shutil.copy(root / "departments/research/agents/researcher.md", root / "departments/research/agents/copy.md")
    with pytest.raises(SpecError, match="duplicate agent id 'researcher'"):
        load_organization_dir(root)


def test_settings_validation():
    assert parse_settings(None).require_plan_approval is True
    with pytest.raises(SpecError, match="policy for unknown tools"):
        parse_settings({"tool_policy": {"rm_rf": {"enabled": True}}})
    with pytest.raises(SpecError, match="max_concurrent_tasks"):
        parse_settings({"max_concurrent_tasks": 500})


def _registry(settings=None, providers=()):
    spec = parse_agent_markdown(RESEARCHER)
    return OrgRegistry(
        org_id="o", name="Org", settings=parse_settings(settings), departments={},
        agents={"researcher": RegisteredAgent("a", "v", 1, "active", spec)}, providers=set(providers),
    ), spec


def test_effective_tools_intersects_policy_integrations_and_approval():
    reg, spec = _registry()
    allowed, unavailable = reg.effective_tools(spec)
    assert allowed == ["fetch_url", "memory_search", "knowledge_search"]
    assert "integration" in unavailable["web_search"]

    reg, spec = _registry({"tool_policy": {"fetch_url": {"enabled": False}}}, providers=["tavily"])
    allowed, unavailable = reg.effective_tools(spec)
    assert allowed == ["web_search", "memory_search", "knowledge_search"]
    assert unavailable["fetch_url"] == "disabled by organization policy"

    allowed, unavailable = reg.effective_tools(spec, approved={"memory_search"})
    assert allowed == ["memory_search"]
    assert unavailable["web_search"] == "not approved for this workflow"


def test_planner_catalog_excludes_instructions():
    reg, _ = _registry()
    catalog = reg.planner_catalog()
    assert catalog[0]["agent_id"] == "researcher"
    assert "instructions" not in json.dumps(catalog)


def test_output_schemas():
    with pytest.raises(ValueError, match="missing from sources"):
        ResearchResult(
            summary="A summary that is long enough.", confidence="low", evidence_notes="n/a",
            findings=[{"claim": "c", "source_urls": ["https://a.example/x"]}],
            sources=[{"url": "https://b.example/y"}],
        )
    with pytest.raises(ValueError, match="relative path"):
        CodeChange(summary="A summary that is long enough.", test_plan=["t"],
                   files=[{"path": "../etc/passwd", "language": "text", "action": "create", "content": ""}])
    assert "$ref" not in json.dumps(json_schema(ResearchResult))
