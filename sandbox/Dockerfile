# OSMSEA code sandbox: where verification runs agent-proposed tests (no network at run time).
# Build: docker build -t osmsea-sandbox sandbox/
FROM python:3.12-slim

# Preinstalled because containers run with --network none: test tooling plus the libraries agents use most.
RUN pip install --no-cache-dir "pytest>=8,<9" "pytest-asyncio>=0.24" "httpx>=0.28" "respx>=0.22" \
        "requests>=2.32" "pydantic>=2.9" "pyyaml>=6" \
    && rm -rf /root/.cache

USER 65534:65534
WORKDIR /work
