"""Run agent-proposed code in a locked-down Docker container, as part of verification.

Nothing from the host is mounted: files go in as a tar stream on stdin and are unpacked into a tmpfs.
The container has no network, a read-only root filesystem, no capabilities, an unprivileged user and
memory/CPU/process/time limits. Build the image once with ``docker build -t osmsea-sandbox sandbox/``.

ponytail: containers share the host kernel. Good for local and self-hosted use; for a public
multi-tenant deployment, run the same command through a microVM sandbox (gVisor, Firecracker, E2B).
"""

from __future__ import annotations

import asyncio
import io
import os
import tarfile
import time
import uuid
from dataclasses import dataclass

IMAGE = os.environ.get("OSMSEA_SANDBOX_IMAGE", "osmsea-sandbox:latest")
TIMEOUT_SECONDS = int(os.environ.get("OSMSEA_SANDBOX_TIMEOUT", "60"))
OUTPUT_LIMIT = 6000


class SandboxUnavailable(Exception):
    """Docker or the sandbox image is missing: an infrastructure problem, not the agent's fault."""


@dataclass
class SandboxResult:
    exit_code: int
    output: str  # combined stdout/stderr tail; produced by agent code, so untrusted
    duration_ms: int
    timed_out: bool = False

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


def _tar(files: list[tuple[str, str]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for path, content in files:
            data = content.encode()
            info = tarfile.TarInfo(path)
            info.size, info.mode = len(data), 0o644
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def docker_args(name: str, command: str, image: str = IMAGE) -> list[str]:
    return [
        "docker", "run", "--rm", "-i", "--name", name, "--pull", "never",
        "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65534:65534", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "128",
        "--tmpfs", "/work:rw,exec,nosuid,size=64m,mode=1777", "--tmpfs", "/tmp:rw,exec,nosuid,size=64m,mode=1777",
        "-e", "HOME=/tmp", "-e", "PYTHONDONTWRITEBYTECODE=1", "-w", "/work",
        image, "sh", "-c", 'tar -x -C /work && exec sh -c "$0"', command,
    ]


async def run(files: list[tuple[str, str]], command: str, *, timeout: int = TIMEOUT_SECONDS) -> SandboxResult:
    name = f"osmsea-sbx-{uuid.uuid4().hex[:12]}"
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(*docker_args(name, command), stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    except FileNotFoundError as e:
        raise SandboxUnavailable("docker is not installed on the OSMSEA server") from e
    try:
        out, _ = await asyncio.wait_for(proc.communicate(_tar(files)), timeout)
        timed_out = False
    except TimeoutError:
        kill = await asyncio.create_subprocess_exec("docker", "kill", name, stdout=asyncio.subprocess.DEVNULL,
                                                    stderr=asyncio.subprocess.DEVNULL)
        await kill.wait()
        out, _ = await proc.communicate()
        timed_out = True
    text = out.decode(errors="replace")
    if proc.returncode == 125 and not timed_out:  # `docker run` itself failed: daemon down, image missing, ...
        raise SandboxUnavailable(f"could not start the sandbox ({text.strip()[:300]}). "
                                 f"Build the image with: docker build -t {IMAGE} sandbox/")
    return SandboxResult(exit_code=proc.returncode or 0, output=text[-OUTPUT_LIMIT:],
                         duration_ms=int((time.monotonic() - started) * 1000), timed_out=timed_out)


async def status() -> dict[str, object]:
    """Whether code can be executed: docker reachable and the sandbox image present."""
    try:
        proc = await asyncio.create_subprocess_exec("docker", "image", "inspect", "--format", "{{.Id}}", IMAGE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), 10)
    except FileNotFoundError:
        return {"available": False, "image": IMAGE, "detail": "docker is not installed"}
    except TimeoutError:
        return {"available": False, "image": IMAGE, "detail": "docker did not respond"}
    if proc.returncode != 0:
        msg = err.decode(errors="replace").strip()
        detail = "docker daemon is not running" if "daemon" in msg.lower() else f"image missing: docker build -t {IMAGE} sandbox/"
        return {"available": False, "image": IMAGE, "detail": detail}
    return {"available": True, "image": IMAGE, "detail": "ready"}
