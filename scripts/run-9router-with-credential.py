#!/usr/bin/env python3
"""Load the encrypted 9Router credential and exec the standalone server."""

from __future__ import annotations

import os
from pathlib import Path


def load_environment(path: Path) -> None:
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key and key.replace("_", "").isalnum():
            os.environ[key] = value


def main() -> None:
    directory = Path(os.environ.get("CREDENTIALS_DIRECTORY", ""))
    credential = directory / "9router.env"
    if not credential.is_file():
        raise SystemExit("9Router encrypted credential is unavailable")
    load_environment(credential)
    os.execv("/usr/bin/node", ["/usr/bin/node", "/opt/9router/.next/standalone/server.js"])


if __name__ == "__main__":
    main()
