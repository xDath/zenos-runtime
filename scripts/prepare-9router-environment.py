#!/usr/bin/env python3
"""Normalize a legacy 9Router env file for the hardened system service."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def parse(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if match:
            result[match.group(1)] = match.group(2).strip()
    return result


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prepare-9router-environment.py INPUT OUTPUT")
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    values = parse(source)
    if not values:
        raise SystemExit("No 9Router environment values were found")
    values.update({
        "DATA_DIR": "/var/lib/9router",
        "PORT": "20128",
        "HOSTNAME": "127.0.0.1",
        "NODE_ENV": "production",
    })
    destination.write_text(
        "".join(f"{key}={value}\n" for key, value in sorted(values.items())),
        encoding="utf-8",
    )
    destination.chmod(0o600)


if __name__ == "__main__":
    main()
