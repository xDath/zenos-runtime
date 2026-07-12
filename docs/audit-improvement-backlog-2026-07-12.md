# Zenos Memory and Etla Runtime Audit Backlog

**Audit date:** 2026-07-12  
**Implementation release:** Zenos Runtime 0.3.0 and Zenos Memory 2.2.0

## Completed in this release

1. **Canonical gateway model accounting.** Hermes reports the real internal Host call count plus uncached input, cached reads/writes, output, and reasoning usage. Runtime rolls Hermes Host and Runtime Host/Worker/Verifier/Boss usage into the persistent session budget before completion.
2. **Stale session reconciliation.** Runtime cancels abandoned active sessions and worker leases after a configurable inactivity window while retaining audit history and reconciliation metadata.
3. **Layered Host context continuity.** Hermes keeps recent raw conversation context, Runtime supplies active execution state, and Zenos Memory supplies selective recall, bootstrap context, or a durable structured handoff under working-set pressure.
4. **Absolute Host working-set limit.** The Zenos Hermes profile lowers the existing cache-aware compression threshold to an absolute 160,000-token budget instead of waiting for half of a one-million-token model window.
5. **Coverage-gated Memory compaction.** Memory compaction separately bounds source input and durable output, preserves a conversation head plus recent tail, and reports coverage for goal, decisions, pending work, questions, and artifacts.
6. **Planner economy.** Clear repository, coding, and debugging work follows deterministic Host orchestration without an additional Host planner call. Ambiguous, architectural, high-risk, verification, and Boss paths retain model planning.
7. **Context-safe tool history handoff.** Hermes sends a bounded compaction packet with small tool-result previews; the canonical raw transcript remains stored and recoverable.
8. **Contract coverage.** New Runtime and Memory tests cover durable handoff contracts, coverage metadata, planner skipping, cached-token accounting, internal Host call accounting, and stale lifecycle cleanup.
9. **Git reconciliation.** Runtime `main` was rebuilt directly on the remote canonical history, the new release was applied as one clean commit series, and the workflow-scope-blocked historical commits were retained only in a local backup branch.
10. **Memory branch/deployment alignment.** Zenos Memory production was found to track `main` while GitHub defaulted to `master`. Both refs were aligned, GitHub default was moved to `main`, and Vercel production now runs 2.2.0.
11. **Live deployment.** Runtime 0.3.0 and the Hermes Zenos gateway were restarted successfully. Runtime protected readiness is green with routing 20/20, SQLite integrity, fail-closed authentication, four configured role models, 9Router HTTP 200, and Memory HTTP 200.
12. **Real Drive validation.** Cloud and concurrency smoke gates passed against Google Drive, including CAS lease exclusion/handoff, append-only mutations, cross-instance idempotency, immutable snapshots, search/graph indexes, cold-start convergence, parallel writes, and archive recovery. Test namespaces were trashed after completion.

## Remaining priority backlog

1. Clarify whether the Runtime systemd service is only a control plane or also a writable coding executor. Align service identity, repository write permissions, sandboxing, and approval boundaries with that contract. Avoid a general-purpose root executor.
2. Split large orchestration modules. Separate gateway planning, Memory continuity, role execution, accounting, lifecycle reconciliation, persistence, and response gating into bounded modules.
3. Expand Zenos Memory route-level contracts across authentication scope, malformed payloads, response schemas, rate limits, status codes, and failure behavior.
4. Make latency a first-class Runtime budget alongside token and cost budgets, with task-class targets per role.
5. Establish one versioned outcome ledger before adaptive routing, cost-per-success optimization, or self-improvement is enabled.
6. Complete real end-to-end GitHub remote coding validation from an approved isolated branch and preserve structured validation evidence.

## Validation evidence

- **Zenos Runtime 0.3.0:** production validation passed after canonical-history reconciliation: typecheck, quiet lint, 37 tests, 20-case routing smoke, Memory continuity smoke, and Next.js production build.
- **Zenos Memory 2.2.0:** `npm run check` passed: typecheck, zero-warning lint, 27 tests, local smoke, and two-stage production build.
- **Zenos Memory cloud gates:** `smoke:cloud` and `smoke:concurrency` passed against Google Drive with automatic test-namespace cleanup.
- **Hermes native bridge:** 19 targeted gateway tests passed across Runtime middleware, `/fast`, and `/wmodel` paths.
- **Live Runtime:** version 0.3.0, status ready, SQLite schema 3 integrity OK, routing 20/20, 9Router reachable, Zenos Memory reachable.
- **Live Memory:** public status and health report operational version 2.2.0 on the production Vercel alias.

## Next execution order

1. Runtime privilege/execution boundary.
2. Module decomposition and latency budgets.
3. Broader Memory route contracts.
4. Versioned outcome ledger and adaptive intelligence.
5. Approved end-to-end remote coding validation.
