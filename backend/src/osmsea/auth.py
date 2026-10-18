"""Authentication (Supabase Auth sessions) and organization role checks."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any

import httpx

ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}
CACHE_SECONDS = 60


@dataclass(frozen=True)
class User:
    id: str
    email: str


class Authenticator:
    """Validates a Supabase access token by asking Supabase Auth, which also catches revoked sessions.

    ponytail: one Auth round-trip per token per minute; verify JWTs locally against the project's
    JWKS if that latency matters.
    """

    def __init__(self, supabase_url: str, publishable_key: str, http: httpx.AsyncClient):
        self._url = f"{supabase_url.rstrip('/')}/auth/v1/user"
        self._key = publishable_key
        self._http = http
        self._cache: dict[str, tuple[float, User]] = {}

    async def user(self, token: str) -> User | None:
        digest = hashlib.sha256(token.encode()).hexdigest()
        hit = self._cache.get(digest)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        try:
            r = await self._http.get(self._url, headers={"apikey": self._key, "Authorization": f"Bearer {token}"}, timeout=10)
        except httpx.HTTPError:
            return None
        if r.status_code != 200:
            return None
        data = r.json()
        user = User(id=data["id"], email=data.get("email") or "")
        if len(self._cache) > 5000:
            self._cache.clear()
        self._cache[digest] = (time.monotonic() + CACHE_SECONDS, user)
        return user


async def member_role(db: Any, user_id: str, org_id: str) -> str | None:
    rows = await db.select("organization_members", filters={"org_id": org_id, "user_id": user_id})
    return rows[0]["role"] if rows else None


def role_allows(role: str | None, minimum: str) -> bool:
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[minimum]
