import asyncio
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from osmsea.api import create_app
from osmsea.auth import User
from osmsea.config import Config
from osmsea.integrations import tool_secrets
from osmsea.llm import LLMResponse, ScriptedProvider, tool_reply
from osmsea.orgs import Actor, create_organization
from osmsea.specs import load_organization_dir
from osmsea.store import MemoryStore

ORG_DIR = Path(__file__).resolve().parents[2] / "organization"
ALICE = User("00000000-0000-0000-0000-00000000a11c", "alice@example.com")
BOB = User("00000000-0000-0000-0000-000000000b0b", "bob@example.com")
TOKENS = {"token-alice": ALICE, "token-bob": BOB}
TEST_CONFIG = Config(supabase_url="http://supabase.invalid", supabase_secret_key="x", supabase_publishable_key="x",
                     poll_interval=0.02, lease_seconds=60, allow_private_mcp_urls=True)


class FakeAuth:
    async def user(self, token: str) -> User | None:
        return TOKENS.get(token)


def auth(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer token-{user.email.split('@')[0]}"}


async def seed_org(db: MemoryStore, actor: User = ALICE, name: str = "Acme", settings: dict | None = None) -> dict:
    spec = load_organization_dir(ORG_DIR).model_copy(update={"name": name})
    return await create_organization(db, Actor(actor.id, actor.email), spec, settings=settings)


def criteria_count(messages: list[dict[str, Any]]) -> int:
    block = messages[-1]["content"].split("Acceptance criteria:")[1].split("Evidence retrieved")[0]
    return len(re.findall(r"^\d+\. ", block, re.M))


def review(messages: list[dict[str, Any]], verdict: str = "pass") -> LLMResponse:
    n = criteria_count(messages)
    return tool_reply("submit_review", {
        "criteria": [{"criterion": f"criterion {i}", "met": verdict == "pass", "reason": "judged from the output"}
                     for i in range(n)],
        "verdict": verdict, "summary": "All criteria are met." if verdict == "pass" else "Criteria not met."})


def tool_names(tools: list[dict[str, Any]]) -> set[str]:
    return {t["name"] for t in tools}


def tool_results(messages: list[dict[str, Any]]) -> list[str]:
    return [m["content"] for m in messages if m["role"] == "tool"]


@pytest.fixture
def db() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
async def client_factory(db):
    """Start the real app (lifespan + scheduler) on a MemoryStore with a scripted model."""
    started = []

    async def build(script, *, secrets: dict[str, str] | None = None) -> httpx.AsyncClient:
        provider = ScriptedProvider(script)

        async def provider_factory(org_id, model=None, org_default_model=None):
            return provider

        async def secrets_factory(org_id):  # the real resolver (Vault-backed in production), plus overrides
            return {**(await tool_secrets(db, org_id)), **(secrets or {})}

        app = create_app(TEST_CONFIG, db=db, provider_factory=provider_factory, secrets_factory=secrets_factory,
                         authenticator=FakeAuth())
        ctx = app.router.lifespan_context(app)
        await ctx.__aenter__()
        app.state.worker.retry_base_seconds = 0.01
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        client.app = app
        client.provider = provider
        started.append((ctx, client))
        return client

    yield build
    for ctx, client in reversed(started):
        await client.aclose()
        await ctx.__aexit__(None, None, None)


async def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if result := await predicate():
            return result
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)
