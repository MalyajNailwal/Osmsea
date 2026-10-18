"""Trusted schemas: agent outputs, plans and reviews.

Agent specs reference output schemas by name; they cannot define new ones. Every model forbids
unknown fields so a model cannot smuggle extra data into persisted results.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _str(lo: int, hi: int):
    return Annotated[str, StringConstraints(min_length=lo, max_length=hi)]


Line = _str(1, 500)
Text = _str(1, 4000)
Summary = _str(20, 4000)
Slug = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,47}$")]
TaskKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")]


def _source_ref(v: str) -> str:
    if v.startswith(("memory:", "mcp:", "doc:", "https://", "http://")):
        return v
    raise ValueError("must be an http(s) URL, memory:<id>, doc:<document>/<passage> or mcp:<server>/<tool>")


SourceRef = Annotated[str, StringConstraints(min_length=8, max_length=2000), AfterValidator(_source_ref)]


def _relative_path(v: str) -> str:
    p = PurePosixPath(v)
    if p.is_absolute() or ".." in p.parts or "\\" in v or v.startswith("~"):
        raise ValueError("must be a relative path without '..'")
    return v


# --- Output schemas ---------------------------------------------------------------------------


class Source(Strict):
    url: SourceRef
    title: str = Field("", max_length=300)


class Finding(Strict):
    claim: Text
    source_urls: list[SourceRef] = Field(min_length=1, max_length=10)


class ResearchResult(Strict):
    summary: Summary
    findings: list[Finding] = Field(min_length=1, max_length=30)
    sources: list[Source] = Field(min_length=1, max_length=30)
    confidence: Literal["low", "medium", "high"]
    # Required so every result states evidence quality explicitly: conflicts, weak sources, or agreement.
    evidence_notes: _str(1, 1000)
    open_questions: list[Line] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _citations_listed(self) -> ResearchResult:
        listed = {s.url for s in self.sources}
        missing = sorted({u for f in self.findings for u in f.source_urls} - listed)
        if missing:
            raise ValueError(f"findings cite URLs missing from sources: {missing[:5]}")
        return self


class FileChange(Strict):
    path: Annotated[str, StringConstraints(min_length=1, max_length=300), AfterValidator(_relative_path)]
    language: _str(1, 40)
    action: Literal["create", "modify"]
    content: _str(0, 100_000)


class CodeChange(Strict):
    summary: Summary
    files: list[FileChange] = Field(min_length=1, max_length=20)
    test_plan: list[Line] = Field(min_length=1, max_length=20)
    risks: list[Line] = Field(default_factory=list, max_length=20)
    test_command: _str(1, 300) | None = None  # e.g. "python -m pytest -q"; run in the sandbox when the spec asks

    @model_validator(mode="after")
    def _unique_paths(self) -> CodeChange:
        paths = [f.path for f in self.files]
        if len(paths) != len(set(paths)):
            raise ValueError("file paths must be unique")
        return self


class ReportSection(Strict):
    heading: Line
    body: _str(1, 8000)


class Report(Strict):
    title: Line
    summary: Summary
    sections: list[ReportSection] = Field(min_length=1, max_length=20)
    key_points: list[Line] = Field(default_factory=list, max_length=20)
    sources: list[Source] = Field(default_factory=list, max_length=30)


@dataclass(frozen=True)
class OutputSchema:
    model: type[BaseModel]
    description: str
    has_sources: bool = False
    has_files: bool = False


OUTPUT_SCHEMAS: dict[str, OutputSchema] = {
    "research_result_v1": OutputSchema(
        ResearchResult, "Summary, cited findings, sources, confidence, evidence notes and open questions", has_sources=True
    ),
    "code_change_v1": OutputSchema(
        CodeChange, "Proposed files with full contents, test plan and risks", has_files=True
    ),
    "report_v1": OutputSchema(
        Report, "Written report with sections, key points and optional sources", has_sources=True
    ),
}


# --- Plans and reviews --------------------------------------------------------------------------


class PlanTask(Strict):
    key: TaskKey
    title: _str(1, 200)
    description: _str(1, 4000)
    agent_id: Slug
    depends_on: list[TaskKey] = Field(default_factory=list, max_length=10)
    expected_output: _str(1, 1000)
    acceptance_criteria: list[Line] = Field(min_length=1, max_length=10)


class Plan(Strict):
    objective: _str(1, 2000)
    acceptance_criteria: list[Line] = Field(min_length=1, max_length=10)
    tasks: list[PlanTask] = Field(min_length=1, max_length=20)


class CriterionVerdict(Strict):
    criterion: Line
    met: bool
    reason: _str(1, 1000)


class Review(Strict):
    criteria: list[CriterionVerdict] = Field(min_length=1, max_length=30)
    verdict: Literal["pass", "fail"]
    summary: Text


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """JSON schema with $refs inlined; some providers reject $defs in tool parameters."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return resolve(copy.deepcopy(defs[node["$ref"].rsplit("/", 1)[-1]]))
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)
