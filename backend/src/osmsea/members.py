"""Organization membership: invitation links, role changes and leaving.

An invitation is a link with a random token (shown once, stored as SHA-256) that expires after seven days
and works only for the invited email address, once that address is confirmed in Supabase Auth. The owner's
membership cannot be changed or removed, and nobody changes their own role.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from .auth import User
from .orgs import Actor, NotFound
from .planner import Conflict
from .specs import SpecError
from .store import now_iso, parse_ts, record_audit

INVITE_DAYS = 7
GRANTABLE = ("viewer", "member", "admin")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _status(row: dict[str, Any]) -> str:
    if row.get("accepted_at"):
        return "accepted"
    if row.get("revoked_at"):
        return "revoked"
    return "expired" if parse_ts(row["expires_at"]) <= datetime.now(UTC) else "pending"


async def create_invitation(db: Any, org_id: str, actor: Actor, email: str, role: str) -> tuple[dict[str, Any], str]:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise SpecError(["email: not a valid email address"])
    if role not in GRANTABLE:
        raise SpecError([f"role: must be one of {', '.join(GRANTABLE)}"])
    if await db.select("organization_members", filters={"org_id": org_id, "email": email}):
        raise Conflict(f"{email} is already a member")
    for old in await db.select("invitations", filters={"org_id": org_id, "email": email, "accepted_at": ("is", None),
                                                       "revoked_at": ("is", None)}):
        await db.update("invitations", {"revoked_at": now_iso()}, filters={"id": old["id"]})  # one live link per email
    token = f"inv_{secrets.token_urlsafe(32)}"
    row = (await db.insert("invitations", {
        "org_id": org_id, "email": email, "role": role, "token_hash": _digest(token), "invited_by": actor.id,
        "expires_at": (datetime.now(UTC) + timedelta(days=INVITE_DAYS)).isoformat(),
    }))[0]
    await record_audit(db, org_id, "member.invite", "member", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=email, details={"role": role})
    return row, token


async def revoke_invitation(db: Any, org_id: str, invitation_id: str, actor: Actor) -> None:
    rows = await db.update("invitations", {"revoked_at": now_iso()},
                           filters={"id": invitation_id, "org_id": org_id, "accepted_at": ("is", None), "revoked_at": ("is", None)})
    if not rows:
        raise NotFound("invitation not found or no longer pending")
    await record_audit(db, org_id, "member.invite_revoke", "member", actor_id=actor.id, actor_label=actor.email,
                       resource_id=invitation_id, resource_name=rows[0]["email"])


async def _by_token(db: Any, token: str) -> dict[str, Any]:
    rows = await db.select("invitations", filters={"token_hash": _digest(token)}) if token.startswith("inv_") else []
    if not rows:
        raise NotFound("invitation not found")
    return rows[0]


async def preview_invitation(db: Any, token: str) -> dict[str, Any]:
    inv = await _by_token(db, token)
    org = (await db.select("organizations", filters={"id": inv["org_id"]}))[0]
    return {"organization": org["name"], "role": inv["role"], "email": inv["email"], "status": _status(inv),
            "expires_at": inv["expires_at"]}


async def accept_invitation(db: Any, token: str, user: User) -> dict[str, Any]:
    inv = await _by_token(db, token)
    if (status := _status(inv)) != "pending":
        raise Conflict(f"this invitation is {status}; ask an admin for a new link")
    if user.email.strip().lower() != inv["email"]:
        raise Conflict(f"this invitation is for {inv['email']}; sign in with that address")
    if not user.email_confirmed:
        raise Conflict("confirm your email address first (check your inbox), then open the link again")
    if not await db.update("invitations", {"accepted_at": now_iso(), "accepted_by": user.id},
                           filters={"id": inv["id"], "accepted_at": ("is", None), "revoked_at": ("is", None)}):
        raise Conflict("this invitation was just used or revoked")
    if not await db.select("organization_members", filters={"org_id": inv["org_id"], "user_id": user.id}):
        await db.insert("organization_members", {"org_id": inv["org_id"], "user_id": user.id, "role": inv["role"],
                                                 "email": inv["email"]})
    await record_audit(db, inv["org_id"], "member.join", "member", actor_id=user.id, actor_label=user.email,
                       resource_id=user.id, resource_name=user.email, details={"role": inv["role"], "invitation_id": inv["id"]})
    return {"org_id": inv["org_id"], "role": inv["role"]}


async def _member(db: Any, org_id: str, user_id: str) -> dict[str, Any]:
    rows = await db.select("organization_members", filters={"org_id": org_id, "user_id": user_id})
    if not rows:
        raise NotFound("member not found")
    return rows[0]


async def set_role(db: Any, org_id: str, actor: Actor, user_id: str, role: str) -> dict[str, Any]:
    if role not in GRANTABLE:
        raise SpecError([f"role: must be one of {', '.join(GRANTABLE)}"])
    target = await _member(db, org_id, user_id)
    if target["role"] == "owner":
        raise Conflict("the owner's role cannot be changed")
    if user_id == actor.id:
        raise Conflict("you cannot change your own role")
    row = (await db.update("organization_members", {"role": role}, filters={"org_id": org_id, "user_id": user_id}))[0]
    await record_audit(db, org_id, "member.role", "member", actor_id=actor.id, actor_label=actor.email, resource_id=user_id,
                       resource_name=target["email"], details={"from": target["role"], "to": role})
    return row


async def remove_member(db: Any, org_id: str, actor: Actor, actor_role: str, user_id: str) -> None:
    """Admins remove others; anyone may leave. The owner can do neither to their own membership."""
    target = await _member(db, org_id, user_id)
    if target["role"] == "owner":
        raise Conflict("the owner cannot be removed")
    leaving = user_id == actor.id
    if not leaving and actor_role not in ("admin", "owner"):
        raise Conflict("only admins can remove other members")
    await db.delete("organization_members", filters={"org_id": org_id, "user_id": user_id})
    await record_audit(db, org_id, "member.leave" if leaving else "member.remove", "member", actor_id=actor.id,
                       actor_label=actor.email, resource_id=user_id, resource_name=target["email"])
