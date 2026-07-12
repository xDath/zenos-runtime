# Zenos Runtime v0.2 Production Contract

## Supported topology

Zenos Runtime v0.2 is production-ready for one active process on one trusted VPS. It binds to loopback, uses 9Router as its OpenAI-compatible model gateway, and stores orchestration state in SQLite WAL.

This claim is deliberately narrower than “distributed platform.” Horizontal replicas require shared persistence, queues, nonces, rate limits, and idempotency before they are safe.

## Runtime contract

```text
request
  -> deterministic intent/risk policy
  -> optional Zenos Memory recall
  -> bounded Worker passes
  -> Host synthesis
  -> Verifier gate
      pass      -> answer
      revise    -> Host revision -> verify again
      escalate  -> Boss packet -> decision
      block     -> stop
  -> durable run/session/telemetry
```

The four default model roles remain:

```text
Host      grok
Worker    build
Boss      codex
Verifier  grok
```

## Production gates

`npm run validate:production` must pass all of:

- strict TypeScript validation;
- ESLint with zero errors;
- deterministic policy, persistence, auth, and mocked model integration tests;
- runtime smoke suite;
- Next.js production build without ignored type errors.

Live deployment must additionally pass:

- `systemctl is-active zenos-runtime.service`;
- public liveness on `/api/health`;
- authenticated `/api/runtime/readiness`;
- SQLite `quick_check`;
- 9Router dependency probe;
- one real Host model pipeline call;
- confirmation that all four default model slots are unchanged.

## Durable state

The systemd deployment uses `/var/lib/zenos-runtime/runtime.db` with:

- WAL journal mode;
- `synchronous=FULL`;
- foreign keys;
- immediate write transactions;
- persisted idempotency and replay nonces;
- database schema versioning;
- readiness integrity checks.

## Failure semantics

- Missing authentication: reject.
- Invalid body/schema: reject before model execution.
- Duplicate nonce: reject.
- Duplicate idempotency key with same request: replay stored response.
- Duplicate key with different request: conflict.
- Worker failure: warn and allow Host to continue only when safe.
- Host failure: fail the run.
- Verifier revise: revise and re-check.
- Verifier/Boss block: fail closed.
- Critical Boss failure: fail the run.
- Optional Memory failure: degrade with explicit warning; do not invent recall.
- SQLite integrity failure: readiness fails.

## Operational endpoints

See [`../README.md`](../README.md) for the complete scoped endpoint table. `/api/health` is liveness only. `/api/runtime/readiness` is the production readiness source of truth and is authenticated.
