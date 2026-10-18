"""External integrations: catalog, credential tests and runtime resolution.

Credentials are stored in Supabase Vault (``set_integration_secret``) and read back only here, on
the server, at the moment a model or tool call needs them. They are never returned by the API,
logged, or placed in prompts.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import Config
from .llm import LLMProvider, OpenAICompatProvider
from .tools import ToolError, _resolve_public

OPENROUTER_URL = "https://openrouter.ai/api/v1"


@dataclass(frozen=True)
class ProviderInfo:
    id: str
    name: str
    kind: str  # llm | search
    description: str
    secret_label: str
    docs_url: str
    config_fields: dict[str, str] = field(default_factory=dict)  # field -> placeholder/default
    enables: tuple[str, ...] = ()


PROVIDERS: dict[str, ProviderInfo] = {
    p.id: p
    for p in (
        ProviderInfo("openrouter", "OpenRouter", "llm",
                     "Routes planning, agent and review calls to hundreds of models through one key.",
                     "OPENROUTER_API_KEY", "https://openrouter.ai/keys",
                     {"model": "anthropic/claude-sonnet-5"}, ("planning", "agent execution", "independent review")),
        ProviderInfo("openai_compatible", "OpenAI-compatible", "llm",
                     "Any endpoint that implements /chat/completions with tool calling (OpenAI, Groq, Together, vLLM).",
                     "API_KEY", "https://platform.openai.com/api-keys",
                     {"base_url": "https://api.openai.com/v1", "model": "gpt-5"}, ("planning", "agent execution", "independent review")),
        ProviderInfo("tavily", "Tavily", "search", "Web search API built for agents. Enables the web_search tool.",
                     "TAVILY_API_KEY", "https://app.tavily.com/home", {}, ("web_search",)),
        ProviderInfo("brave_search", "Brave Search", "search", "Independent web index. Enables the web_search tool.",
                     "BRAVE_SEARCH_API_KEY", "https://api-dashboard.search.brave.com/app/keys", {}, ("web_search",)),
    )
}


def catalog() -> list[dict[str, Any]]:
    return [asdict(p) for p in PROVIDERS.values()]


class ProviderNotConfigured(Exception):
    pass


async def check_base_url(url: str, config: Config) -> None:
    """Admin-supplied LLM base URLs must be public https endpoints (blocks SSRF into private networks)."""
    parts = urlsplit(url)
    if config.allow_private_llm_urls:
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ToolError("base_url must be an http(s) URL")
        return
    if parts.scheme != "https" or not parts.hostname:
        raise ToolError("base_url must be an https URL")
    # ponytail: resolves at check time only; pin DNS like tools.safe_get if admins are untrusted.
    await _resolve_public(parts.hostname, parts.port or 443)


async def _secret(db: Any, integration_id: str) -> str | None:
    return await db.rpc("get_integration_secret", {"p_integration": integration_id})


async def llm_provider_for_org(db: Any, config: Config, org_id: str | None, *, model: str | None = None,
                               org_default_model: str | None = None, http: httpx.AsyncClient | None = None) -> LLMProvider:
    """Model precedence: agent spec `model` > org setting > integration config > server default."""
    rows = []
    if org_id:
        rows = await db.select("integrations", filters={
            "org_id": org_id, "provider": ("in", ["openrouter", "openai_compatible"]), "status": "configured"})
    row = next((r for r in rows if r["provider"] == "openrouter"), rows[0] if rows else None)
    if row:
        key = await _secret(db, row["id"])
        if not key:
            raise ProviderNotConfigured(f"the {row['provider']} integration has no stored credential")
        cfg = row.get("config") or {}
        base = OPENROUTER_URL if row["provider"] == "openrouter" else cfg.get("base_url", "")
        if row["provider"] != "openrouter":
            await check_base_url(base, config)
        chosen = model or org_default_model or cfg.get("model") or config.default_model
        return OpenAICompatProvider(api_key=key, model=chosen, base_url=base, name=row["provider"], http=http)
    if config.llm_api_key:
        name = "openrouter" if "openrouter.ai" in config.llm_base_url else "openai_compatible"
        return OpenAICompatProvider(api_key=config.llm_api_key, model=model or org_default_model or config.default_model,
                                    base_url=config.llm_base_url, name=name, http=http)
    raise ProviderNotConfigured(
        "No LLM provider is configured. An admin can add an OpenRouter API key under Integrations.")


async def tool_secrets(db: Any, org_id: str) -> dict[str, str]:
    """Credentials for tool adapters (search providers), keyed by provider id."""
    rows = await db.select("integrations", filters={
        "org_id": org_id, "provider": ("in", ["tavily", "brave_search"]), "status": "configured"})
    out = {}
    for row in rows:
        if key := await _secret(db, row["id"]):
            out[row["provider"]] = key
    return out


async def test_credential(provider: str, secret: str, cfg: dict[str, Any], http: httpx.AsyncClient,
                          config: Config) -> tuple[bool, str]:
    """Make the cheapest real call that proves the credential works."""
    try:
        if provider == "openrouter":
            r = await http.get(f"{OPENROUTER_URL}/key", headers={"Authorization": f"Bearer {secret}"}, timeout=15)
            if r.status_code == 200:
                d = r.json().get("data", {})
                used = d.get("usage")
                return True, f"Key valid{f' · ${used:.2f} used' if isinstance(used, (int, float)) else ''}"
        elif provider == "openai_compatible":
            await check_base_url(cfg.get("base_url", ""), config)
            r = await http.get(f"{cfg['base_url'].rstrip('/')}/models", headers={"Authorization": f"Bearer {secret}"}, timeout=15)
            if r.status_code == 200:
                return True, f"Endpoint reachable · {len(r.json().get('data', []))} models listed"
        elif provider == "tavily":
            r = await http.post("https://api.tavily.com/search", json={"query": "OSMSEA connectivity test", "max_results": 1},
                                headers={"Authorization": f"Bearer {secret}"}, timeout=20)
            if r.status_code == 200:
                return True, "Search request succeeded"
        elif provider == "brave_search":
            r = await http.get("https://api.search.brave.com/res/v1/web/search", params={"q": "OSMSEA", "count": 1},
                               headers={"X-Subscription-Token": secret, "Accept": "application/json"}, timeout=20)
            if r.status_code == 200:
                return True, "Search request succeeded"
        else:
            return False, "unknown provider"
        return False, f"HTTP {r.status_code}: {r.text[:160]}"
    except ToolError as e:
        return False, str(e)
    except httpx.HTTPError as e:
        return False, f"request failed: {type(e).__name__}"
