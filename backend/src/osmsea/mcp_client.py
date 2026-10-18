"""MCP (Model Context Protocol) client adapter over Streamable HTTP.

Organizations register remote MCP servers; the backend discovers their tools and an admin approves
individual tools. Approved tools are exposed to agents as ``mcp__<server-slug>__<tool>`` and go
through the same controls as built-in tools: per-task allow-list, argument validation, timeouts,
output clipping, untrusted-output fencing and auditing. Credentials are injected here, server-side.

Each call opens a short-lived session (initialize → request → close). ponytail: one session per
call adds a round trip; pool sessions per execution if MCP latency matters.
"""

from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx2
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client

from .tools import ToolError, _resolve_public, clip

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,23}$")
TOOL_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
NAME_RE = re.compile(r"^mcp__([a-z][a-z0-9-]{1,23})__([A-Za-z0-9_-]{1,48})$")
MAX_NAME = 64  # OpenAI-compatible function names allow at most 64 characters
LIST_TIMEOUT = 30.0
CALL_TIMEOUT = 60.0
MAX_ARGS_BYTES = 20_000
MAX_RESULT_CHARS = 12_000


class McpError(Exception):
    """Expected MCP failure (unreachable server, protocol error, tool error). Message is user-facing."""


@dataclass(frozen=True)
class McpTool:
    name: str
    description: str
    input_schema: dict[str, Any]


def tool_name(slug: str, tool: str) -> str:
    return f"mcp__{slug}__{tool}"


def parse_tool_name(name: str) -> tuple[str, str] | None:
    m = NAME_RE.match(name)
    return (m.group(1), m.group(2)) if m and len(name) <= MAX_NAME else None


def approvable(slug: str, tool: str) -> bool:
    """A discovered tool can be approved only if its OSMSEA name is a valid function name."""
    return bool(TOOL_RE.match(tool)) and len(tool_name(slug, tool)) <= MAX_NAME


def auth_headers(header: str, secret: str | None) -> dict[str, str]:
    if not secret:
        return {}
    if header.lower() == "authorization" and not secret.lower().startswith(("bearer ", "basic ")):
        return {header: f"Bearer {secret}"}
    return {header: secret}


async def check_url(url: str, allow_private: bool) -> None:
    """Admin-supplied MCP URLs must be public https endpoints unless private URLs are allowed (dev)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise McpError("MCP server URL must be an http(s) URL")
    if allow_private:
        return
    if parts.scheme != "https":
        raise McpError("MCP server URL must use https")
    try:
        # ponytail: resolved at check time only; the SDK owns the connection. Pin DNS with a custom
        # httpx2 transport if MCP URLs come from untrusted admins.
        await _resolve_public(parts.hostname, parts.port or 443)
    except ToolError as e:
        raise McpError(str(e)) from e


def _root(exc: BaseException, seen: dict[str, int]) -> str:
    """Unwrap anyio exception groups; prefer the HTTP status the SDK does not surface."""
    status = seen.get("status")
    if status in (401, 403):
        return f"authentication failed (HTTP {status}); check the credential and auth header"
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    msg = clip((str(exc) or type(exc).__name__).replace("\n", " "), 300)
    return f"HTTP {status}: {msg}" if status else msg


@asynccontextmanager
async def _session(url: str, headers: dict[str, str], seen: dict[str, int]):
    async def record(response: httpx2.Response) -> None:
        if response.status_code >= 400:
            seen["status"] = response.status_code

    async with httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(CALL_TIMEOUT), trust_env=False,
                                  event_hooks={"response": [record]}) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                yield session, await session.initialize()


async def list_tools(url: str, headers: dict[str, str]) -> tuple[dict[str, str], list[McpTool]]:
    seen: dict[str, int] = {}

    async def run() -> tuple[dict[str, str], list[McpTool]]:
        async with _session(url, headers, seen) as (session, init):
            tools: list[McpTool] = []
            cursor = None
            for _ in range(20):  # pagination guard
                page = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor) if cursor else None)
                tools += [McpTool(t.name, (t.description or "")[:2000], dict(t.input_schema or {})) for t in page.tools]
                cursor = getattr(page, "next_cursor", None)
                if not cursor:
                    break
            info = {"name": init.server_info.name, "version": init.server_info.version or "",
                    "protocol": str(init.protocol_version)}
            return info, tools

    try:
        return await asyncio.wait_for(run(), LIST_TIMEOUT)
    except TimeoutError as e:
        raise McpError(f"MCP server did not respond within {LIST_TIMEOUT:.0f}s") from e
    except McpError:
        raise
    except BaseException as e:  # SDK/transport errors arrive as exception groups
        if isinstance(e, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
            raise
        raise McpError(f"could not reach MCP server: {_root(e, seen)}") from e


def result_text(result: Any) -> str:
    parts: list[str] = []
    for item in getattr(result, "content", None) or []:
        kind = getattr(item, "type", "")
        if kind == "text":
            parts.append(item.text)
        elif kind == "resource" and getattr(getattr(item, "resource", None), "text", None):
            parts.append(item.resource.text)
        else:
            parts.append(f"[{kind or 'non-text'} content omitted]")
    structured = getattr(result, "structured_content", None)
    if not parts and structured is not None:
        parts.append(json.dumps(structured, indent=1, default=str))
    return clip("\n".join(parts) or "(empty result)", MAX_RESULT_CHARS)


async def call_tool(url: str, headers: dict[str, str], tool: str, arguments: dict[str, Any],
                    timeout: float = CALL_TIMEOUT) -> str:
    if len(json.dumps(arguments, default=str)) > MAX_ARGS_BYTES:
        raise McpError(f"arguments exceed {MAX_ARGS_BYTES} bytes")
    seen: dict[str, int] = {}

    async def run() -> str:
        async with _session(url, headers, seen) as (session, _):
            result = await session.call_tool(tool, arguments, read_timeout_seconds=timeout)
            text = result_text(result)
            if getattr(result, "is_error", False):
                raise McpError(f"tool returned an error: {clip(text, 500)}")
            return text

    try:
        return await asyncio.wait_for(run(), timeout + 10)
    except TimeoutError as e:
        raise McpError(f"MCP tool timed out after {timeout:.0f}s") from e
    except McpError:
        raise
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
            raise
        raise McpError(f"MCP call failed: {_root(e, seen)}") from e


def validate_arguments(schema: dict[str, Any], arguments: Any) -> str | None:
    """Return a validation error message, or None. Malformed third-party schemas are not fatal."""
    if not isinstance(arguments, dict):
        return "arguments must be a JSON object"
    try:
        from jsonschema import exceptions, validators

        cls = validators.validator_for(schema)
        cls.check_schema(schema)
        error = next(iter(cls(schema).iter_errors(arguments)), None)
        return f"{'.'.join(map(str, error.absolute_path)) or 'arguments'}: {error.message[:200]}" if error else None
    except exceptions.SchemaError:
        return None


def tool_parameters(schema: dict[str, Any]) -> dict[str, Any]:
    """Tool input schema as function parameters (providers require an object schema)."""
    if isinstance(schema, dict) and schema.get("type") == "object":
        return schema
    return {"type": "object", "properties": {}}
