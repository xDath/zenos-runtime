# Zenos Runtime Production v1

This document defines the production-ready v1 boundary for Zenos Runtime.

## What Production v1 Provides

- Standalone `/api/runtime/*` namespace.
- Host/Middleman, Boss, and Worker Pool schemas.
- Durable session store with best-effort local JSON persistence.
- Live session event stream via server-sent events.
- Worker dispatch and worker-event APIs.
- Quality gate for evidence, confidence, and escalation checks.
- Boss escalation packets and optional automatic Boss model review.
- Runtime budget state with premium/host/worker token estimates.
- Route/readiness/eval APIs.
- Zenos Memory route-event persistence via remote API when configured.

## Production Boundary

Zenos Runtime owns orchestration:

```text
Host/Middleman -> Worker events -> Quality gate -> Boss escalation -> final state
```

Zenos Memory remains a remote context/telemetry service:

```text
ZENOS_MEMORY_BASE_URL=https://zenos-memory.vercel.app
ZENOS_MEMORY_API_KEY=...
```

Runtime must not import the Memory engine directly.

## Required Environment

```bash
ETLA_MASTER_SECRET=change_me
ZENOS_LLM_BASE_URL=https://router.example.com/v1
ZENOS_HOST_MODEL=provider/medium-model
ZENOS_WORKER_MODEL=provider/cheap-model
ZENOS_VERIFIER_MODEL=provider/cheap-or-premium-verifier
ZENOS_RUNTIME_STORE_PATH=/tmp/zenos-runtime-sessions.json

# Optional telemetry to Zenos Memory
ZENOS_MEMORY_BASE_URL=https://zenos-memory.vercel.app
ZENOS_MEMORY_API_KEY=change_me
```

`ZENOS_LLM_BASE_URL` may be either a base URL or a complete endpoint ending in `/model` or `/chat/completions`.

## Production Smoke

```bash
npm run smoke:runtime
npm run lint
npm run build
```

Expected result:

- smoke passes route, schema, three-agent, quality gate, eval, readiness, and dry-run checks;
- lint has zero errors;
- Next build exposes only runtime endpoints.

## Live Supervision Flow

1. `POST /api/runtime/session` creates a Host-supervised session.
2. `POST /api/runtime/dispatch` creates a Worker lease.
3. `GET /api/runtime/stream/:sessionId` watches live compact events.
4. `POST /api/runtime/worker-event` records Worker findings/progress/risks.
5. Runtime pauses session on high-risk/rancu events.
6. `POST /api/runtime/escalate` builds Boss packet.
7. `POST /api/runtime/boss-review` applies provided Boss decision or calls Boss model with `auto=true`.

## Production Caveats

- The built-in JSON session store is suitable for one-node deployments. Multi-node/serverless deployments should move session state to Redis, Postgres, or Zenos Memory-backed storage.
- Worker execution is API-driven in v1: external runtimes/Hermes workers post events back to Runtime. Fully managed background worker spawning is a later phase.
- Token accounting is estimated from text length; provider usage parsing can be added later.

## Production Readiness Claim

Production v1 is ready when:

- smoke/lint/build pass;
- secret scan passes;
- GitHub push succeeds;
- deploy target has env vars configured;
- live supervision flow is tested against a deployed URL.
