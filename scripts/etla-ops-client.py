#!/usr/bin/env python3
"""Client for the narrow Etla privileged operations broker."""

from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path

SOCKET_PATH = Path("/run/etla-ops/broker.sock")
MAX_RESPONSE_BYTES = 256_000


def request(payload: dict) -> dict:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(920)
    client.connect(str(SOCKET_PATH))
    with client:
        client.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        response = bytearray()
        while len(response) <= MAX_RESPONSE_BYTES:
            chunk = client.recv(8192)
            if not chunk:
                break
            response.extend(chunk)
            if b"\n" in chunk:
                break
    if len(response) > MAX_RESPONSE_BYTES:
        raise RuntimeError("broker response exceeded safety limit")
    parsed = json.loads(bytes(response).split(b"\n", 1)[0] or b"{}")
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid broker response")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(prog="etla-ops")
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("status", "restart", "reload"):
        command = sub.add_parser(name)
        command.add_argument("unit")
    logs = sub.add_parser("logs")
    logs.add_argument("unit")
    logs.add_argument("--lines", type=int, default=120)
    logs.add_argument("--since")
    sub.add_parser("nginx-reload")
    sub.add_parser("deploy-runtime")
    sub.add_parser("maintenance")
    args = parser.parse_args()
    payload = {"action": args.action}
    if hasattr(args, "unit"):
        payload["unit"] = args.unit
    if hasattr(args, "lines"):
        payload["lines"] = args.lines
    if hasattr(args, "since") and args.since:
        payload["since"] = args.since
    try:
        result = request(payload)
    except Exception as error:
        print(f"etla-ops: {error}", file=sys.stderr)
        return 1
    output = str(result.get("output") or "")
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    error = str(result.get("error") or "")
    if error:
        print(f"etla-ops: {error}", file=sys.stderr)
    return 0 if result.get("ok") else int(result.get("exitCode") or 1)


if __name__ == "__main__":
    raise SystemExit(main())
