#!/usr/bin/env python3
"""Prepare a merged environment bundle and an allowlisted Runtime config."""
from __future__ import annotations

import json
import re
import shlex
import sys
from copy import deepcopy
from pathlib import Path

import yaml


SECRET_FIELD_NAMES = {
    "api_key", "api-key", "apikey", "token", "access_token",
    "password", "password_hash", "secret", "private_key",
}


def env_reference(value: str) -> bool:
    return bool(re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", value.strip()))


def secret_environment_name(path: tuple[str, ...]) -> str:
    normalized = "_".join(re.sub(r"[^A-Za-z0-9]+", "_", part).strip("_") for part in path)
    return f"HERMES_CONFIG_{normalized.upper()}"


def secret_literals(value, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (*path, str(key))
            if (
                str(key).lower() in SECRET_FIELD_NAMES
                and isinstance(child, str)
                and child.strip()
                and not env_reference(child)
            ):
                yield child_path, child
            yield from secret_literals(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from secret_literals(child, (*path, str(index)))


def replace_secret_literals(value, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            child_path = (*path, str(key))
            if (
                str(key).lower() in SECRET_FIELD_NAMES
                and isinstance(child, str)
                and child.strip()
                and not env_reference(child)
            ):
                result[key] = f"${{{secret_environment_name(child_path)}}}"
            else:
                result[key] = replace_secret_literals(child, child_path)
        return result
    if isinstance(value, list):
        return [replace_secret_literals(child, (*path, str(index))) for index, child in enumerate(value)]
    return value


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


RUNTIME_EXACT_ENVIRONMENT_KEYS = {
    "ETLA_CACHE_MAX_BYTES",
    "ETLA_CACHE_MAX_ENTRIES",
    "ETLA_LOCAL_COMMAND_CONCURRENCY",
    "ETLA_MASTER_SECRET",
    "ETLA_RUNTIME_ARTIFACT_DIR",
}


def merged_environment(sources: list[Path]) -> dict[str, str]:
    values: dict[str, str] = {}
    for source in sources:
        for key, value in parse_env(source).items():
            current = values.get(key, '').strip().strip('"\'')
            candidate = value.strip().strip('"\'')
            if key not in values or (not current and candidate):
                values[key] = value
    return values


def resolved_environment_value(values: dict[str, str], key: str) -> str:
    return values.get(key, "").strip().strip('"\'')


def write_environment(destination: Path, values: dict[str, str], label: str) -> None:
    if not values:
        raise SystemExit(f"No {label} environment source was found")
    destination.write_text(
        "".join(f"{key}={value}\n" for key, value in sorted(values.items())),
        encoding="utf-8",
    )
    destination.chmod(0o600)


def prepare_runtime_environment(destination: Path, values: dict[str, str], config_source: Path) -> None:
    runtime_values = {
        key: value
        for key, value in values.items()
        if key.startswith("ZENOS_") or key in RUNTIME_EXACT_ENVIRONMENT_KEYS
    }
    _, provider = runtime_provider(config_source)
    provider_credential = str(provider.get("api_key") or "").strip()
    if env_reference(provider_credential):
        provider_credential = resolved_environment_value(values, provider_credential[2:-1])
    if not provider_credential:
        provider_credential = (
            resolved_environment_value(values, "ZENOS_LLM_API_KEY")
            or resolved_environment_value(values, "LLM_API_KEY")
            or resolved_environment_value(values, "MEMORY_LLM_API_KEY")
        )
    if provider_credential and not resolved_environment_value(runtime_values, "ZENOS_LLM_API_KEY"):
        runtime_values["ZENOS_LLM_API_KEY"] = shlex.quote(provider_credential)

    provider_base_url = str(provider.get("base_url") or provider.get("url") or "").strip()
    if not resolved_environment_value(runtime_values, "ZENOS_LLM_BASE_URL"):
        fallback_base_url = (
            provider_base_url
            or resolved_environment_value(values, "LLM_BASE_URL")
            or resolved_environment_value(values, "MEMORY_LLM_BASE_URL")
        )
        if fallback_base_url:
            runtime_values["ZENOS_LLM_BASE_URL"] = shlex.quote(fallback_base_url)

    # The VPS installs Memory as a loopback sidecar. Keep Runtime on that
    # release-consistent path instead of silently drifting to an older public
    # deployment inherited from a historical environment file.
    runtime_values["ZENOS_MEMORY_URL"] = "http://127.0.0.1:3091"
    write_environment(destination, runtime_values, "Runtime")


def prepare_hermes_environment(destination: Path, values: dict[str, str], config_source: Path) -> None:
    hermes_values = dict(values)
    if config_source.is_file():
        config = yaml.safe_load(config_source.read_text(encoding="utf-8")) or {}
        for field_path, value in secret_literals(config):
            hermes_values.setdefault(secret_environment_name(field_path), shlex.quote(value))
    write_environment(destination, hermes_values, "Hermes")


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


def prepare_hermes_config(source: Path, destination: Path) -> None:
    if not source.is_file():
        destination.write_text("{}\n", encoding="utf-8")
        destination.chmod(0o600)
        return
    data = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    sanitized = replace_secret_literals(deepcopy(data))
    destination.write_text(yaml.safe_dump(sanitized, sort_keys=False, allow_unicode=True), encoding="utf-8")
    destination.chmod(0o600)


def validate_prepared_credentials(environment: Path, hermes_config: Path) -> None:
    environment_keys = set(parse_env(environment))
    data = yaml.safe_load(hermes_config.read_text(encoding="utf-8")) or {}
    unresolved: list[str] = []
    literal: list[str] = []
    for field_path, value in secret_literals(data):
        literal.append(".".join(field_path))

    def inspect(value, path: tuple[str, ...] = ()) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = (*path, str(key))
                if (
                    str(key).lower() in SECRET_FIELD_NAMES
                    and isinstance(child, str)
                    and child.strip()
                    and env_reference(child)
                ):
                    environment_name = child.strip()[2:-1]
                    if environment_name not in environment_keys:
                        unresolved.append(".".join(child_path))
                inspect(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                inspect(child, (*path, str(index)))

    inspect(data)
    if literal:
        raise SystemExit(f"Hermes config still contains secret literals at: {', '.join(sorted(literal))}")
    if unresolved:
        raise SystemExit(f"Hermes config contains unresolved secret references at: {', '.join(sorted(unresolved))}")


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
            "usage: prepare-runtime-service-files.py RUNTIME_ENV_OUT CONFIG_OUT CONFIG_IN MODEL_OUT MODEL_IN HERMES_CONFIG_OUT HERMES_ENV_OUT ENV_SOURCE..."
        )
    runtime_environment_output = Path(sys.argv[1])
    config_output = Path(sys.argv[2])
    config_input = Path(sys.argv[3])
    model_output = Path(sys.argv[4])
    model_input = Path(sys.argv[5])
    hermes_config_output = Path(sys.argv[6])
    hermes_environment_output = Path(sys.argv[7])
    sources = [Path(value) for value in sys.argv[8:]]
    values = merged_environment(sources)
    prepare_runtime_environment(runtime_environment_output, values, config_input)
    prepare_hermes_environment(hermes_environment_output, values, config_input)
    prepare_config(config_input, config_output)
    prepare_model_slots(model_input, model_output)
    prepare_hermes_config(config_input, hermes_config_output)
    validate_prepared_credentials(hermes_environment_output, hermes_config_output)


if __name__ == "__main__":
    main()
