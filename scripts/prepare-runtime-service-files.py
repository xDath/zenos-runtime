#!/usr/bin/env python3
"""Prepare a merged environment bundle and an allowlisted Runtime config."""
from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import sys
import urllib.error
import urllib.request
from copy import deepcopy
from functools import lru_cache
from pathlib import Path

import yaml


SECRET_FIELD_NAMES = {
    "api_key", "api-key", "apikey", "token", "access_token",
    "password", "password_hash", "secret", "private_key",
}
SECRET_LIST_FIELD_NAMES = {"keys", "api_keys", "tokens"}
CREDENTIAL_POOL_PATH_NAMES = {"credential_pool_strategies", "credential_pools"}


def _is_credential_pool_secret_list(path: tuple[str, ...], key: object, value: object) -> bool:
    return (
        isinstance(value, list)
        and str(key).lower() in SECRET_LIST_FIELD_NAMES
        and any(str(part).lower() in CREDENTIAL_POOL_PATH_NAMES for part in path)
    )


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
            if _is_credential_pool_secret_list(path, key, child):
                for index, item in enumerate(child):
                    if isinstance(item, str) and item.strip() and not env_reference(item):
                        yield (*child_path, str(index)), item
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
            elif _is_credential_pool_secret_list(path, key, child):
                result[key] = [
                    f"${{{secret_environment_name((*child_path, str(index)))}}}"
                    if isinstance(item, str) and item.strip() and not env_reference(item)
                    else replace_secret_literals(item, (*child_path, str(index)))
                    for index, item in enumerate(child)
                ]
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


ETLA_ROUTER_LOOPBACK_BASE_URL = "http://127.0.0.1:20128/v1"


def normalized_base_url(value: str) -> str:
    return str(value or "").strip().rstrip("/")


def model_ids_from_payload(payload) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for entry in payload["data"]:
        model_id = str(entry.get("id") if isinstance(entry, dict) else "").strip()
        if model_id and model_id not in seen:
            result.append(model_id)
            seen.add(model_id)
    return result


@lru_cache(maxsize=8)
def discover_etla_router_catalog(configured_base_url: str) -> tuple[str, tuple[str, ...]]:
    override_base_url = normalized_base_url(os.environ.get("ZENOS_ROUTER_BASE_URL", ""))
    configured = normalized_base_url(configured_base_url)
    candidates: list[tuple[str, str]] = []
    models_override = str(os.environ.get("ZENOS_ROUTER_MODELS_URL", "")).strip()
    if models_override:
        candidates.append((override_base_url or configured or ETLA_ROUTER_LOOPBACK_BASE_URL, models_override))
    if override_base_url:
        candidates.append((override_base_url, f"{override_base_url}/models"))
    candidates.append((ETLA_ROUTER_LOOPBACK_BASE_URL, f"{ETLA_ROUTER_LOOPBACK_BASE_URL}/models"))
    if configured and configured != ETLA_ROUTER_LOOPBACK_BASE_URL:
        candidates.append((configured, f"{configured}/models"))

    seen_urls: set[str] = set()
    for base_url, models_url in candidates:
        if not models_url or models_url in seen_urls:
            continue
        seen_urls.add(models_url)
        try:
            request = urllib.request.Request(
                models_url,
                headers={"Accept": "application/json", "User-Agent": "zenos-runtime-deployer/0.6"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            model_ids = model_ids_from_payload(payload)
            if model_ids:
                return normalized_base_url(base_url), tuple(model_ids)
        except (OSError, TimeoutError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
            continue
    return configured or ETLA_ROUTER_LOOPBACK_BASE_URL, ()


def runtime_provider_catalog(source: Path) -> tuple[str, dict, str, list[str]]:
    provider_name, provider = runtime_provider(source)
    configured_base_url = normalized_base_url(provider.get("base_url") or provider.get("url") or "")
    if provider_name != "etla-router":
        return provider_name, provider, configured_base_url, []
    base_url, model_ids = discover_etla_router_catalog(configured_base_url)
    return provider_name, provider, base_url, list(model_ids)


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
    provider_name, provider, discovered_base_url, _ = runtime_provider_catalog(config_source)
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
    if not resolved_environment_value(runtime_values, "ZENOS_BACKUP_ENCRYPTION_KEY"):
        runtime_values["ZENOS_BACKUP_ENCRYPTION_KEY"] = shlex.quote(secrets.token_urlsafe(48))

    provider_base_url = discovered_base_url or str(provider.get("base_url") or provider.get("url") or "").strip()
    if not resolved_environment_value(runtime_values, "ZENOS_LLM_BASE_URL"):
        fallback_base_url = (
            provider_base_url
            or resolved_environment_value(values, "LLM_BASE_URL")
            or resolved_environment_value(values, "MEMORY_LLM_BASE_URL")
        )
        if fallback_base_url:
            runtime_values["ZENOS_LLM_BASE_URL"] = shlex.quote(fallback_base_url)

    # Production Memory compute is cloud-first. Google Drive remains the
    # canonical append-only store and the VPS is only a thin client. Preserve an
    # explicitly supplied cloud URL, otherwise use the official Vercel endpoint;
    # never silently couple Runtime availability to a loopback sidecar.
    configured_memory_url = resolved_environment_value(values, "ZENOS_MEMORY_URL")
    if configured_memory_url.startswith("https://"):
        runtime_values["ZENOS_MEMORY_URL"] = shlex.quote(configured_memory_url)
    else:
        runtime_values["ZENOS_MEMORY_URL"] = "https://zenos-memory.vercel.app"
    write_environment(destination, runtime_values, "Runtime")


def prepare_hermes_environment(destination: Path, values: dict[str, str], config_source: Path) -> None:
    hermes_values = dict(values)
    configured_memory_url = resolved_environment_value(values, "ZENOS_MEMORY_URL")
    hermes_values["ZENOS_MEMORY_URL"] = shlex.quote(
        configured_memory_url if configured_memory_url.startswith("https://") else "https://zenos-memory.vercel.app"
    )
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
    provider_name, provider, discovered_base_url, _ = runtime_provider_catalog(source)
    sanitized = {
        "model": {
            "default": model.get("default") or "grok",
            "provider": model.get("provider") or "etla-router",
            "context_length": model.get("context_length") or 1_000_000,
        },
        "providers": {
            provider_name: {
                "base_url": discovered_base_url or provider.get("base_url") or provider.get("url") or "https://router.etla.me/v1",
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
    provider_name, _provider, discovered_base_url, discovered_models = runtime_provider_catalog(source)
    providers = data.get("providers") if isinstance(data.get("providers"), dict) else {}
    provider = providers.get(provider_name) if isinstance(providers.get(provider_name), dict) else None
    if provider_name == "etla-router" and provider is not None:
        provider["base_url"] = discovered_base_url or ETLA_ROUTER_LOOPBACK_BASE_URL
        provider["discover_models"] = True
        existing_models = provider.get("models") if isinstance(provider.get("models"), dict) else {}
        if discovered_models:
            provider["models"] = {
                model_id: deepcopy(existing_models.get(model_id))
                if isinstance(existing_models.get(model_id), dict)
                else {"description": f"{model_id} - Etla Router"}
                for model_id in discovered_models
            }

    # Production invariants. Runtime is a Host-led cognitive task engine: one
    # session model, native Hermes worker profiles, local-first continuation
    # capsules, and cloud Memory off the active compression hot path.
    model = data.setdefault("model", {})
    if isinstance(model, dict):
        model["context_length"] = max(int(model.get("context_length") or 0), 1_000_000)
    compression = data.setdefault("compression", {})
    if not isinstance(compression, dict):
        compression = {}
        data["compression"] = compression
    compression.update({
        "enabled": True,
        "threshold": 0.20,
        "target_ratio": 0.35,
        "protect_first_n": 3,
        "protect_last_n": 12,
        "hygiene_hard_message_limit": 600,
        "abort_on_summary_failure": False,
        "deterministic_provider_failure_fallback": True,
        "in_place": True,
    })
    runtime = data.setdefault("zenos_runtime", {})
    if not isinstance(runtime, dict):
        runtime = {}
        data["zenos_runtime"] = runtime
    runtime.update({
        "enabled": True,
        "url": "http://127.0.0.1:3090",
        "fail_open": True,
        "max_history_chars": 64_000,
        "context_soft_limit_tokens": 140_000,
        "handoff_history_chars": 240_000,
        "handoff_max_messages": 300,
        "disable_streaming_when_verified": True,
        "report_failures": False,
        "authoritative_host": True,
        "enforce_host_token_budget": False,
        "enforce_host_working_set_limit": False,
    })
    delegation = data.setdefault("delegation", {})
    if not isinstance(delegation, dict):
        delegation = {}
        data["delegation"] = delegation
    delegation.update({
        "model": "",
        "provider": "",
        "inherit_mcp_toolsets": True,
        "max_iterations": max(15, int(delegation.get("max_iterations") or 15)),
        "child_timeout_seconds": max(600, int(delegation.get("child_timeout_seconds") or 600)),
        "max_concurrent_children": 3,
        "max_spawn_depth": 1,
        "orchestrator_enabled": True,
        "subagent_auto_approve": False,
    })
    tools = data.setdefault("tools", {})
    if not isinstance(tools, dict):
        tools = {}
        data["tools"] = tools
    tool_search = tools.setdefault("tool_search", {})
    if not isinstance(tool_search, dict):
        tool_search = {}
        tools["tool_search"] = tool_search
    always_visible = tool_search.get("always_visible") if isinstance(tool_search.get("always_visible"), list) else []
    tool_search["always_visible"] = list(dict.fromkeys([*always_visible, "delegate_task"]))
    terminal = data.setdefault("terminal", {})
    if not isinstance(terminal, dict):
        terminal = {}
        data["terminal"] = terminal
    terminal["cwd"] = "/root/openclaw-projects"
    approvals = data.setdefault("approvals", {})
    if not isinstance(approvals, dict):
        approvals = {}
        data["approvals"] = approvals
    approvals["mode"] = "off"
    approvals["cron_mode"] = "approve"
    data["hooks_auto_accept"] = True

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
    sanitized["verifierModel"] = "verifier-grok43-deepseek"
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
