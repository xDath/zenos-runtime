# Zenos Runtime Native Hermes Middleware

## Status

The Zenos profile can run Runtime as a native two-phase middleware around every Hermes Gateway turn.

This replaces the earlier protocol-only posture where the Host had to remember to invoke Runtime manually.

## Turn lifecycle

```text
incoming Telegram / WhatsApp turn
→ Runtime preflight persists the turn and chooses the route
→ optional Worker evidence brief
→ optional Boss preflight guardrails
→ Hermes Host executes normally with tools and conversation history
→ optional Verifier postflight
→ optional Boss postflight
→ optional Runtime Host revision
→ verified answer + deterministic execution receipt
```

Direct low-risk chat still records a Runtime session and receipt, but Worker, Verifier, and Boss are deliberately skipped by policy.

## Layered context continuity

The native middleware keeps three distinct context layers instead of replaying the entire transcript into every Host call:

1. **Hot context:** Hermes keeps the recent raw conversation and active tool loop in its canonical transcript.
2. **Warm context:** Runtime injects the current route, acceptance criteria, Worker evidence, verification state, and guardrails.
3. **Cold context:** Zenos Memory supplies selective recall, a bounded bootstrap packet, or a durable structured handoff when the Host working set crosses `context_soft_limit_tokens`.

Stored history is not deleted. The working-set limit only lowers Hermes' existing cache-aware compression threshold. Before context compression, Hermes sends a bounded head-plus-recent-tail packet to Runtime; Runtime persists a coverage-checked Memory handoff that must retain the active goal, decisions, pending work, open questions, and artifacts.

Clear repository, coding, and debugging tasks use deterministic Host orchestration and skip a separate planner model call. Architectural, ambiguous, high-risk, verification, and explicit Boss paths retain Host planning.

## Profile configuration

```yaml
zenos_runtime:
  enabled: true
  url: http://127.0.0.1:3090
  fail_open: true
  receipt: concise
  timeout_seconds: 180
  max_history_chars: 16000
  context_soft_limit_tokens: 140000
  handoff_history_chars: 240000
  handoff_max_messages: 300
  disable_streaming_when_verified: true
  report_failures: true
```

The Runtime API key remains in the profile environment or Runtime `.env.local`. It must not be stored in this configuration block.

## Delivery safety

When a route requires Verifier or Boss, final token streaming is disabled for that turn. Hermes may still show progress commentary, but the user-facing answer is released only after Runtime postflight.

If Runtime revises the draft:

1. the verified answer replaces the discarded draft;
2. the canonical Hermes transcript is rewritten with the verified answer;
3. the ephemeral Runtime brief is removed before transcript persistence;
4. the cached agent is evicted so the next turn reloads the verified transcript.

## Availability policy

`fail_open: true` keeps Etla available when the local Runtime sidecar is temporarily unavailable. The Host response is delivered with an explicit Runtime-unavailable receipt.

Set `fail_open: false` only when every response must be Runtime-gated even during an outage.

## Model controls

- `/model` changes the active Hermes Host and synchronizes the Runtime Host slot.
- `/wmodel` stages Host, Worker, and Boss together.
- Saving `/wmodel` now resolves and applies the selected Host to the real Hermes session, not only to Runtime configuration.
- If Hermes Host provider resolution fails, Runtime role configuration is rolled back to prevent control-plane drift.

## Evidence and observability

Runtime stores role activity with the actual model and provider used. The final receipt reports invoked versus skipped roles. 9Router reads the same persisted evidence; it is not the source of truth.

Example:

```text
Runtime · worker_compression_path · Host grok · Worker build ✓ · Verifier skipped · Boss skipped
```

## Operational endpoints

```text
POST /api/runtime/gateway/preflight
POST /api/runtime/gateway/postflight
GET  /api/runtime/overview
```

Both turn endpoints require `runtime:run` authorization.
