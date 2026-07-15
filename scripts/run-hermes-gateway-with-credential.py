#!/usr/bin/env python3
"""Launch the Zenos Hermes gateway with its dedicated systemd credential."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values


def credential_environment(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise RuntimeError(f"Hermes credential file is missing: {path}")
    values: dict[str, str] = {}
    for key, value in dotenv_values(path).items():
        if value is None or not key or not key.replace("_", "A").isalnum() or key[0].isdigit():
            continue
        values[key] = value
    if not values:
        raise RuntimeError("Hermes credential file contained no valid environment values")
    return values


def credential_name() -> str:
    name = os.environ.get("HERMES_CREDENTIAL_NAME", "hermes-zenos.env").strip()
    if not name or name in {".", ".."} or Path(name).name != name:
        raise RuntimeError("Invalid Hermes credential name")
    return name


def main() -> None:
    directory = Path(os.environ.get("CREDENTIALS_DIRECTORY", ""))
    credential = directory / credential_name()
    environment = os.environ.copy()
    environment.update(credential_environment(credential))
    python = "/usr/local/lib/hermes-python/bin/python3.11"
    arguments = [python, "-m", "hermes_cli.main", "-p", "zenos", "gateway", "run", "--replace"]
    os.execve(python, arguments, environment)


if __name__ == "__main__":
    main()
