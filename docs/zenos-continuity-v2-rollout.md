# Zenos Continuity v2 and CommandJob Rollout

## Scope

This release upgrades Hermes, Zenos Runtime, and Zenos Memory as one continuity contract:

- Hermes compiles `ContinuityPacket v2` from meaningful head context, full-history milestones, active tool evidence, unfinished work, and recent tail.
- Runtime is the single checkpoint coordinator and persists checkpoint cursor/hash state in SQLite.
- Memory accepts the packet, validates packet integrity, compiles a deterministic checkpoint, evaluates claim-to-evidence faithfulness, and only supersedes the previous checkpoint when coverage and chain validation pass.
- Every root cognitive task receives one durable `CommandJob` with ordered backend steps and evidence-gated completion.

The canonical execution engine remains the existing cognitive task + continuation queue. `CommandJob` is the root result contract and audit ledger; it is not a second scheduler.

## Runtime schema migration

Runtime SQLite schema version is `13`.

New tables:

- `continuity_checkpoints`
- `command_jobs`
- `command_steps`
- `runtime_audit`

The migration is additive and is executed by the normal Runtime store initialization. Existing session, run, cognitive task, continuation, token governor, and coding task tables remain authoritative.

## Feature flags and rollback controls

All flags default to enabled unless stated otherwise.

```env
ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED=true
ZENOS_RUNTIME_COMMAND_JOBS_ENABLED=true
ZENOS_RUNTIME_EVIDENCE_FAITHFULNESS_ENABLED=true
ZENOS_LOW_TIER_FIRST_MODE=shadow
ZENOS_LOW_TIER_FIRST_APPROVED_TASKS=repo_question,coding_change,debugging
ZENOS_LOW_TIER_MIN_OUTCOMES=30
ZENOS_LOW_TIER_CANARY_PERCENT=10
```

Memory production settings:

```env
ZENOS_MEMORY_EVIDENCE_FAITHFULNESS_ENABLED=true
ZENOS_MEMORY_CONTINUITY_LLM_ENABLED=false
ZENOS_MEMORY_EVENT_PACK_MODE=shadow
ZENOS_MEMORY_OPERATION_MODE=opportunistic_free
ZENOS_MEMORY_MAX_DAILY_DRIVE_WRITES=10000
ZENOS_MEMORY_MAX_DAILY_LLM_TOKENS=250000
ZENOS_MEMORY_MAX_STORAGE_BYTES=10737418240
ZENOS_MEMORY_MIN_FREE_STORAGE_BYTES=536870912
ZENOS_MEMORY_DEGRADATION_MODE=deterministic
```

The Runtime evidence flag requires an explicit `checkpoint_validated=true` receipt before persisting coordinator state. The Memory evidence flag controls the claim-to-evidence gate itself. Continuity packets are deterministic-first by default so packet validation, Drive persistence, and checkpoint chaining stay inside the serverless write deadline; LLM continuity compaction is an explicit shadow-only opt-in.

Hermes profile settings:

```yaml
zenos_runtime:
  continuity_packet_v2: true
  fail_open: true
  fail_closed_mutations: true
```

Rollback order:

1. Disable `ZENOS_RUNTIME_COMMAND_JOBS_ENABLED` to return to cognitive-task-only continuation without removing additive schema v13 tables.
2. Disable `ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED` to return to legacy pressure-triggered Memory compaction.
3. Set `continuity_packet_v2: false` in Hermes only if the Runtime/Memory packet contract itself must be bypassed. Legacy `handoffMessages` remains available.
4. Keep `ZENOS_MEMORY_CONTINUITY_LLM_ENABLED=false` unless a measured shadow deployment proves the LLM path fits the function deadline and preserves checkpoint parity.
5. Keep `fail_closed_mutations: true` unless an operator intentionally accepts unverified mutation during a Runtime outage.
6. Runtime release rollback remains the immutable `/opt/zenos-runtime/previous` symlink managed by `scripts/install-control-plane-service.sh`.
7. Memory rollback uses the prior Vercel production deployment. Continuity v2 checkpoints remain audit data and do not need deletion.

Do not downgrade the SQLite schema manually. Old releases ignore the additive tables.

## Availability policy

- Read-only, low-risk chat may fail open with an explicit degraded receipt.
- Coding mutation, security/secret work, deploy, delete, restart, and destructive operations fail closed or pause/retry when Runtime is unavailable.
- Compaction LLM failure falls back to deterministic DAG compaction.
- Hermes Memory compression never writes a parallel cloud checkpoint while Runtime coordination is enabled. It submits source evidence to the authenticated Runtime checkpoint endpoint and uses a deterministic local brief only when Runtime is unavailable.
- Runtime process restart requeues the first uncommitted `CommandStep`, preserves the root cognitive task, creates a durable internal continuation, and reconciles workspace hashes before mutation.
- Gateway abort terminalizes the Runtime run, cognitive task, continuation lease, `CommandJob`, and all uncommitted steps together.
- A checkpoint that fails evidence coverage or faithfulness does not supersede the previous verified checkpoint.

## Acceptance gates

Before activation:

- Runtime `npm run typecheck && npm test` passes.
- Memory `npm run typecheck && npm test` passes.
- Hermes continuity/middleware tests pass under the production venv interpreter.
- The three-stage 160k/300k/500k-character compaction replay preserves:
  - root goal and acceptance criteria;
  - architecture decision;
  - changed file paths;
  - latest deterministic validation;
  - blocker;
  - next action.
- Runtime SQLite backup and Memory cloud backup complete before activation.
- Runtime, Memory, 9Router, and Hermes smoke checks pass after activation.

## P1 implementation and promotion gates

The implementations are present, but promotion remains evidence-gated:

- Low-tier tool-first routing supports `off`, `shadow`, `canary`, and `enabled`. Shadow mode evaluates Outcome Passports by task class. Canary requires at least 30 clean outcomes, >=90% success/validated revision, <=5% failure/block, >=80% evidence coverage, zero invalid usage samples, and >=85% feedback acceptance when feedback exists. Critical/high-risk and workspace-less work are never eligible.
- Drive event packs write immutable gzip NDJSON segments plus checksum-verified immutable manifests. `shadow` leaves individual events authoritative; `canary` reads packs for explicit namespaces and compares the full materialized revision; `read` is allowed only after canary parity. Individual hot events remain for rollback.
- Verified Learning Cards cover preference, decision, procedure, failure, and project state. Preference requires direct user confirmation, procedure requires deterministic test evidence, and conflicting cards are injected together with an explicit verify-before-selection warning.
- The internal evaluation gate contains 100 noisy golden cases, deterministic replay, bilingual regression, and a counterfactual supported-answer comparison. Real longitudinal user acceptance is still required before automatic route promotion.

This distinction is intentional: implementation completeness does not bypass the plan's evidence-based production exit criteria.

## Resource and zero-cost policy

Memory operation modes are:

- `zero_cost`: LLM calls are disabled; Drive durability and deterministic lexical/vector fallback remain available.
- `opportunistic_free`: free-provider calls are allowed only inside the durable daily token budget; exhaustion degrades deterministically.
- `premium_optional`: provider use requires `ZENOS_MEMORY_PREMIUM_BUDGET_APPROVED=true`.

Daily Drive writes, estimated LLM tokens, and written bytes are reserved through a Google Drive CAS ledger before the operation. Drive storage usage and minimum free-space reserves are checked before writes. The authenticated dashboard exposes operation mode, pack mode, usage, limits, storage quota, active signing key id, accepted rotation keys, and snapshot age.

## Signing-key separation and rotation

Runtime authentication and Memory signing use separate secrets. Memory accepts a rotating keyring:

```env
# Memory/Vercel
ZENOS_MEMORY_SIGNING_KEYS={"memory-2026-07":"<current>","memory-previous":"<previous>"}
ZENOS_MEMORY_ACTIVE_KID=memory-2026-07

# Runtime and Hermes clients
ZENOS_MEMORY_SIGNING_KID=memory-2026-07
ZENOS_MEMORY_SIGNING_SECRET=<current>
```

Tokens and HMAC exchange use a `kid`-bound v3 contract. `zm2` bearer tokens identify the key used to sign them. Retain the previous key for at least the maximum one-hour token lifetime plus clock skew, then remove it. Legacy `zm1` and v2 exchange remain migration-only and should be removed after every active client reports v3.

## Complete rollback matrix

- Single coordinator: set Hermes `runtime_coordinator_enabled: false` and disable `ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED`; legacy plugin compact resumes with its idempotency spool.
- CommandJob: disable `ZENOS_RUNTIME_COMMAND_JOBS_ENABLED`; additive tables remain audit-only.
- Low-tier-first: set `ZENOS_LOW_TIER_FIRST_MODE=off` or return a specific task class to the control route by removing it from the approved list.
- Event packs: set `ZENOS_MEMORY_EVENT_PACK_MODE=shadow` or `off`; the individual-event reader remains intact and packs are never deleted.
- Resource policy: retain deterministic degradation; do not raise limits as an outage workaround without reviewing Drive and provider usage.
- Signing rotation: keep both current and previous key ids until clients are rolled back or upgraded; switch `ZENOS_MEMORY_ACTIVE_KID` without rewriting existing data.
