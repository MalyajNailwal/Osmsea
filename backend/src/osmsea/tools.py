"""Tool registry and controlled adapters.

Agents never get raw network, shell or filesystem access. Every tool:
- has a fixed Pydantic parameter schema, validated before it runs;
- runs only if it is in the task's effective tool set (see ``registry.effective_tools``);
- returns text that the executor wraps as untrusted data before the model sees it;
- reports *evidence* (what was actually retrieved) that verification checks citations against.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field


class ToolError(Exception):
    """Expected tool failure. The message is shown to the model and logged."""


@dataclass
class ToolContext:
    org_id: str
    db: Any  # store.Store
    http: httpx.AsyncClient
    secrets: dict[str, str]  # provider -> credential, resolved server-side, never shown to the model


@dataclass
class ToolResult:
    content: str
    evidence: list[dict[str, str]] = field(default_factory=list)  # [{"url", "title", "kind"}]


class _Params(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WebSearchParams(_Params):
    query: str = Field(min_length=1, max_length=300)
    max_results: int = Field(5, ge=1, le=10)


class FetchUrlParams(_Params):
    url: str = Field(min_length=8, max_length=2000)


class KnowledgeSearchParams(_Params):
    query: str = Field(min_length=1, max_length=300)
    limit: int = Field(5, ge=1, le=10)


class MemorySearchParams(_Params):
    query: str = Field(min_length=1, max_length=300)
    limit: int = Field(5, ge=1, le=10)


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    params: type[_Params]
    run: Callable[[ToolContext, Any], Awaitable[ToolResult]]
    integrations: tuple[str, ...] = ()  # at least one of these providers must be configured


MAX_FETCH_BYTES = 2_000_000
MAX_TOOL_TEXT = 12_000
ALLOWED_PORTS = {80, 443, 8080, 8443}
USER_AGENT = "OSMSEA-Agent/0.1 (+https://github.com/osmsea)"
TEXT_TYPES = ("text/html", "text/plain", "text/markdown", "application/json", "application/xml", "text/xml",
              "application/xhtml+xml", "application/rss+xml", "application/atom+xml")


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n…[truncated {len(text) - limit} chars]"


# --- fetch_url: SSRF-safe HTTP GET --------------------------------------------------------------


async def _resolve_public(host: str, port: int) -> str:
    """Resolve host and require every address to be publicly routable. Returns one address to pin."""
    lowered = host.lower().rstrip(".")
    if lowered == "localhost" or lowered.endswith((".localhost", ".local", ".internal", ".home.arpa")):
        raise ToolError(f"blocked host {host}")
    try:
        addrs = [str(ipaddress.ip_address(lowered.strip("[]")))]
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(lowered, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise ToolError(f"could not resolve {host}") from e
        addrs = list(dict.fromkeys(info[4][0] for info in infos))
    if not addrs:
        raise ToolError(f"could not resolve {host}")
    for addr in addrs:
        ip = ipaddress.ip_address(addr.split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise ToolError(f"blocked non-public address for {host}")
    return addrs[0]


async def safe_get(url: str, *, max_bytes: int = MAX_FETCH_BYTES, max_redirects: int = 3) -> tuple[str, int, str, bytes]:
    """GET a public URL. DNS is resolved once, checked, and pinned for the connection (no rebinding).

    Returns (final_url, status, content_type, body).
    """
    # No keep-alive: a pooled connection to a shared CDN IP must not be reused for another hostname.
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(15.0), trust_env=False, limits=httpx.Limits(max_keepalive_connections=0)
    ) as client:
        for _ in range(max_redirects + 1):
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https"):
                raise ToolError("only http(s) URLs are allowed")
            if parts.username or parts.password:
                raise ToolError("URLs with embedded credentials are not allowed")
            host = parts.hostname
            if not host:
                raise ToolError("URL has no host")
            port = parts.port or (443 if parts.scheme == "https" else 80)
            if port not in ALLOWED_PORTS:
                raise ToolError(f"port {port} is not allowed")
            ip = await _resolve_public(host, port)
            pinned_host = f"[{ip}]" if ":" in ip else ip
            netloc = pinned_host if parts.port is None else f"{pinned_host}:{parts.port}"
            pinned_url = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
            headers = {
                "Host": host if parts.port is None else f"{host}:{parts.port}",
                "User-Agent": USER_AGENT,
                "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
            }
            extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
            request = client.build_request("GET", pinned_url, headers=headers, extensions=extensions)
            try:
                response = await client.send(request, stream=True, follow_redirects=False)
            except httpx.HTTPError as e:
                raise ToolError(f"request failed: {type(e).__name__}") from e
            try:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ToolError("redirect without location")
                    url = urljoin(url, location)
                    continue
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > max_bytes:
                        break
                return url, response.status_code, response.headers.get("content-type", ""), bytes(body[:max_bytes])
            finally:
                await response.aclose()
    raise ToolError("too many redirects")


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "iframe"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "table"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    parser = _TextExtractor()
    parser.feed(html)
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(parser.parts))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return parser.title.strip(), text


async def _fetch_url(ctx: ToolContext, p: FetchUrlParams) -> ToolResult:
    final_url, status, content_type, body = await safe_get(p.url)
    if status >= 400:
        raise ToolError(f"HTTP {status} for {final_url}")
    mime = content_type.split(";")[0].strip().lower()
    if mime and not mime.startswith(TEXT_TYPES):
        raise ToolError(f"unsupported content type {mime}; only text documents can be read")
    raw = body.decode("utf-8", errors="replace")
    title, text = html_to_text(raw) if "html" in mime or raw.lstrip()[:15].lower().startswith(("<!doctype", "<html")) else ("", raw)
    evidence = [{"url": p.url, "title": title, "kind": "fetched"}]
    if final_url != p.url:
        evidence.append({"url": final_url, "title": title, "kind": "fetched"})
    return ToolResult(f"URL: {final_url}\nStatus: {status}\nTitle: {title}\n\n{clip(text, MAX_TOOL_TEXT)}", evidence)


# --- web_search ----------------------------------------------------------------------------------


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "")


async def _web_search(ctx: ToolContext, p: WebSearchParams) -> ToolResult:
    try:
        if key := ctx.secrets.get("tavily"):
            r = await ctx.http.post(
                "https://api.tavily.com/search",
                json={"query": p.query, "max_results": p.max_results, "search_depth": "basic"},
                headers={"Authorization": f"Bearer {key}"},
                timeout=20,
            )
            r.raise_for_status()
            hits = [(h.get("title", ""), h["url"], h.get("content", "")) for h in r.json().get("results", [])]
        elif key := ctx.secrets.get("brave_search"):
            r = await ctx.http.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": p.query, "count": p.max_results},
                headers={"X-Subscription-Token": key, "Accept": "application/json"},
                timeout=20,
            )
            r.raise_for_status()
            hits = [(_strip_tags(h.get("title", "")), h["url"], _strip_tags(h.get("description", "")))
                    for h in r.json().get("web", {}).get("results", [])]
        else:
            raise ToolError("no search provider is configured")
    except httpx.HTTPStatusError as e:
        raise ToolError(f"search provider returned HTTP {e.response.status_code}") from e
    except httpx.HTTPError as e:
        raise ToolError(f"search request failed: {type(e).__name__}") from e
    lines = [f"{i}. {t}\n   {u}\n   {clip(s, 400)}" for i, (t, u, s) in enumerate(hits, 1)]
    return ToolResult("\n".join(lines) or "No results.",
                      [{"url": u, "title": t, "kind": "search_result"} for t, u, _ in hits])


# --- memory_search -------------------------------------------------------------------------------


def or_query(text: str) -> str:
    """Turn free text into an OR full-text query: agents phrase queries loosely."""
    return " or ".join(re.findall(r"\w+", text)[:12])


async def _memory_search(ctx: ToolContext, p: MemorySearchParams) -> ToolResult:
    rows = await ctx.db.rpc("search_memory", {"p_org": ctx.org_id, "p_query": or_query(p.query), "p_limit": p.limit})
    if not rows:
        return ToolResult("No matching memory items.")
    lines, evidence = [], []
    for row in rows:
        src = (row.get("source") or {}).get("url", "")
        lines.append(f"[memory:{row['id']}] ({row['kind']}) {row['title']}\n{clip(row['content'], 1500)}"
                     + (f"\nsource: {src}" if src else ""))
        evidence.append({"url": f"memory:{row['id']}", "title": row["title"], "kind": "memory"})
        if src:
            evidence.append({"url": src, "title": row["title"], "kind": "memory"})
    return ToolResult("\n\n".join(lines), evidence)


async def _knowledge_search(ctx: ToolContext, p: KnowledgeSearchParams) -> ToolResult:
    rows = await ctx.db.rpc("search_documents", {"p_org": ctx.org_id, "p_query": or_query(p.query), "p_limit": p.limit})
    if not rows:
        return ToolResult("No matching passages in the knowledge base.")
    lines, evidence = [], []
    for r in rows:
        cite = f"doc:{r['document_id']}/{r['ordinal']}"
        label = r["title"] + (f", page {r['page']}" if r.get("page") else "")
        lines.append(f"[{cite}] {label}" + (f" · {r['heading']}" if r.get("heading") else "") + f"\n{clip(r['content'], 1500)}")
        evidence.append({"url": cite, "title": label, "kind": "document"})
    return ToolResult("\n\n".join(lines), evidence)


TOOLS: dict[str, ToolDef] = {
    t.name: t
    for t in (
        ToolDef(
            "web_search",
            "Search the public web. Returns titles, URLs and snippets. Requires a configured search integration.",
            WebSearchParams,
            _web_search,
            integrations=("tavily", "brave_search"),
        ),
        ToolDef(
            "fetch_url",
            "Fetch a public http(s) web page or text document and return its readable text. "
            "Private, local and internal network addresses are blocked.",
            FetchUrlParams,
            _fetch_url,
        ),
        ToolDef(
            "memory_search",
            "Search this organization's shared memory of verified findings, decisions and evidence.",
            MemorySearchParams,
            _memory_search,
        ),
        ToolDef(
            "knowledge_search",
            "Search the organization's knowledge base (uploaded documents and saved pages). Returns passages; "
            "cite them as doc:<document>/<passage>, exactly as shown.",
            KnowledgeSearchParams,
            _knowledge_search,
        ),
    )
}
