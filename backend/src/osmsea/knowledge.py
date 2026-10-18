"""Knowledge base: organization documents split into passages and full-text indexed.

Agents find passages with the `knowledge_search` tool and cite them as `doc:<document>/<passage>`; the
citation check accepts only passages actually returned in that execution. Passages never span pages, so a
PDF citation names the exact page. Only the extracted text is stored, not the original file.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
from typing import Any

import pypdf

from .orgs import Actor, NotFound
from .planner import Conflict
from .specs import SpecError
from .store import StoreError, record_audit
from .tools import TEXT_TYPES, ToolError, html_to_text, or_query, safe_get

MAX_BYTES = 10 * 1024 * 1024
MAX_CHUNKS = 5000
CHUNK_CHARS = 1200
EXTENSIONS = (".pdf", ".txt", ".md", ".markdown", ".csv", ".html", ".htm", ".json", ".yaml", ".yml", ".py", ".ts", ".tsx", ".js")


def extract(filename: str, data: bytes) -> list[tuple[int | None, str]]:
    """(page, text) pairs. PDFs keep page numbers; other formats are one page."""
    name = filename.lower()
    if name.endswith(".pdf"):
        try:
            reader = pypdf.PdfReader(io.BytesIO(data))
            if reader.is_encrypted and not reader.decrypt(""):
                raise SpecError(["the PDF is password protected"])
            return [(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
        except pypdf.errors.PdfReadError as e:
            raise SpecError([f"could not read the PDF: {e}"]) from e
    text = data.decode("utf-8", errors="replace")
    if name.endswith((".html", ".htm")):
        text = html_to_text(text)[1]
    return [(None, text)]


def chunk(pages: list[tuple[int | None, str]], markdown: bool = False) -> list[dict[str, Any]]:
    """Paragraph-packed passages of up to ~CHUNK_CHARS, never spanning pages; Markdown headings are carried along."""
    out: list[dict[str, Any]] = []
    heading = None
    for page, text in pages:
        buf: list[str] = []

        def flush() -> None:
            if buf:
                out.append({"page": page, "heading": heading, "content": "\n\n".join(buf)})
                buf.clear()

        for para in (p.strip() for p in re.split(r"\n\s*\n", text)):
            if not para:
                continue
            if markdown and para.startswith("#"):
                flush()
                heading = para.splitlines()[0].lstrip("#").strip()[:200] or heading
            while len(para) > CHUNK_CHARS:  # one huge paragraph: split at a space near the limit
                cut = para.rfind(" ", 0, CHUNK_CHARS)
                cut = cut if cut > CHUNK_CHARS // 2 else CHUNK_CHARS
                flush()
                out.append({"page": page, "heading": heading, "content": para[:cut].strip()})
                para = para[cut:].strip()
            if buf and sum(len(b) for b in buf) + len(para) > CHUNK_CHARS:
                flush()
            buf.append(para)
        flush()
    return out


async def add(db: Any, org_id: str, actor: Actor, *, title: str, source: str, pages: list[tuple[int | None, str]],
              raw: bytes, filename: str | None = None, mime: str | None = None, source_url: str | None = None) -> dict[str, Any]:
    digest = hashlib.sha256(raw).hexdigest()
    if existing := await db.select("documents", filters={"org_id": org_id, "sha256": digest}):
        raise Conflict(f"this content is already in the knowledge base as “{existing[0]['title']}”")
    chunks = chunk(pages, markdown=bool(filename and filename.lower().endswith((".md", ".markdown"))))
    if not chunks:
        raise SpecError(["no text could be extracted (a scanned PDF needs OCR first)"])
    if len(chunks) > MAX_CHUNKS:
        raise SpecError([f"the document is too large ({len(chunks)} passages; the limit is {MAX_CHUNKS})"])
    try:
        doc = (await db.insert("documents", {
            "org_id": org_id, "title": title.strip()[:300] or "Untitled", "source": source, "source_url": source_url,
            "filename": filename, "mime": mime, "bytes": len(raw), "sha256": digest,
            "pages": len(pages) if filename and filename.lower().endswith(".pdf") else None,
            "chunks": len(chunks), "created_by": actor.id,
        }))[0]
    except StoreError as e:
        if e.code == "23505":
            raise Conflict("this content was just added to the knowledge base") from e
        raise
    try:
        for i in range(0, len(chunks), 500):
            await db.insert("document_chunks", [{"org_id": org_id, "document_id": doc["id"], "ordinal": i + n, **c}
                                                for n, c in enumerate(chunks[i:i + 500])])
    except Exception:
        await db.delete("document_chunks", filters={"document_id": doc["id"]})  # no half-indexed documents
        await db.delete("documents", filters={"id": doc["id"]})
        raise
    await record_audit(db, org_id, "knowledge.add", "document", actor_id=actor.id, actor_label=actor.email,
                       resource_id=doc["id"], resource_name=doc["title"], details={"source": source, "passages": len(chunks)})
    return doc


async def add_upload(db: Any, org_id: str, actor: Actor, *, filename: str, data: bytes, mime: str | None,
                     title: str | None = None) -> dict[str, Any]:
    if not filename.lower().endswith(EXTENSIONS):
        raise SpecError([f"unsupported file type; supported: {', '.join(EXTENSIONS)}"])
    if len(data) > MAX_BYTES:
        raise SpecError([f"files are limited to {MAX_BYTES // (1024 * 1024)} MB"])
    pages = await asyncio.to_thread(extract, filename, data)  # PDF parsing is CPU-bound
    return await add(db, org_id, actor, title=title or filename, source="upload", pages=pages, raw=data,
                     filename=filename, mime=mime)


async def add_url(db: Any, org_id: str, actor: Actor, url: str, title: str | None = None) -> dict[str, Any]:
    try:
        final_url, status, content_type, body = await safe_get(url)  # SSRF-safe: public addresses only, DNS pinned
    except ToolError as e:
        raise SpecError([str(e)]) from e
    mime = content_type.split(";")[0].strip().lower()
    if status >= 400 or (mime and not mime.startswith(TEXT_TYPES)):
        raise SpecError([f"could not read {final_url}: HTTP {status} {mime}".strip()])
    raw = body.decode("utf-8", errors="replace")
    page_title, text = html_to_text(raw) if "html" in mime else ("", raw)
    return await add(db, org_id, actor, title=title or page_title or final_url, source="url", pages=[(None, text)],
                     raw=body, mime=mime, source_url=final_url)


async def delete(db: Any, org_id: str, document_id: str, actor: Actor) -> None:
    docs = await db.select("documents", filters={"id": document_id, "org_id": org_id})
    if not docs:
        raise NotFound("document not found")
    await db.delete("document_chunks", filters={"document_id": document_id, "org_id": org_id})
    await db.delete("documents", filters={"id": document_id, "org_id": org_id})
    await record_audit(db, org_id, "knowledge.delete", "document", actor_id=actor.id, actor_label=actor.email,
                       resource_id=document_id, resource_name=docs[0]["title"])


async def search(db: Any, org_id: str, query: str, limit: int = 8) -> list[dict[str, Any]]:
    return await db.rpc("search_documents", {"p_org": org_id, "p_query": or_query(query), "p_limit": limit}) or []
