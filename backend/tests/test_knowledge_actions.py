"""Knowledge base (uploads, passages, citations) and approval-gated GitHub pull requests (against a fake GitHub API)."""

import asyncio
import re
import socket

import pytest
import uvicorn
from conftest import ALICE, CAROL, auth, review, seed_org, tool_names, tool_results, wait_for
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from test_runtime import CODE, PLAN, RESEARCH_ONLY, submit, workflow

from osmsea import github
from osmsea.llm import tool_reply

HANDBOOK = """# Refund policy

Customers can request a full refund within 30 days of purchase. Refunds are issued to the original payment method.

# Support hours

Support is available Monday to Friday, 9:00 to 17:00 CET. Urgent incidents are handled around the clock.
"""


def tiny_pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF with one line of Helvetica text per page."""
    n, objs = len(pages), ["<< /Type /Catalog /Pages 2 0 R >>"]
    objs.append(f"<< /Type /Pages /Kids [{' '.join(f'{3 + 2 * i} 0 R' for i in range(n))}] /Count {n} >>")
    for i, text in enumerate(pages):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {3 + 2 * n} 0 R >> >> "
                    f"/Contents {4 + 2 * i} 0 R >>")
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    return out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()


def researcher_citing_documents(messages, tools):
    names = tool_names(tools)
    if "submit_plan" in names:
        return tool_reply("submit_plan", RESEARCH_ONLY)
    if "submit_review" in names:
        return review(messages)
    results = tool_results(messages)
    if not results:
        return tool_reply("knowledge_search", {"query": "refund policy days"})
    cites = re.findall(r"\[(doc:[^\]]+)\]", results[0])
    return tool_reply("submit_result", {
        "summary": "Customers can get a full refund within 30 days of purchase, paid back to the original payment method.",
        "findings": [{"claim": "Refunds are available within 30 days of purchase", "source_urls": [cites[0]]}],
        "sources": [{"url": cites[0], "title": "Handbook"}], "confidence": "high",
        "evidence_notes": "Single authoritative internal source; no conflicts found.", "open_questions": []})


async def test_documents_become_citable_passages(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    client = await client_factory(researcher_citing_documents)
    base = f"/orgs/{org['id']}/documents"

    r = await client.post(base, files={"file": ("handbook.md", HANDBOOK.encode(), "text/markdown")}, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    doc = r.json()
    chunks = await db.select("document_chunks", filters={"document_id": doc["id"]})
    assert doc["chunks"] == len(chunks) == 2 and {c["heading"] for c in chunks} == {"Refund policy", "Support hours"}
    dup = await client.post(base, files={"file": ("copy.md", HANDBOOK.encode(), "text/markdown")}, headers=auth(ALICE))
    assert dup.status_code == 409
    bad = await client.post(base, files={"file": ("tool.exe", b"MZ", "application/octet-stream")}, headers=auth(ALICE))
    assert bad.status_code == 422

    r = await client.post(base, files={"file": ("terms.pdf", tiny_pdf(["Delivery takes five days", "Warranty lasts two years"]),
                                                "application/pdf")}, data={"title": "Terms of sale"}, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    assert r.json()["pages"] == 2 and r.json()["title"] == "Terms of sale"
    hits = (await client.get(f"{base}/search", params={"q": "warranty"}, headers=auth(ALICE))).json()
    assert [(h["title"], h["page"]) for h in hits] == [("Terms of sale", 2)]

    # An agent cites a passage it retrieved; the citation check accepts it because it was returned in this run.
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "completed"))
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    cited = task["output"]["sources"][0]["url"]
    assert cited == f"doc:{doc['id']}/0"
    assert {c["name"]: c["passed"] for c in task["verification"]["checks"]}["cited_evidence"] is True

    assert (await client.delete(f"{base}/{doc['id']}", headers=auth(ALICE))).status_code == 204
    assert await db.select("document_chunks", filters={"document_id": doc["id"]}) == []


# --- GitHub delivery ---------------------------------------------------------------------------------

TOKEN = "ghp_test_token_123456"


@pytest.fixture
async def fake_github(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def handle(request: Request):
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return JSONResponse({"message": "Bad credentials"}, 401)
        body = await request.json() if request.method == "POST" else None
        path = request.url.path
        calls.append((request.method, path, body))
        if request.method == "GET" and path.count("/") == 3:
            return JSONResponse({"full_name": "acme/widgets", "default_branch": "main", "permissions": {"push": True}})
        if "/git/ref/heads/" in path:
            return JSONResponse({"object": {"sha": "base-sha"}})
        if "/git/commits/" in path:
            return JSONResponse({"tree": {"sha": "base-tree"}})
        if path.endswith("/git/trees"):
            return JSONResponse({"sha": "new-tree"}, 201)
        if path.endswith("/git/commits"):
            return JSONResponse({"sha": "new-commit"}, 201)
        if path.endswith("/git/refs"):
            return JSONResponse({"ref": body["ref"]}, 201)
        if path.endswith("/pulls"):
            return JSONResponse({"html_url": "https://github.com/acme/widgets/pull/7", "number": 7}, 201)
        return JSONResponse({"message": "Not Found"}, 404)

    app = Starlette(routes=[Route("/{path:path}", handle, methods=["GET", "POST"])])
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    monkeypatch.setattr(github, "API", f"http://127.0.0.1:{port}")
    yield calls
    server.should_exit = True
    await task


def developer(code):
    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", {**PLAN, "tasks": [{**PLAN["tasks"][1], "depends_on": []}]})
        if "submit_review" in names:
            return review(messages)
        return tool_reply("submit_result", code)
    return route


async def test_verified_code_becomes_a_draft_pull_request_only_after_approval(db, client_factory, fake_github):
    org = await seed_org(db, settings={"require_plan_approval": False})
    await db.insert("organization_members", {"org_id": org["id"], "user_id": CAROL.id, "role": "member", "email": CAROL.email})
    client = await client_factory(developer(CODE))
    r = await client.put(f"/orgs/{org['id']}/integrations/github", json={"secret": TOKEN, "config": {"repo": "acme/widgets"}},
                         headers=auth(ALICE))
    assert r.status_code == 200, r.text
    tested = await client.post(f"/orgs/{org['id']}/integrations/github/test", headers=auth(ALICE))
    assert tested.json()["last_test_ok"] is True and "acme/widgets" in tested.json()["last_test_message"]

    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "completed"))
    action = (await db.select("actions", filters={"workflow_id": wf_id}))[0]
    assert action["status"] == "pending" and action["payload"]["repo"] == "acme/widgets"
    assert [f["path"] for f in action["payload"]["files"]] == ["client.py", "test_client.py"]
    assert not any(m == "POST" for m, _, _ in fake_github)  # nothing touched GitHub before approval

    url = f"/orgs/{org['id']}/actions/{action['id']}"
    assert (await client.post(f"{url}/approve", headers=auth(CAROL))).status_code == 403  # members cannot approve
    r = await client.post(f"{url}/approve", headers=auth(ALICE))
    assert r.status_code == 200 and r.json()["status"] == "succeeded"
    assert r.json()["result"]["url"] == "https://github.com/acme/widgets/pull/7"
    tree = next(b for m, p, b in fake_github if p.endswith("/git/trees"))
    assert {t["path"]: t["content"] for t in tree["tree"]}["client.py"] == CODE["files"][0]["content"]  # the verified files
    pr = next(b for m, p, b in fake_github if p.endswith("/pulls"))
    assert pr["draft"] is True and pr["base"] == "main" and pr["head"].startswith("osmsea/build-")
    assert "Verification by OSMSEA" in pr["body"] and "tests" in pr["body"]
    assert (await client.post(f"{url}/approve", headers=auth(ALICE))).status_code == 409  # runs once
    audit = (await db.select("audit_events", filters={"action": "action.github_pull_request"}))[0]
    assert audit["outcome"] == "success" and audit["actor_label"] == ALICE.email


async def test_ci_workflow_files_are_never_delivered(db, client_factory, fake_github):
    org = await seed_org(db, settings={"require_plan_approval": False})
    sneaky = {**CODE, "files": [*CODE["files"], {"path": ".github/workflows/deploy.yml", "language": "yaml", "action": "create",
                                                 "content": "on: push\njobs: {}\n"}]}
    client = await client_factory(developer(sneaky))
    await client.put(f"/orgs/{org['id']}/integrations/github", json={"secret": TOKEN, "config": {"repo": "acme/widgets"}},
                     headers=auth(ALICE))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "completed"))
    action = (await db.select("actions", filters={"workflow_id": wf_id}))[0]
    assert action["payload"]["blocked_paths"] == [".github/workflows/deploy.yml"]
    r = await client.post(f"/orgs/{org['id']}/actions/{action['id']}/approve", headers=auth(ALICE))
    assert r.json()["status"] == "failed" and ".github/" in r.json()["error"]
    assert not any(m == "POST" for m, _, _ in fake_github)
