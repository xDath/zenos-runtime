#!/usr/bin/env python3
"""Migrate active Hermes profile paths into the non-root runtime layout.

Only active cron metadata and executable profile scripts are rewritten. Historical
sessions, memories, archives, and snapshots remain immutable audit evidence.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

MAX_SCRIPT_BYTES = 1_000_000
OPERATIONAL_JOB_FIELDS = ("workdir", "prompt", "script", "context_from")


def _replace_text(value: str, replacements: tuple[tuple[str, str], ...]) -> tuple[str, int]:
    updated = value
    replacement_count = 0
    for old, new in replacements:
        occurrences = updated.count(old)
        if occurrences:
            updated = updated.replace(old, new)
            replacement_count += occurrences
    return updated, replacement_count


def _migrate_active_jobs(payload: Any, replacements: tuple[tuple[str, str], ...]) -> int:
    if isinstance(payload, dict):
        jobs = payload.get("jobs", [])
    elif isinstance(payload, list):
        jobs = payload
    else:
        jobs = []
    if not isinstance(jobs, list):
        return 0

    replacement_count = 0
    for job in jobs:
        if not isinstance(job, dict):
            continue
        for field in OPERATIONAL_JOB_FIELDS:
            value = job.get(field)
            if not isinstance(value, str):
                continue
            updated, changed = _replace_text(value, replacements)
            if changed:
                job[field] = updated
                replacement_count += changed
    return replacement_count


def _atomic_write(path: Path, content: str) -> None:
    metadata = path.stat()
    temporary = path.with_name(f".{path.name}.migration-{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        if os.geteuid() == 0:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def migrate_profile(profile_root: Path) -> dict[str, Any]:
    profile_root = profile_root.resolve()
    if not profile_root.is_dir():
        raise FileNotFoundError(f"Hermes profile does not exist: {profile_root}")

    replacements = (
        ("/root/.hermes/profiles/zenos", str(profile_root)),
        ("/root/.hermes/scripts", str(profile_root / "scripts")),
        ("/root/openclaw-projects", "/srv/etla/workspaces"),
    )
    changed_files: list[str] = []
    replaced_values = 0

    jobs_path = profile_root / "cron" / "jobs.json"
    if jobs_path.is_file():
        payload = json.loads(jobs_path.read_text(encoding="utf-8"))
        changed = _migrate_active_jobs(payload, replacements)
        if changed:
            _atomic_write(jobs_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            changed_files.append(str(jobs_path))
            replaced_values += changed

    scripts_root = profile_root / "scripts"
    if scripts_root.is_dir():
        for script_path in sorted(scripts_root.rglob("*")):
            if script_path.is_symlink() or not script_path.is_file():
                continue
            if script_path.stat().st_size > MAX_SCRIPT_BYTES:
                continue
            try:
                original = script_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            updated, changed = _replace_text(original, replacements)
            if changed:
                _atomic_write(script_path, updated)
                changed_files.append(str(script_path))
                replaced_values += changed

    return {
        "ok": True,
        "profileRoot": str(profile_root),
        "changedFiles": changed_files,
        "changedFileCount": len(changed_files),
        "replacementCount": replaced_values,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: migrate-hermes-runtime-paths.py <profile-root>", file=sys.stderr)
        return 2
    try:
        result = migrate_profile(Path(sys.argv[1]))
    except Exception as error:
        print(f"Hermes runtime path migration failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
