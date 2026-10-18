"""LLM provider adapters.

Runtime code depends only on ``LLMProvider.complete``. Messages use the OpenAI chat format, which
OpenRouter, OpenAI, Groq, Together, vLLM and Ollama all accept, so one HTTP adapter covers many
vendors. ``ScriptedProvider`` returns canned responses for deterministic tests.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)

Message = dict[str, Any]


class LLMError(Exception):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] | None
    raw_arguments: str = ""
    parse_error: str | None = None


@dataclass
class LLMResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    model: str = ""
    finish_reason: str = ""

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def assistant_message(self) -> Message:
        msg: Message = {"role": "assistant", "content": self.text or None}
        if self.tool_calls:
            msg["tool_calls"] = [
                {"id": c.id, "type": "function",
                 "function": {"name": c.name, "arguments": c.raw_arguments or json.dumps(c.arguments or {})}}
                for c in self.tool_calls
            ]
        return msg


class LLMProvider(Protocol):
    name: str
    model: str

    async def complete(self, messages: list[Message], tools: list[dict[str, Any]], *,
                       force_tool: str | None = None, max_tokens: int = 4096) -> LLMResponse: ...


def _parse_tool_call(raw: dict[str, Any]) -> ToolCall:
    fn = raw.get("function") or {}
    args_raw = fn.get("arguments") or "{}"
    try:
        args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
        if not isinstance(args, dict):
            return ToolCall(raw.get("id", ""), fn.get("name", ""), None, str(args_raw), "arguments must be a JSON object")
        return ToolCall(raw.get("id", ""), fn.get("name", ""), args, args_raw if isinstance(args_raw, str) else json.dumps(args))
    except json.JSONDecodeError as e:
        return ToolCall(raw.get("id", ""), fn.get("name", ""), None, str(args_raw), f"invalid JSON arguments: {e}")


class OpenAICompatProvider:
    """OpenAI-compatible chat completions (OpenRouter by default)."""

    def __init__(self, *, api_key: str, model: str, base_url: str = "https://openrouter.ai/api/v1",
                 name: str = "openrouter", http: httpx.AsyncClient | None = None, timeout: float = 180.0):
        self.name = name
        self.model = model
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._http = http
        self._timeout = timeout

    async def complete(self, messages: list[Message], tools: list[dict[str, Any]], *,
                       force_tool: str | None = None, max_tokens: int = 4096) -> LLMResponse:
        body: dict[str, Any] = {"model": self.model, "messages": messages, "max_tokens": max_tokens}
        if tools:
            body["tools"] = [{"type": "function", "function": t} for t in tools]
            body["tool_choice"] = {"type": "function", "function": {"name": force_tool}} if force_tool else "auto"
        headers = {"Authorization": f"Bearer {self._key}"}
        if self.name == "openrouter":
            body["usage"] = {"include": True}  # OpenRouter reports the actual cost of each call
            headers |= {"HTTP-Referer": "https://github.com/osmsea", "X-Title": "OSMSEA"}

        client = self._http or httpx.AsyncClient()
        try:
            r = await client.post(f"{self._base}/chat/completions", json=body, headers=headers, timeout=self._timeout)
        except httpx.TimeoutException as e:
            raise LLMError("model request timed out", retryable=True) from e
        except httpx.HTTPError as e:
            raise LLMError(f"model request failed: {type(e).__name__}", retryable=True) from e
        finally:
            if self._http is None:
                await client.aclose()

        if r.status_code >= 400:
            raise LLMError(f"{self.name} returned HTTP {r.status_code}: {_error_text(r)}",
                           retryable=r.status_code in (408, 409, 429) or r.status_code >= 500)
        data = r.json()
        if data.get("error"):  # OpenRouter may return 200 with an upstream error body
            code = data["error"].get("code")
            raise LLMError(f"{self.name} error: {data['error'].get('message', 'unknown')}",
                           retryable=not isinstance(code, int) or code in (408, 429) or code >= 500)
        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"{self.name} returned no choices", retryable=True)
        msg = choices[0].get("message") or {}
        usage = data.get("usage") or {}
        return LLMResponse(
            text=msg.get("content") or "",
            tool_calls=[_parse_tool_call(tc) for tc in msg.get("tool_calls") or []],
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
            cost_usd=float(usage["cost"]) if usage.get("cost") is not None else None,
            model=data.get("model") or self.model,
            finish_reason=choices[0].get("finish_reason") or "",
        )


def _error_text(r: httpx.Response) -> str:
    try:
        err = r.json().get("error")
        return (err.get("message") if isinstance(err, dict) else str(err))[:300]
    except ValueError:
        return r.text[:300]


async def complete_with_retry(provider: LLMProvider, messages: list[Message], tools: list[dict[str, Any]], *,
                              force_tool: str | None = None, attempts: int = 3, max_tokens: int = 4096) -> LLMResponse:
    """Retry transient provider failures (429/5xx/timeouts) with exponential backoff."""
    for attempt in range(attempts):
        try:
            return await provider.complete(messages, tools, force_tool=force_tool, max_tokens=max_tokens)
        except LLMError as e:
            if not e.retryable or attempt + 1 == attempts:
                raise
            delay = 2 ** attempt
            log.warning("transient model error (%s); retrying in %ss", e, delay)
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


# --- Tests ---------------------------------------------------------------------------------------

Step = LLMResponse | Exception | Callable[[list[Message], list[dict[str, Any]]], LLMResponse]


class ScriptedProvider:
    """Deterministic provider. Each call consumes the next script step; a callable step can route by
    inspecting messages/tools (useful when several tasks run concurrently)."""

    def __init__(self, script: list[Step] | Callable[[list[Message], list[dict[str, Any]]], LLMResponse],
                 model: str = "scripted-model"):
        self.name = "scripted"
        self.model = model
        self.script = script
        self.calls: list[dict[str, Any]] = []

    async def complete(self, messages: list[Message], tools: list[dict[str, Any]], *,
                       force_tool: str | None = None, max_tokens: int = 4096) -> LLMResponse:
        self.calls.append({"messages": messages, "tools": tools, "force_tool": force_tool})
        if callable(self.script):
            step: Step = self.script
        elif not self.script:
            raise LLMError("scripted provider exhausted", retryable=False)
        else:
            step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        if callable(step):
            step = step(messages, tools)
        if inspect.isawaitable(step):  # async steps model slow calls (timeouts, cancellation)
            step = await step
        if isinstance(step, Exception):
            raise step
        return step


_call_ids = iter(range(1, 1_000_000))


def tool_reply(name: str, args: dict[str, Any], *, text: str = "", tokens: int = 100) -> LLMResponse:
    """Build a response containing one tool call (test helper)."""
    return LLMResponse(text=text, tool_calls=[ToolCall(f"call_{next(_call_ids)}", name, args, json.dumps(args))],
                       input_tokens=tokens, output_tokens=tokens // 2, model="scripted-model", finish_reason="tool_calls")
