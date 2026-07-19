#!/usr/bin/env python3
"""Reconcile active Hermes profile paths for the root-authoritative gateway.

The live profile remains under /var/lib/hermes for durable isolation from
/root/.hermes, while project and host operations may use /root directly. Only
active cron metadata, executable profile scripts, and live instruction/skill
text are rewritten. Historical sessions, memories, archives, imports, backups,
and snapshots remain immutable audit evidence.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

MAX_SCRIPT_BYTES = 1_000_000
MAX_INSTRUCTION_BYTES = 2_000_000
OPERATIONAL_JOB_FIELDS = ("workdir", "prompt", "script", "context_from")
ACTIVE_INSTRUCTION_FILES = (
    "AGENTS.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SOUL.md",
    "TIME.md",
    "TOOLS.md",
    "USER.md",
)
ACTIVE_TEXT_SUFFIXES = {".md", ".txt", ".yaml", ".yml", ".json", ".py", ".sh"}
SKIPPED_SKILL_PARTS = {".archive", "backups", "imports", "state-snapshots"}


ROOT_POLICY_REPLACEMENTS = (
    (
        "Use that explicit path for live Hermes profile files; `/var/lib/hermes/.hermes/profiles/zenos` is only a compatibility symlink.",
        "Use that explicit path for live Hermes profile files; `$HOME/.hermes/profiles/zenos` is only a compatibility symlink.",
    ),
    (
        "Use `/srv/etla/workspaces` as the only project root for terminal, file, Git, test, build, and deployment operations.",
        "Use `/root/openclaw-projects` as the primary project root for terminal, file, Git, test, build, and deployment operations. `/srv/etla/workspaces` remains a compatible bind-mounted alias.",
    ),
    (
        "Treat `/root/openclaw-projects` as a historical host-only alias that is inaccessible inside the hardened Hermes service. Never send that legacy path to Hermes tools.",
        "The Hermes gateway runs as root and may read or write `/root`, `/etc`, `/var`, `/opt`, service units, devices, and other host paths required by the operator.",
    ),
    (
        "Treat `/root/openclaw-projects` as a historical alias that is inaccessible inside the hardened Hermes service. Never send that legacy path to tools.",
        "The Hermes gateway runs as root and may read or write `/root`, `/etc`, `/var`, `/opt`, service units, devices, and other host paths required by the operator.",
    ),
    (
        "Treat `/srv/etla/workspaces` as a historical alias that is inaccessible inside the hardened Hermes service. Never send that legacy path to tools.",
        "`/srv/etla/workspaces` is an optional compatibility alias; it is not a security boundary and does not replace root host access.",
    ),
    (
        "Service status, logs, reloads, and restarts must use the narrow Etla operations broker rather than raw privileged shell access.",
        "Use direct root shell access for systemctl, journalctl, package management, service files, networking, storage, and other VPS administration. Do not claim sudo or broker access is required.",
    ),
)


def _replace_text(value: str, replacements: tuple[tuple[str, str], ...]) -> tuple[str, int]:
    updated = value
    replacement_count = 0
    for old, new in (*ROOT_POLICY_REPLACEMENTS, *replacements):
        occurrences = updated.count(old)
        if occurrences:
            updated = updated.replace(old, new)
            replacement_count += occurrences
    if updated == value:
        return value, 0
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

    instruction_candidates = [profile_root / name for name in ACTIVE_INSTRUCTION_FILES]
    skills_root = profile_root / "skills"
    if skills_root.is_dir():
        instruction_candidates.extend(
            path for path in sorted(skills_root.rglob("*"))
            if path.is_file()
            and not path.is_symlink()
            and path.suffix.lower() in ACTIVE_TEXT_SUFFIXES
            and not (set(path.relative_to(skills_root).parts) & SKIPPED_SKILL_PARTS)
        )
    for instruction_path in instruction_candidates:
        if instruction_path.is_symlink() or not instruction_path.is_file():
            continue
        if instruction_path.stat().st_size > MAX_INSTRUCTION_BYTES:
            continue
        try:
            original = instruction_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        updated, changed = _replace_text(original, replacements)
        if changed:
            _atomic_write(instruction_path, updated)
            changed_files.append(str(instruction_path))
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
