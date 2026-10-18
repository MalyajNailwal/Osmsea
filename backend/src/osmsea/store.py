"""Persistence.

``SupabaseStore`` talks to PostgREST with the service role (the backend is the only writer).
``MemoryStore`` implements the same small API in memory for deterministic tests.

    select(table, filters=..., order=..., limit=...)   insert(table, rows)
    update(table, values, filters=...)                 delete(table, filters=...)
    rpc(fn, args)

Filters: ``{"col": value}`` is equality; ``{"col": ("op", value)}`` with op in
eq, neq, lt, lte, gt, gte, in, is. ``update`` returns only the rows it changed, so filtering on the
current status gives an atomic compare-and-swap (used to claim tasks exactly once).
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import logging
import re
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

import httpx

log = logging.getLogger(__name__)

Filters = dict[str, Any]


class StoreError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code  # Postgres error code, e.g. 23505 unique violation


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def parse_ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _cond(cond: Any) -> tuple[str, Any]:
    return cond if isinstance(cond, tuple) else ("eq", cond)


# --- Supabase (PostgREST) ------------------------------------------------------------------------


def _literal(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _pg_filter(op: str, value: Any) -> str:
    if op == "in":
        quoted = ",".join('"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"' for x in value)
        return f"in.({quoted})"
    return f"{op}.{_literal(value)}"


class SupabaseStore:
    def __init__(self, url: str, secret_key: str, client: httpx.AsyncClient | None = None):
        self.http = client or httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": secret_key, "Content-Type": "application/json"},
            timeout=httpx.Timeout(20.0),
        )

    async def close(self) -> None:
        await self.http.aclose()

    @staticmethod
    def _params(filters: Filters | None, order: str | None = None, limit: int | None = None,
                columns: str | None = None) -> list[tuple[str, str]]:
        params = [("select", columns)] if columns else []
        for col, cond in (filters or {}).items():
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", col):
                raise ValueError(f"invalid column {col!r}")
            op, value = _cond(cond)
            if op == "in" and not value:
                raise ValueError("empty 'in' filter")
            params.append((col, _pg_filter(op, value)))
        if order:
            params.append(("order", order))
        if limit:
            params.append(("limit", str(limit)))
        return params

    async def _request(self, method: str, path: str, *, params=None, json=None, prefer: str | None = None) -> Any:
        headers = {"Prefer": prefer} if prefer else {}
        # Reads and filtered PATCH/DELETE are idempotent, so transient network errors are retried.
        # POST (inserts, RPCs such as the usage counter) is not, so it is never retried here.
        attempts = 1 if method == "POST" else 3
        for attempt in range(attempts):
            try:
                r = await self.http.request(method, path, params=params, json=json, headers=headers)
            except httpx.TransportError as e:
                if attempt + 1 == attempts:
                    raise StoreError(f"{method} {path}: {type(e).__name__}") from e
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            if r.status_code >= 500 and attempt + 1 < attempts:
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            if r.status_code >= 400:
                code = None
                try:
                    code = r.json().get("code")
                except ValueError:
                    pass
                raise StoreError(f"{method} {path}: {r.status_code} {r.text[:300]}", r.status_code, code)
            return r.json() if r.content else None
        raise StoreError(f"{method} {path}: retries exhausted")

    async def select(self, table: str, *, filters: Filters | None = None, order: str | None = None,
                     limit: int | None = None, columns: str = "*") -> list[dict[str, Any]]:
        return await self._request("GET", f"/{table}", params=self._params(filters, order, limit, columns))

    async def insert(self, table: str, rows: dict | list[dict]) -> list[dict[str, Any]]:
        return await self._request("POST", f"/{table}", json=rows, prefer="return=representation")

    async def update(self, table: str, values: dict[str, Any], *, filters: Filters) -> list[dict[str, Any]]:
        if not filters:
            raise ValueError("refusing to update without filters")
        return await self._request("PATCH", f"/{table}", params=self._params(filters), json=values,
                                   prefer="return=representation")

    async def delete(self, table: str, *, filters: Filters) -> list[dict[str, Any]]:
        if not filters:
            raise ValueError("refusing to delete without filters")
        return await self._request("DELETE", f"/{table}", params=self._params(filters), prefer="return=representation")

    async def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        return await self._request("POST", f"/rpc/{fn}", json=args)


# --- In-memory (tests) ---------------------------------------------------------------------------


class MemoryStore:
    """Same API as SupabaseStore. Single-threaded asyncio makes each call atomic, like a SQL statement."""

    IDENTITY_TABLES = {"execution_events", "audit_events"}
    UNIQUE = {
        "agent_executions": [("task_id", "attempt")],
        "tasks": [("workflow_id", "key")],
        "agents": [("org_id", "slug")],
        "departments": [("org_id", "slug")],
        "integrations": [("org_id", "provider")],
        "agent_versions": [("agent_id", "version")],
        "organization_members": [("org_id", "user_id")],
        "mcp_servers": [("org_id", "slug")],
        "eval_cases": [("source_execution_id",)],
        "api_tokens": [("token_hash",)],
        "invitations": [("token_hash",)],
        "documents": [("org_id", "sha256")],
        "document_chunks": [("document_id", "ordinal")],
        "actions": [("task_id", "kind")],
    }

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.secrets: dict[str, str] = {}
        self._seq = itertools.count(1)

    @staticmethod
    def _match(row: dict, filters: Filters | None) -> bool:
        for col, cond in (filters or {}).items():
            op, want = _cond(cond)
            have = row.get(col)
            if op == "eq" and have != want:
                return False
            if op == "neq" and have == want:
                return False
            if op == "in" and have not in want:
                return False
            if op == "is" and have is not want:
                return False
            if op in ("lt", "lte", "gt", "gte"):
                if have is None:
                    return False
                if isinstance(want, datetime):
                    want = want.isoformat()
                if not {"lt": have < want, "lte": have <= want, "gt": have > want, "gte": have >= want}[op]:
                    return False
        return True

    def _check_unique(self, table: str, row: dict, ignore: dict | None = None) -> None:
        for cols in self.UNIQUE.get(table, []):
            key = tuple(row.get(c) for c in cols)
            for other in self.tables[table]:
                if other is not ignore and tuple(other.get(c) for c in cols) == key:
                    raise StoreError(f"duplicate key {cols}={key} in {table}", 409, "23505")

    async def select(self, table: str, *, filters: Filters | None = None, order: str | None = None,
                     limit: int | None = None, columns: str = "*") -> list[dict[str, Any]]:
        rows = [copy.deepcopy(r) for r in self.tables[table] if self._match(r, filters)]
        for part in reversed((order or "").split(",") if order else []):
            col, _, direction = part.partition(".")
            rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=direction.startswith("desc"))
        return rows[:limit] if limit else rows

    async def insert(self, table: str, rows: dict | list[dict]) -> list[dict[str, Any]]:
        out = []
        for row in rows if isinstance(rows, list) else [rows]:
            row = copy.deepcopy(row)
            if table in self.IDENTITY_TABLES:
                row["id"] = next(self._seq)
            else:
                row.setdefault("id", str(uuid.uuid4()))
            row.setdefault("created_at", now_iso())
            row.setdefault("updated_at", row["created_at"])
            self._check_unique(table, row)
            self.tables[table].append(row)
            out.append(copy.deepcopy(row))
        return out

    async def update(self, table: str, values: dict[str, Any], *, filters: Filters) -> list[dict[str, Any]]:
        if not filters:
            raise ValueError("refusing to update without filters")
        out = []
        for row in self.tables[table]:
            if self._match(row, filters):
                self._check_unique(table, {**row, **values}, ignore=row)
                row.update(copy.deepcopy(values))
                row["updated_at"] = now_iso()
                out.append(copy.deepcopy(row))
        return out

    async def delete(self, table: str, *, filters: Filters) -> list[dict[str, Any]]:
        if not filters:
            raise ValueError("refusing to delete without filters")
        keep, gone = [], []
        for row in self.tables[table]:
            (gone if self._match(row, filters) else keep).append(row)
        self.tables[table] = keep
        return copy.deepcopy(gone)

    async def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        if fn == "search_memory":
            words = [w for w in re.split(r"\s+or\s+|\s+", args.get("p_query") or "", flags=re.I) if w]
            rows = [r for r in self.tables["memory_items"] if r["org_id"] == args["p_org"]]
            if words:
                rows = [r for r in rows if any(w.lower() in (r["title"] + " " + r["content"]).lower() for w in words)]
            return copy.deepcopy(sorted(rows, key=lambda r: r["created_at"], reverse=True)[: args.get("p_limit", 10)])
        if fn == "search_documents":
            words = [w.lower() for w in re.split(r"\s+or\s+|\s+", args.get("p_query") or "", flags=re.I) if w]
            docs = {d["id"]: d for d in self.tables["documents"]}
            hits = [c for c in self.tables["document_chunks"] if c["org_id"] == args["p_org"]
                    and any(w in ((c.get("heading") or "") + " " + c["content"]).lower() for w in words)]
            return [{"chunk_id": c["id"], "document_id": c["document_id"], "title": docs[c["document_id"]]["title"],
                     "ordinal": c["ordinal"], "page": c.get("page"), "heading": c.get("heading"), "content": c["content"],
                     "rank": 1.0} for c in hits[: args.get("p_limit", 5)]]
        if fn == "set_integration_secret":
            self.secrets[args["p_integration"]] = args["p_secret"]
            return None
        if fn == "get_integration_secret":
            return self.secrets.get(args["p_integration"])
        if fn == "set_mcp_secret":
            self.secrets[f"mcp:{args['p_server']}"] = args["p_secret"]
            return None
        if fn == "get_mcp_secret":
            return self.secrets.get(f"mcp:{args['p_server']}")
        if fn == "add_workflow_usage":
            for row in self.tables["workflows"]:
                if row["id"] == args["p_workflow"]:
                    row["tokens_used"] = row.get("tokens_used", 0) + args["p_tokens"]
                    row["cost_usd"] = float(row.get("cost_usd") or 0) + float(args.get("p_cost") or 0)
                    return row["tokens_used"]
            raise StoreError("workflow not found", 404)
        raise StoreError(f"unknown rpc {fn}", 404)


# --- Journal helpers -----------------------------------------------------------------------------


async def record_event(db: Any, org_id: str, type_: str, message: str, *, level: str = "info",
                       workflow_id: str | None = None, task_id: str | None = None, execution_id: str | None = None,
                       agent_id: str | None = None, data: dict | None = None) -> None:
    """Append an execution event. Events are observability, so failures are logged, not raised."""
    try:
        await db.insert("execution_events", {
            "org_id": org_id, "type": type_, "message": message[:2000], "level": level,
            "workflow_id": workflow_id, "task_id": task_id, "execution_id": execution_id,
            "agent_id": agent_id, "data": data or {},
        })
    except Exception:
        log.exception("failed to record event %s", type_)


async def record_audit(db: Any, org_id: str | None, action: str, resource_type: str, *, actor_type: str = "user",
                       actor_id: str | None = None, actor_label: str = "", resource_id: str | None = None,
                       resource_name: str | None = None, outcome: str = "success", details: dict | None = None) -> None:
    try:
        await db.insert("audit_events", {
            "org_id": org_id, "action": action, "resource_type": resource_type, "actor_type": actor_type,
            "actor_id": actor_id, "actor_label": actor_label, "resource_id": resource_id,
            "resource_name": resource_name, "outcome": outcome, "details": details or {},
        })
    except Exception:
        log.exception("failed to record audit %s", action)
