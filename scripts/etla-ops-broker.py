#!/usr/bin/env python3
"""Narrow privileged operations broker for the non-root Hermes gateway.

The broker accepts one bounded JSON request over a root-owned Unix socket. It
never evaluates shell text and every command/target is selected from a static
allowlist. Linux peer credentials and socket permissions restrict callers to
root and the dedicated ``hermes`` identity.
"""

from __future__ import annotations

import grp
import json
import logging
import os
import pwd
import socket
import struct
import subprocess
import time
from pathlib import Path
from typing import Any

SOCKET_PATH = Path("/run/etla-ops/broker.sock")
MAX_REQUEST_BYTES = 32_000
MAX_RESPONSE_BYTES = 128_000
ALLOWED_UNITS = frozenset(
    {
        "9router.service",
        "hermes-gateway.service",
        "nginx.service",
        "zenos-runtime.service",
    }
)
RUNTIME_DEPLOY = Path("/srv/etla/workspaces/zenos-runtime/scripts/install-control-plane-service.sh")
MAINTENANCE = Path("/usr/local/sbin/etla-maintenance")

logging.basicConfig(level=logging.INFO, format="%(levelname)s etla-ops-broker: %(message)s")
LOG = logging.getLogger("etla-ops-broker")


def _run(argv: list[str], *, timeout: int = 180, env: dict[str, str] | None = None) -> dict[str, Any]:
    completed = subprocess.run(
        argv,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        env=env,
    )
    output = completed.stdout[-MAX_RESPONSE_BYTES:]
    return {"ok": completed.returncode == 0, "exitCode": completed.returncode, "output": output}


def _unit(value: Any) -> str:
    unit = str(value or "").strip()
    if unit not in ALLOWED_UNITS:
        raise ValueError("unit is not allowlisted")
    return unit


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "").strip()
    if action == "status":
        return _run(["/usr/bin/systemctl", "--no-pager", "--full", "status", _unit(request.get("unit"))], timeout=30)
    if action == "restart":
        return _run(["/usr/bin/systemctl", "restart", _unit(request.get("unit"))], timeout=180)
    if action == "reload":
        return _run(["/usr/bin/systemctl", "reload", _unit(request.get("unit"))], timeout=90)
    if action == "logs":
        lines = max(20, min(int(request.get("lines") or 120), 500))
        return _run(
            ["/usr/bin/journalctl", "--no-pager", "-u", _unit(request.get("unit")), "-n", str(lines), "--output=short-iso"],
            timeout=30,
        )
    if action == "nginx-reload":
        tested = _run(["/usr/sbin/nginx", "-t"], timeout=30)
        if not tested["ok"]:
            return tested
        return _run(["/usr/bin/systemctl", "reload", "nginx.service"], timeout=60)
    if action == "deploy-runtime":
        if not RUNTIME_DEPLOY.is_file():
            raise ValueError("Runtime deployment script is unavailable")
        # The broker itself is intentionally restricted to AF_UNIX. Ask PID 1
        # to launch a separate transient service so cloud Memory smoke and
        # offsite backup gates retain network access without widening the
        # long-lived root broker's sandbox.
        unit = f"etla-runtime-deploy-{os.getpid()}-{time.time_ns()}.service"
        return _run(
            [
                "/usr/bin/systemd-run",
                "--wait",
                "--pipe",
                "--collect",
                f"--unit={unit}",
                "--property=WorkingDirectory=/srv/etla/workspaces/zenos-runtime",
                "--setenv=HOME=/root",
                "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "--setenv=ZENOS_DEPLOY_RESTART_HERMES=false",
                "--setenv=ZENOS_DEPLOY_RESTART_BROKER=false",
                "/bin/bash",
                str(RUNTIME_DEPLOY),
                str(RUNTIME_DEPLOY.parent.parent),
            ],
            timeout=1_200,
        )
    if action == "maintenance":
        if not MAINTENANCE.is_file():
            raise ValueError("maintenance command is unavailable")
        return _run([str(MAINTENANCE)], timeout=300)
    raise ValueError("action is not allowlisted")


def _allowed_uids() -> set[int]:
    uids = {0}
    try:
        uids.add(pwd.getpwnam("hermes").pw_uid)
    except KeyError:
        pass
    return uids


def serve() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    group = grp.getgrnam("hermes")
    os.chown(SOCKET_PATH, 0, group.gr_gid)
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(16)
    LOG.info("listening on %s", SOCKET_PATH)
    allowed_uids = _allowed_uids()
    while True:
        connection, _ = server.accept()
        with connection:
            try:
                pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid not in allowed_uids:
                    raise PermissionError("caller identity is not allowed")
                payload = bytearray()
                while len(payload) <= MAX_REQUEST_BYTES:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    payload.extend(chunk)
                    if b"\n" in chunk:
                        break
                if len(payload) > MAX_REQUEST_BYTES:
                    raise ValueError("request is too large")
                request = json.loads(bytes(payload).split(b"\n", 1)[0] or b"{}")
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                LOG.info("uid=%s pid=%s action=%s target=%s", uid, pid, request.get("action"), request.get("unit", ""))
                response = dispatch(request)
            except Exception as error:  # bounded protocol error response
                LOG.warning("request rejected: %s", error)
                response = {"ok": False, "exitCode": 1, "error": str(error), "output": ""}
            connection.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))


if __name__ == "__main__":
    serve()
