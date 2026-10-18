import pytest

from osmsea.schemas import CodeChange
from osmsea.specs import parse_agent_markdown
from osmsea.tools import ToolError, _resolve_public, html_to_text, or_query, safe_get
from osmsea.verify import deterministic_checks, normalize_url

from conftest import ORG_DIR


@pytest.mark.parametrize("host", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254",
                                  "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "::ffff:127.0.0.1", "localhost",
                                  "metadata.google.internal", "printer.local"])
async def test_private_and_metadata_addresses_are_blocked(host):
    with pytest.raises(ToolError, match="blocked"):
        await _resolve_public(host, 80)


async def test_public_address_is_allowed():
    assert await _resolve_public("1.1.1.1", 443) == "1.1.1.1"


@pytest.mark.parametrize("url, message", [
    ("file:///etc/passwd", "only http"),
    ("ftp://example.com/x", "only http"),
    ("http://user:pass@example.com/", "credentials"),
    ("http://1.1.1.1:22/", "port 22"),
    ("http://127.0.0.1/admin", "blocked"),
    ("http://[::1]:8080/", "blocked"),
])
async def test_safe_get_rejects_unsafe_urls(url, message):
    with pytest.raises(ToolError, match=message):
        await safe_get(url)


def test_html_to_text_drops_scripts_and_keeps_title():
    title, text = html_to_text("<html><head><title>Docs</title><style>x{}</style></head>"
                               "<body><script>steal()</script><h1>Hello</h1><p>World &amp; more</p></body></html>")
    assert title == "Docs"
    assert "steal" not in text and "Hello" in text and "World & more" in text


def test_or_query_and_url_normalization():
    assert or_query("httpx vs requests, async!") == "httpx or vs or requests or async"
    assert normalize_url("HTTPS://Example.com/a/#frag") == normalize_url("https://example.com/a")
    assert normalize_url("memory:abc") == "memory:abc"


def test_syntax_check_rejects_unparseable_files():
    spec = parse_agent_markdown((ORG_DIR / "departments/engineering/agents/developer.md").read_text())
    output = CodeChange(summary="A change that does not parse at all.", test_plan=["run it"], files=[
        {"path": "bad.py", "language": "python", "action": "create", "content": "def broken(:\n"},
        {"path": "ok.json", "language": "json", "action": "create", "content": '{"a": 1}'},
    ])
    checks = {c["name"]: c for c in deterministic_checks(spec, output, [])}
    assert checks["syntax"]["passed"] is False and "bad.py" in checks["syntax"]["detail"]
    assert "ok.json" not in checks["syntax"]["detail"]
