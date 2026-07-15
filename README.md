# Zenos Runtime

Zenos Runtime is the production orchestration control plane for the Zenos/Hermes stack. It routes requests by intent and risk, delegates bounded work, independently verifies drafts, escalates critical judgment, and persists every meaningful state transition.

```text
Hermes / API client
        │
        ▼
Deterministic intent + risk policy
        │
        ├── Worker: bounded extraction, compression, evidence preparation
        ├── Host: user-facing judgment, synthesis, and revision
        ├── Verifier: independent grounding, safety, and validation gate
        └── Boss: rare premium escalation for critical risk or ambiguity
        │
        ▼
SQLite WAL state + route telemetry + optional Zenos Memory
```

## What v0.7 guarantees

- **Real four-role execution.** Host, Worker, Verifier, and Boss use distinct configurable model slots.
- **Real revision semantics.** A `revise` verdict produces a new Host draft and another verification pass.
- **Real escalation semantics.** Critical routes and unresolved verifier findings reach the Boss model.
- **Managed and external workers.** Runtime can execute a worker immediately or lease work to an external Hermes worker.
- **Durable single-node state.** Sessions, worker leases, events, runs, idempotency records, route events, and replay nonces use transactional SQLite WAL.
- **Fail-closed production auth.** Scoped bearer tokens and HMAC v2 bind method, path, body hash, nonce, client identity, and operation scope.
- **Safe retry behavior.** `/api/runtime/run` supports persistent `Idempotency-Key` handling.
- **Per-session model isolation.** Global defaults remain intact while individual sessions can override role models and providers.
- **Operational evidence.** Structured logs, request IDs, readiness checks, dependency probes, JSON metrics, Prometheus metrics, tests, and policy regression cases.
- **Memory integration.** Runtime can recall non-secret context and persist route outcomes through Zenos Memory without importing its engine.
- **Non-root control plane.** Production runs from a root-owned read-only release under `/opt`; local mutation is denied and writable state is restricted to `/var/lib/zenos-runtime`.
- **Task-aware latency budgets.** Memory, repository inspection, Host, Worker, Verifier, Boss, and total wall-clock time are independently measured against task-class budgets.
- **Outcome Passports.** Every governed gateway outcome receives an immutable versioned passport containing route, token/cache usage, latency, quality, and evidence coverage.
- **No-Regret Routing Board.** Shadow routing aggregates outcomes and surfaces cheaper or stronger candidates, but cannot promote a route automatically without sufficient evidence and explicit human approval.
- **Modular orchestration.** Gateway contracts, continuity, planning, rendering, accounting, latency, and outcome intelligence live in bounded modules instead of one orchestration god-file.
- **Verified HTTP execution plane.** Health, routing, durable sessions, scoped auth, dry-run orchestration, idempotent replay, and conflict responses are exercised through the actual Next.js Route Handlers.
- **Canonical filesystem boundaries.** Read, mutation, and remote-validation roots resolve real paths, normalize the legacy `/root/openclaw-projects` alias to `/srv/etla/workspaces`, and reject symlink escapes before tools or Git operations run.
- **Invisible bounded continuation.** Unfinished coding turns retain one durable task and automatically continue for a bounded number of backend turns; the user sees one terminal result rather than needing to repeat the command after compaction or failed validation.
- **Isolated mandatory authority.** Optional Host planning has a separate token governor, while unavailable mandatory Verifier/Boss roles deterministically escalate or block instead of consuming the final Host reserve or silently degrading.
- **Narrow production operations.** Approved service status, logs, and restarts flow through the allowlisted Unix-socket operations broker rather than raw `systemctl` from non-root Runtime or Hermes processes.

## Current default role models

The existing Etla configuration is preserved:

```text
Host      grok
Worker    build
Boss      codex
Verifier  grok
Provider  etla-router / 9Router
```

Defaults can be changed globally or per session without changing source code.

## API surface

| Endpoint | Purpose | Scope |
|---|---|---|
| `POST /api/runtime/route` | Intent/risk classification | `runtime:route` |
| `POST /api/runtime/run` | Complete governed pipeline | `runtime:run` |
| `GET /api/runtime/runs/:runId` | Durable run result | `runtime:read` |
| `POST /api/runtime/session` | Create a durable session | `runtime:session` |
| `GET/PATCH/DELETE /api/runtime/session/:id` | Inspect, update, or cancel | read/session |
| `POST /api/runtime/dispatch` | Managed or external worker | `runtime:worker` |
| `POST /api/runtime/worker-event` | External worker event | `runtime:worker` |
| `POST /api/runtime/escalate` | Build compact Boss packet | `runtime:worker` |
| `POST /api/runtime/boss-review` | Apply or generate Boss decision | `runtime:worker` |
| `POST /api/runtime/quality-gate` | Evidence/confidence gate | `runtime:worker` |
| `GET/POST /api/runtime/models` | Read or update role slots | read/models |
| `GET /api/runtime/stream/:sessionId` | Server-sent session events | `runtime:read` |
| `GET /api/runtime/eval` | Routing regression report | `runtime:read` |
| `GET /api/runtime/readiness` | Actual readiness and dependencies | `runtime:read` |
| `GET /api/runtime/metrics` | JSON or Prometheus metrics | `runtime:metrics` |
| `GET /api/runtime/outcomes` | Outcome Passports and No-Regret shadow analytics | `runtime:read` |
| `POST /api/runtime/outcomes` | Append human feedback as a new immutable outcome revision | `runtime:admin` |
| `POST /api/runtime/token` | Mint scoped short-lived token | `runtime:admin` |
| `GET /api/health` | Public liveness only | public |

All operational responses include `X-Request-Id` and are non-cacheable.

## Quick start

```bash
npm ci
cp .env.example .env.local
npm run validate:production
npm run start:local
```

The local production server binds to `127.0.0.1:3090` by default.

## Safe authenticated call

The simplest local integration uses the dedicated Runtime API key:

```bash
curl -sS http://127.0.0.1:3090/api/runtime/route \
  -H "Authorization: Bearer $ZENOS_RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"request":"jelaskan arsitektur deployment production","intent":"explain"}'
```

For multi-client deployments, mint short-lived scoped tokens through `/api/runtime/token`. HMAC v2 is intended for trusted service-to-service clients that need request-body integrity and replay protection.

## Run pipeline with safe retries

```bash
curl -sS http://127.0.0.1:3090/api/runtime/run \
  -H "Authorization: Bearer $ZENOS_RUNTIME_API_KEY" \
  -H "Idempotency-Key: example-run-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "request":"summarize the supplied source and identify unsupported claims",
    "intent":"analyze",
    "context":"...",
    "estimatedContextTokens":8000
  }'
```

Repeating the same request with the same key returns the stored result. Reusing the key with a different body returns `409`.

## Model configuration

Global model slots in the hardened production service live in:

```text
/etc/zenos-runtime/models.json
```

The development checkout may continue using the legacy profile path under `~/.hermes/profiles/zenos/`.

Session overrides can be set through:

```text
POST /api/runtime/models?sessionId=<session-id>
```

Resolution order, from lowest to highest priority:

```text
Hermes config → environment → global Runtime config → session config → inline run override
```

API responses never return model API keys.

## Persistence

The systemd deployment uses:

```text
/var/lib/zenos-runtime/runtime.db
```

SQLite runs with:

- WAL journaling;
- full synchronous durability;
- foreign-key enforcement;
- busy timeout;
- immediate transactions for write-critical operations;
- quick integrity checks in readiness.

This is intentionally optimized for a **single active VPS process**. Horizontal multi-node deployment should move state, nonces, rate limits, and worker queues to a shared Postgres/Redis architecture before adding replicas.

## Security model

Production refuses to start without Runtime authentication and all four model roles. The hardened systemd unit:

- runs as the dedicated `zenos-runtime` system user, never as root;
- loads a root-owned read-only release from `/opt/zenos-runtime/current`;
- operates in explicit `control-plane` execution mode;
- denies local patch, rollback, and production mutations;
- binds only to loopback;
- disables legacy path-only HMAC;
- drops all Linux capabilities and enables `NoNewPrivileges`;
- uses private temporary/device namespaces and a closed device policy;
- protects home, kernel, proc, hostname, clock, and system paths;
- restricts writable paths to Runtime state and cache directories;
- creates `/var/lib/zenos-runtime` with mode `0700` and applies umask `0077`.

Install or upgrade the hardened service after a successful production build:

```bash
sudo scripts/install-control-plane-service.sh
```

See [`SECURITY.md`](./SECURITY.md) for the protocol and threat boundaries.

## Validation

```bash
npm run validate:production
```

The gate runs:

1. strict TypeScript validation;
2. ESLint with zero errors;
3. deterministic and mocked integration tests;
4. runtime smoke checks;
5. a full Next.js production build with type errors enabled.

## Operations

```bash
systemctl status zenos-runtime.service
journalctl -u zenos-runtime.service -f
curl -sS http://127.0.0.1:3090/api/health
```

Protected readiness:

```bash
curl -sS http://127.0.0.1:3090/api/runtime/readiness \
  -H "Authorization: Bearer $ZENOS_RUNTIME_API_KEY"
```

Real four-role live evidence (uses the configured production models and incurs model calls):

```bash
ZENOS_RUNTIME_API_KEY=... npm run smoke:live
```

The smoke fails unless the actual HTTP control plane returns a completed execution receipt with Host, Worker, Verifier, and Boss calls.

The readiness endpoint tests the policy suite, SQLite integrity, fail-closed authentication, execution-mode boundary, schema-v4 Outcome Passport ledger, all role-model slots, 9Router reachability, and optional Zenos Memory reachability. It does not return a hardcoded success label.

## Product boundary

```text
Zenos Runtime = routing, model execution, state transitions, verification, escalation, telemetry
Zenos Memory  = durable context, recall, compaction, graph, user-owned memory storage
9Router       = provider/model gateway
Hermes        = user interaction and tool surface
```

Runtime calls Memory through a remote client. Runtime never imports or mutates the Memory engine directly.
