# Zenos Continuity v2 and CommandJob Rollout

## Scope

This release upgrades Hermes, Zenos Runtime, and Zenos Memory as one continuity contract:

- Hermes compiles `ContinuityPacket v2` from meaningful head context, full-history milestones, active tool evidence, unfinished work, and recent tail.
- Runtime is the single checkpoint coordinator and persists checkpoint cursor/hash state in SQLite.
- Memory accepts the packet, validates packet integrity, compiles a deterministic checkpoint, evaluates claim-to-evidence faithfulness, and only supersedes the previous checkpoint when coverage and chain validation pass.
- Every root cognitive task receives one durable `CommandJob` with ordered backend steps and evidence-gated completion.

The canonical execution engine remains the existing cognitive task + continuation queue. `CommandJob` is the root result contract and audit ledger; it is not a second scheduler.

## Runtime schema migration

Runtime SQLite schema version is `12`.

New tables:

- `continuity_checkpoints`
- `command_jobs`
- `command_steps`

The migration is additive and is executed by the normal Runtime store initialization. Existing session, run, cognitive task, continuation, token governor, and coding task tables remain authoritative.

## Feature flags and rollback controls

All flags default to enabled unless stated otherwise.

```env
ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED=true
ZENOS_RUNTIME_COMMAND_JOBS_ENABLED=true
ZENOS_RUNTIME_EVIDENCE_FAITHFULNESS_ENABLED=true
```

Memory production settings:

```env
ZENOS_MEMORY_EVIDENCE_FAITHFULNESS_ENABLED=true
ZENOS_MEMORY_CONTINUITY_LLM_ENABLED=false
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

1. Disable `ZENOS_RUNTIME_COMMAND_JOBS_ENABLED` to return to cognitive-task-only continuation without removing schema v12 tables.
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

## P1 shadow-only work

The following are intentionally not production-promoted by this release because their exit criteria require longitudinal evidence:

- Worker-first routing by task class: collect at least 30–50 high-quality outcomes per class and compare completion, validation, correction, token, and latency metrics before changing defaults.
- Drive event packs: add reader/pack shadow parity and verify materialized state hashes before moving canonical reads away from individual events.
- automatic model-budget promotion: remain observation-only until the Outcome Passport dataset reaches the required sample size.

This is a rollout requirement, not missing implementation authority: the upgrade plan explicitly requires shadow comparison and parity before promotion.
