# Zenos Memory and Etla Runtime Audit Backlog

**Audit date:** 2026-07-12  
**Implementation release:** Zenos Runtime 0.3.0 and Zenos Memory 2.2.0

## Completed in this release

1. **Canonical gateway model accounting.** Hermes now reports the real internal Host call count plus uncached input, cached reads/writes, output, and reasoning usage. Runtime rolls Hermes Host and Runtime Host/Worker/Verifier/Boss usage into the persistent session budget before completion.
2. **Stale session reconciliation.** Runtime cancels abandoned active sessions and worker leases after a configurable inactivity window while retaining their audit history and reconciliation metadata.
3. **Layered Host context continuity.** Hermes keeps recent raw conversation context, Runtime supplies the active execution brief, and Zenos Memory supplies selective recall, bootstrap context, or a durable structured handoff under working-set pressure.
4. **Absolute Host working-set limit.** The Zenos Hermes profile lowers the existing cache-aware compression threshold to an absolute token budget instead of waiting for a percentage of a one-million-token model window.
5. **Coverage-gated Memory compaction.** Memory compaction separately bounds source input and durable output, preserves a conversation head plus recent tail, and reports coverage for goal, decisions, pending work, questions, and artifacts.
6. **Planner economy.** Clear repository, coding, and debugging work follows deterministic Host orchestration without an additional Host planner call. Ambiguous, architectural, high-risk, verification, and Boss paths retain model planning.
7. **Context-safe tool history handoff.** Hermes sends a bounded compaction packet with small tool-result previews; the canonical raw transcript remains stored and recoverable.
8. **Contract coverage.** New Runtime and Memory tests cover durable handoff contracts, coverage metadata, planner skipping, cached-token accounting, internal Host call accounting, and stale lifecycle cleanup.

## Remaining priority backlog

1. Reconcile Runtime local history with `origin/main`, then keep deployed HEAD, CI HEAD, and repository HEAD aligned.
2. Deploy Zenos Memory 2.2.0 and verify authenticated production readiness plus real Drive cloud/concurrency smoke gates.
3. Clarify whether the Runtime systemd service is only a control plane or also a writable coding executor. Align service identity, repository write permissions, sandboxing, and approval boundaries with that contract. Avoid a general-purpose root executor.
4. Split large orchestration modules. Separate gateway planning, Memory continuity, role execution, accounting, lifecycle reconciliation, persistence, and response gating into bounded modules.
5. Expand Zenos Memory route-level contracts across authentication scope, malformed payloads, response schemas, rate limits, status codes, and failure behavior.
6. Make latency a first-class Runtime budget alongside token and cost budgets, with task-class targets per role.
7. Establish one versioned outcome ledger before adaptive routing, cost-per-success optimization, or self-improvement is enabled.
8. Complete real end-to-end GitHub remote validation from an approved isolated branch and preserve structured validation evidence.

## Validation evidence

- Zenos Runtime 0.3.0: typecheck passed, 37 tests passed, production build passed, and Runtime smoke/production validation is required before deployment.
- Zenos Memory 2.2.0: zero-warning lint passed, typecheck passed, 27 tests passed, and two-stage production build passed.
- Hermes native bridge: 19 targeted gateway tests passed, including Runtime middleware, `/fast`, and `/wmodel` paths.

## Next execution order

1. Git reconciliation and release push.
2. Live Runtime/Hermes deployment and readiness smoke.
3. Memory production deployment verification.
4. Runtime privilege/execution boundary.
5. Module decomposition and latency budgets.
6. Broader route contracts and adaptive intelligence.
