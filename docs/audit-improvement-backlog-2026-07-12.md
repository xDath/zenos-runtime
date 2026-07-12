# Zenos Memory and Etla Runtime Audit Closure

**Audit date:** 2026-07-12  
**Closure release:** Zenos Runtime 0.4.0 and Zenos Memory 2.2.0

## Original backlog status

All six remaining audit items are complete.

1. **Runtime privilege and execution boundary — completed.** Production Runtime is now an explicit non-root control plane. It runs as the dedicated `zenos-runtime` system identity from a root-owned, read-only release under `/opt/zenos-runtime/current`. Local patching, rollback, and production mutation are denied. Remote validation requires explicit approval, an enabled gate, and an isolated allowlisted workspace. Writable state is limited to Runtime-owned state/cache paths under `/var/lib` and `/var/cache`.
2. **Module decomposition — completed.** Gateway contracts, Memory continuity, planning, rendering, accounting, latency, and outcome intelligence were extracted from the gateway orchestration monolith. Role-context compaction/splitting/merging was extracted from the executor. The orchestrator now coordinates bounded modules rather than owning every implementation concern.
3. **Zenos Memory route contracts — completed.** The test suite now invokes real Next.js Route Handlers and covers public liveness, scoped read/write authorization, malformed JSON, validation failures, raw-secret rejection, success schemas, bounded compact/bootstrap output, no-store headers, and stable 429 rate-limit responses.
4. **Latency as a first-class budget — completed.** Runtime creates task-aware budgets for Memory, repository inspection, Host, Worker, Verifier, Boss, and total wall-clock time. Every observation is classified as within budget, soft breach, or hard breach and is persisted in the Outcome Passport.
5. **Versioned outcome ledger — completed.** SQLite schema 4 includes an immutable revisioned outcome ledger. Each governed gateway turn receives an `etla-outcome-passport-v1` containing route/request fingerprints, role token/cache usage, latency, quality verdicts, Memory coverage, and user feedback revisions.
6. **Real GitHub remote validation — completed.** Runtime restored a pinned GitHub Actions workflow, dispatched validation from an approved isolated workspace, consumed structured run/job/step evidence, downloaded the uploaded JSON artifact, and automatically removed the successful temporary branch.

## Additional unique improvement

### No-Regret Routing Board

Runtime 0.4 adds an observation-only adaptive layer named `etla-no-regret-board-v1`.

It groups the latest Outcome Passport per run by task class and pipeline, then measures:

- sample size;
- success and failure rates;
- user-feedback acceptance;
- average token usage;
- average latency;
- votes for cheaper, stronger, or unchanged routing.

A route is only marked evidence-ready after at least 20 outcomes, at least 90% success, at most 3% blocked/failed outcomes, and at least 85% feedback acceptance when feedback exists. Even then, `automaticPromotionAllowed` remains `false`: a human must explicitly approve any production route change.

## Previously completed 0.3 continuity work

- Canonical Hermes/Runtime model-call accounting.
- Stale session and worker reconciliation.
- Layered hot/warm/cold Host context.
- Absolute 160,000-token Host working-set limit.
- Coverage-gated Memory handoff.
- Deterministic planner skipping for clear coding/repository work.
- Bounded tool-history handoff while retaining the canonical raw transcript.
- Runtime/Memory Git and deployment alignment.
- Real Google Drive cloud and concurrency validation.

## Validation evidence

### Runtime local production gate

- Version: `0.4.0`
- Commit: `1e2044197d4c4bcacb99e92efbbdcf3816c9b525`
- TypeScript typecheck: passed.
- Quiet ESLint: passed.
- Tests: **40/40 passed**.
- Routing smoke: **20/20 passed**.
- Production Next.js build: passed.
- Production dependency audit: **0 vulnerabilities**.

### Runtime remote GitHub gate

- GitHub Actions run: `29200058800`
- Result: **success**.
- Validated SHA: `1e2044197d4c4bcacb99e92efbbdcf3816c9b525`.
- Gates: typecheck, lint, tests, Runtime smoke, production build, dependency audit.
- Runtime evidence artifact: `/var/lib/zenos-runtime/artifacts/remote_validation_1783873513182_6930b429a30c.json`.
- Downloaded GitHub artifact: `/var/lib/zenos-runtime/artifacts/github-29200058800-final/runtime-validation.json`.
- Temporary success branch: automatically removed.
- Two earlier failed branches used to expose and fix CI-environment defects were removed after diagnosis.

### Memory gate

- Version: `2.2.0`.
- Commit: `95a8f4d`.
- Typecheck and zero-warning lint: passed.
- Tests: **32/32 passed**, including the route-contract matrix.
- Local smoke and two-stage production build: passed.
- Production dependency audit: **0 vulnerabilities**.
- Existing real Google Drive cloud/concurrency gates remain green.

### Live deployment

- Runtime release: `/opt/zenos-runtime/releases/0.4.0-1e2044197d4c`.
- Service identity: `zenos-runtime:zenos-runtime`.
- Source release: root-owned and read-only.
- SQLite state: `zenos-runtime` owned, mode `0600`, schema 4, integrity OK.
- Runtime readiness: **ready**.
- Execution evidence: `mode=control-plane`, `localMutation=false`, `remoteValidation=false` in the live service.
- Routing policy: **20/20**.
- 9Router: reachable.
- Zenos Memory: reachable.
- Hermes Zenos gateway: active after the service migration.

### Live Outcome Passport smoke

- Run: `gateway_a10a3bf0-627c-4ae3-bcff-c4800f29c0b5`.
- Pipeline: `direct_fast_path`.
- Verdict: `success`.
- Aggregate Host usage: 248 tokens including cached reads.
- Total observed latency: 640 ms, within the 15,000 ms task budget.
- No-Regret recommendation: `retain`.
- Automatic promotion: disabled.

## Ongoing operating rules

These are guardrails rather than unfinished backlog:

1. Keep adaptive routing in shadow mode until explicit human promotion approval.
2. Keep production Runtime remote validation disabled except during an approved isolated validation operation.
3. Build releases in the checkout, then install immutable artifacts through `scripts/install-control-plane-service.sh`.
4. Preserve Outcome Passport revisions and GitHub/Drive validation artifacts as audit evidence.
5. Re-run local and remote gates before every execution-boundary, workflow, auth, storage, or adaptive-routing change.
