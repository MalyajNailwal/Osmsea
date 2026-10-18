"""Server configuration from environment variables (load a .env with `uvicorn --env-file .env`)."""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parents[3]


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


class Config(BaseModel):
    supabase_url: str
    supabase_secret_key: str  # service role / sb_secret_* — backend only, never sent to clients
    supabase_publishable_key: str  # used to validate user sessions against Supabase Auth
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    llm_api_key: str | None = None  # optional server-wide fallback when an org has no LLM integration
    llm_base_url: str = "https://openrouter.ai/api/v1"
    default_model: str = "anthropic/claude-sonnet-5"
    worker_enabled: bool = True
    worker_concurrency: int = 4
    poll_interval: float = 1.0
    lease_seconds: int = 60
    allow_private_llm_urls: bool = False  # permit e.g. a local Ollama base URL (development only)
    allow_private_mcp_urls: bool = False  # permit http/localhost MCP servers (development and tests only)
    template_dir: Path = REPO_ROOT / "organization"

    @classmethod
    def from_env(cls) -> Config:
        env = os.environ
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY") if not env.get(k)]
        if missing:
            raise RuntimeError(f"missing environment variables: {', '.join(missing)}")
        return cls(
            supabase_url=env["SUPABASE_URL"],
            supabase_secret_key=env["SUPABASE_SECRET_KEY"],
            supabase_publishable_key=env["SUPABASE_PUBLISHABLE_KEY"],
            cors_origins=[o.strip() for o in env.get("OSMSEA_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
            llm_api_key=env.get("OPENROUTER_API_KEY") or None,
            llm_base_url=env.get("OSMSEA_LLM_BASE_URL", "https://openrouter.ai/api/v1"),
            default_model=env.get("OSMSEA_DEFAULT_MODEL", "anthropic/claude-sonnet-5"),
            worker_enabled=_bool("OSMSEA_WORKER_ENABLED", True),
            worker_concurrency=int(env.get("OSMSEA_WORKER_CONCURRENCY", "4")),
            poll_interval=float(env.get("OSMSEA_POLL_INTERVAL", "1.0")),
            lease_seconds=int(env.get("OSMSEA_LEASE_SECONDS", "60")),
            allow_private_llm_urls=_bool("OSMSEA_ALLOW_PRIVATE_LLM_URLS", False),
            allow_private_mcp_urls=_bool("OSMSEA_ALLOW_PRIVATE_MCP_URLS", False),
        )
