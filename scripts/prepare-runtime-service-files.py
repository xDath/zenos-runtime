#!/usr/bin/env python3
"""Prepare a merged environment bundle and an allowlisted Runtime config."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip()
    return values


def runtime_provider(source: Path) -> tuple[str, dict]:
    if not source.is_file():
        return "etla-router", {}
    data = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    provider_name = str(model.get("provider") or "etla-router").replace("custom:", "")
    providers = data.get("providers") if isinstance(data.get("providers"), dict) else {}
    provider = providers.get(provider_name) if isinstance(providers.get(provider_name), dict) else {}
    return provider_name, provider


def prepare_environment(destination: Path, sources: list[Path], config_source: Path) -> None:
    values: dict[str, str] = {}
    for source in sources:
        for key, value in parse_env(source).items():
            current = values.get(key, '').strip().strip('"\'')
            candidate = value.strip().strip('"\'')
            if key not in values or (not current and candidate):
                values[key] = value
    _, provider = runtime_provider(config_source)
    provider_credential = str(provider.get("api_key") or "").strip()
    if provider_credential and not values.get("ZENOS_LLM_API_KEY", "").strip().strip('"\''):
        values["ZENOS_LLM_API_KEY"] = provider_credential
    if not values:
        raise SystemExit("No Runtime environment source was found")
    destination.write_text(
        "".join(f"{key}={value}\n" for key, value in sorted(values.items())),
        encoding="utf-8",
    )
    destination.chmod(0o600)


def prepare_config(source: Path, destination: Path) -> None:
    if not source.is_file():
        destination.write_text("{}\n", encoding="utf-8")
        return
    data = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    provider_name, provider = runtime_provider(source)
    sanitized = {
        "model": {
            "default": model.get("default") or "grok",
            "provider": model.get("provider") or "etla-router",
            "context_length": model.get("context_length") or 1_000_000,
        },
        "providers": {
            provider_name: {
                "base_url": provider.get("base_url") or provider.get("url") or "https://router.etla.me/v1",
                "default_model": provider.get("default_model") or model.get("default") or "grok",
            },
        },
    }
    destination.write_text(yaml.safe_dump(sanitized, sort_keys=False), encoding="utf-8")
    destination.chmod(0o600)


def prepare_model_slots(source: Path, destination: Path) -> None:
    data = {}
    if source.is_file():
        try:
            loaded = json.loads(source.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except json.JSONDecodeError:
            data = {}
    allowed = {
        "baseUrl", "hostModel", "hostProvider", "hostBaseUrl",
        "workerModel", "workerProvider", "workerBaseUrl",
        "bossModel", "bossProvider", "bossBaseUrl",
        "verifierModel", "verifierProvider", "verifierBaseUrl",
    }
    sanitized = {key: value for key, value in data.items() if key in allowed and isinstance(value, str) and value.strip()}
    sanitized["verifierModel"] = "ag/gemini-3.5-flash-low"
    sanitized["verifierProvider"] = "etla-router"
    destination.write_text(json.dumps(sanitized, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    destination.chmod(0o600)


def main() -> None:
    if len(sys.argv) < 9:
        raise SystemExit(
            "usage: prepare-runtime-service-files.py ENV_OUT CONFIG_OUT CONFIG_IN MODEL_OUT MODEL_IN ENV_SOURCE..."
        )
    environment_output = Path(sys.argv[1])
    config_output = Path(sys.argv[2])
    config_input = Path(sys.argv[3])
    model_output = Path(sys.argv[4])
    model_input = Path(sys.argv[5])
    sources = [Path(value) for value in sys.argv[6:]]
    prepare_environment(environment_output, sources, config_input)
    prepare_config(config_input, config_output)
    prepare_model_slots(model_input, model_output)


if __name__ == "__main__":
    main()
