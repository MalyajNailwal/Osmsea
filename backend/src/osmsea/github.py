"""GitHub delivery: open a draft pull request containing a task's verified files (REST API, no git binary)."""

from __future__ import annotations

import re
from typing import Any

import httpx

API = "https://api.github.com"  # ponytail: github.com only; make it configurable for GitHub Enterprise Server
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


class GitHubError(Exception):
    pass


async def _gh(http: httpx.AsyncClient, method: str, path: str, token: str, **kw: Any) -> Any:
    try:
        r = await http.request(method, f"{API}{path}", timeout=30, **kw, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    except httpx.HTTPError as e:
        raise GitHubError(f"could not reach GitHub ({type(e).__name__})") from e
    if r.status_code >= 400:
        try:
            message = r.json().get("message", "")
        except ValueError:
            message = r.text[:200]
        raise GitHubError(f"GitHub {method} {path.split('?')[0]} failed: HTTP {r.status_code} {message}".strip())
    return r.json()


async def check_repo(http: httpx.AsyncClient, token: str, repo: str) -> str:
    """Prove the token can push to the repository. Returns a short description for the integration card."""
    if not REPO_RE.match(repo):
        raise GitHubError("repo must look like owner/name")
    info = await _gh(http, "GET", f"/repos/{repo}", token)
    if not (info.get("permissions") or {}).get("push"):
        raise GitHubError(f"the token cannot write to {repo}; grant Contents and Pull requests: read and write")
    return f"Write access to {info['full_name']} (default branch {info['default_branch']})"


async def open_pull_request(http: httpx.AsyncClient, token: str, *, repo: str, base: str | None, branch: str,
                            title: str, body: str, files: list[tuple[str, str]]) -> dict[str, Any]:
    """Create branch `branch` from `base` with one commit holding `files`, then open a draft pull request."""
    if not REPO_RE.match(repo) or not BRANCH_RE.match(branch) or (base and not BRANCH_RE.match(base)):
        raise GitHubError("invalid repository or branch name")
    base = base or (await _gh(http, "GET", f"/repos/{repo}", token))["default_branch"]
    head_sha = (await _gh(http, "GET", f"/repos/{repo}/git/ref/heads/{base}", token))["object"]["sha"]
    base_tree = (await _gh(http, "GET", f"/repos/{repo}/git/commits/{head_sha}", token))["tree"]["sha"]
    tree = await _gh(http, "POST", f"/repos/{repo}/git/trees", token, json={
        "base_tree": base_tree, "tree": [{"path": p, "mode": "100644", "type": "blob", "content": c} for p, c in files]})
    commit = await _gh(http, "POST", f"/repos/{repo}/git/commits", token, json={
        "message": title, "tree": tree["sha"], "parents": [head_sha]})
    await _gh(http, "POST", f"/repos/{repo}/git/refs", token, json={"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    pr = await _gh(http, "POST", f"/repos/{repo}/pulls", token, json={
        "title": title, "head": branch, "base": base, "body": body, "draft": True})
    return {"url": pr["html_url"], "number": pr["number"], "branch": branch, "base": base, "commit": commit["sha"]}
