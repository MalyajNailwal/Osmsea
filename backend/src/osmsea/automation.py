"""Automation: organization API tokens (for the OSMSEA MCP server) and triggers that start workflows on a
schedule or from a webhook.

Secrets (tokens and webhook secrets) are random 256-bit values shown once; only their SHA-256 is stored.
A token acts as its creator with the member role, and stops working when it is revoked or its creator
leaves the organization. Triggered workflows follow normal planning, permissions and verification;
webhook payloads reach the planner only as untrusted data, and triggers require plan approval by default.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .auth import member_role
from .orgs import Actor, NotFound
from .planner import Conflict
from .specs import SpecError
from .store import now_iso, parse_ts, record_audit

log = logging.getLogger(__name__)

ACTIVE_WORKFLOW = ("planning", "awaiting_approval", "running")


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _new_secret(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


# --- API tokens ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Principal:
    org_id: str
    actor: Actor
    token_id: str


async def create_token(db: Any, org_id: str, actor: Actor, name: str) -> tuple[dict[str, Any], str]:
    token = _new_secret("osm")
    row = (await db.insert("api_tokens", {"org_id": org_id, "name": name.strip(), "token_hash": _digest(token),
                                          "prefix": token[:10], "created_by": actor.id}))[0]
    await record_audit(db, org_id, "api_token.create", "api_token", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=row["name"])
    return row, token


async def revoke_token(db: Any, org_id: str, token_id: str, actor: Actor) -> None:
    rows = await db.update("api_tokens", {"revoked_at": now_iso()}, filters={"id": token_id, "org_id": org_id, "revoked_at": ("is", None)})
    if not rows:
        raise NotFound("token not found or already revoked")
    await record_audit(db, org_id, "api_token.revoke", "api_token", actor_id=actor.id, actor_label=actor.email,
                       resource_id=token_id, resource_name=rows[0]["name"])


async def resolve_token(db: Any, token: str) -> Principal | None:
    if not token.startswith("osm_"):
        return None
    rows = await db.select("api_tokens", filters={"token_hash": _digest(token), "revoked_at": ("is", None)})
    if not rows or not rows[0].get("created_by"):
        return None
    row = rows[0]
    if await member_role(db, row["created_by"], row["org_id"]) is None:  # creator left the organization
        return None
    await db.update("api_tokens", {"last_used_at": now_iso()}, filters={"id": row["id"]})
    return Principal(row["org_id"], Actor(row["created_by"], f"token:{row['name']}"), row["id"])


# --- triggers ------------------------------------------------------------------------------------


def next_after(scheduled: datetime, interval_minutes: int, now: datetime) -> datetime:
    """The first run time after `now` on the trigger's grid; missed runs are skipped, not replayed."""
    step = timedelta(minutes=interval_minutes)
    return scheduled + ((now - scheduled) // step + 1) * step if scheduled <= now else scheduled


async def create_trigger(db: Any, org_id: str, actor: Actor, *, name: str, kind: str, goal: str,
                         interval_minutes: int | None = None, start_at: datetime | None = None,
                         require_approval: bool = True) -> tuple[dict[str, Any], str | None]:
    row: dict[str, Any] = {"org_id": org_id, "name": name.strip(), "kind": kind, "goal": goal.strip(),
                           "require_approval": require_approval, "created_by": actor.id, "enabled": True, "runs": 0}
    secret = None
    if kind == "schedule":
        if not interval_minutes or not 15 <= interval_minutes <= 525_600:
            raise SpecError(["interval_minutes: a schedule repeats every 15 minutes to 365 days"])
        first = start_at or datetime.now(UTC) + timedelta(minutes=interval_minutes)
        row |= {"interval_minutes": interval_minutes, "next_run_at": first.astimezone(UTC).isoformat()}
    elif kind == "webhook":
        secret = _new_secret("whk")
        row |= {"secret_hash": _digest(secret), "secret_prefix": secret[:10]}
    else:
        raise SpecError(["kind: must be schedule or webhook"])
    created = (await db.insert("triggers", row))[0]
    await record_audit(db, org_id, "trigger.create", "trigger", actor_id=actor.id, actor_label=actor.email,
                       resource_id=created["id"], resource_name=created["name"],
                       details={"kind": kind, "interval_minutes": interval_minutes, "require_approval": require_approval})
    return created, secret


async def update_trigger(db: Any, org_id: str, trigger_id: str, actor: Actor, changes: dict[str, Any]) -> dict[str, Any]:
    values = {k: v for k, v in changes.items() if v is not None}
    if not values:
        raise SpecError(["nothing to update"])
    rows = await db.update("triggers", values, filters={"id": trigger_id, "org_id": org_id})
    if not rows:
        raise NotFound("trigger not found")
    await record_audit(db, org_id, "trigger.update", "trigger", actor_id=actor.id, actor_label=actor.email,
                       resource_id=trigger_id, resource_name=rows[0]["name"], details=values)
    return rows[0]


async def delete_trigger(db: Any, org_id: str, trigger_id: str, actor: Actor) -> None:
    rows = await db.delete("triggers", filters={"id": trigger_id, "org_id": org_id})
    if not rows:
        raise NotFound("trigger not found")
    await record_audit(db, org_id, "trigger.delete", "trigger", actor_id=actor.id, actor_label=actor.email,
                       resource_id=trigger_id, resource_name=rows[0]["name"])


async def fire(db: Any, worker: Any, trigger: dict[str, Any], *, context: Any = None,
               actor_label: str | None = None) -> dict[str, Any]:
    """Start a workflow for a trigger, unless its previous run is still active (no pile-ups)."""
    if trigger.get("last_workflow_id"):
        prev = await db.select("workflows", filters={"id": trigger["last_workflow_id"]})
        if prev and prev[0]["status"] in ACTIVE_WORKFLOW:
            await db.update("triggers", {"last_error": "skipped: the previous run is still active"}, filters={"id": trigger["id"]})
            raise Conflict("the previous run of this trigger is still active")
    wf = await worker.start_workflow(trigger["org_id"], trigger["goal"], actor_id=trigger.get("created_by"),
                                     actor_label=actor_label or f"trigger:{trigger['name']}", trigger_id=trigger["id"],
                                     force_approval=trigger["require_approval"], context=context)
    await db.update("triggers", {"last_run_at": now_iso(), "last_workflow_id": wf["id"], "last_error": None,
                                 "runs": trigger.get("runs", 0) + 1}, filters={"id": trigger["id"]})
    return wf


async def fire_due(db: Any, worker: Any) -> int:
    """Start every enabled schedule trigger whose time has come. The next_run_at compare-and-swap means
    a run is started once even with several workers."""
    now = datetime.now(UTC)
    due = await db.select("triggers", filters={"kind": "schedule", "enabled": True, "next_run_at": ("lte", now.isoformat())})
    started = 0
    for t in due:
        nxt = next_after(parse_ts(t["next_run_at"]), t["interval_minutes"], now)
        if not await db.update("triggers", {"next_run_at": nxt.isoformat()},
                               filters={"id": t["id"], "next_run_at": t["next_run_at"]}):
            continue  # another worker took this run
        try:
            await fire(db, worker, t)
            started += 1
        except Conflict:
            pass
        except Exception as e:
            log.exception("trigger %s failed", t["id"])
            await db.update("triggers", {"last_error": f"{type(e).__name__}: {e}"[:500]}, filters={"id": t["id"]})
    return started


async def verify_webhook(db: Any, trigger_id: str, secret: str | None) -> dict[str, Any]:
    rows = await db.select("triggers", filters={"id": trigger_id, "kind": "webhook"})
    if not rows or not secret or not hmac.compare_digest(rows[0]["secret_hash"], _digest(secret)):
        raise NotFound("unknown webhook or wrong secret")  # same answer either way: no trigger enumeration
    if not rows[0]["enabled"]:
        raise Conflict("this trigger is disabled")
    return rows[0]
