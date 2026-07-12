# Archived v1 Production Boundary

This document is retained as a migration marker. The former v1 architecture used a best-effort JSON session store and treated Worker execution as externally driven.

Zenos Runtime v0.2 replaces that boundary with:

- Host, Worker, Verifier, and Boss as four explicit model roles;
- transactional SQLite WAL state;
- persisted runs, idempotency, nonces, workers, events, and route telemetry;
- managed Worker execution plus external-worker compatibility;
- real Host revision and Verifier re-check loops;
- real Boss escalation;
- body-bound HMAC v2 and scoped tokens;
- actual dependency readiness and metrics.

The canonical production documentation is now [`../README.md`](../README.md), [`../SECURITY.md`](../SECURITY.md), and [`zenos-runtime-production.md`](./zenos-runtime-production.md).
