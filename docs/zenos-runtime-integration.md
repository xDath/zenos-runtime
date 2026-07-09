# Zenos Runtime Integration Spec

## Current Shape

Zenos Runtime v1 is a lightweight local/client intelligence layer in `app/lib/zenos-runtime.ts`. It does not replace Hermes and does not run local LLMs.

```text
Hermes/Codex host -> Zenos Runtime router -> Zenos Memory/cloud LLM/tools policy -> final answer
```

## Available API

### `POST /api/runtime/route`

Input:

```json
{
  "request": "fix bug di repo ini",
  "hasFiles": true,
  "hasLogs": false,
  "hasCodeChangeIntent": true,
  "userRequestedVerification": false,
  "estimatedContextTokens": 4000,
  "confidence": 0.75
}
```

Output:

```json
{
  "ok": true,
  "decision": {
    "taskType": "coding_change",
    "pipelineMode": "grounded_path",
    "hostTier": "premium",
    "workerTier": "none",
    "verifierTier": "none",
    "useMemory": true,
    "useTools": true
  },
  "routeEvent": {
    "taskType": "coding_change",
    "pipelineMode": "grounded_path",
    "premiumInputTokens": 4000,
    "premiumOutputTokens": 900
  }
}
```

### `POST /api/runtime/run`

Runs the actual Host/Worker/Verifier pipeline. This is the endpoint that calls cheap worker and premium host models. Use `dryRun: true` to validate routing without model calls.

### `POST /api/runtime/route-event`

Persists a high-signal route event into Zenos Memory.

Input:

```json
{
  "namespace": "zenos",
  "persist": true,
  "event": {
    "taskType": "coding_change",
    "pipelineMode": "grounded_path",
    "hostModelTier": "premium",
    "workerModelTier": "none",
    "verifierTier": "none",
    "inputSizeBucket": "medium",
    "outputSizeBucket": "unknown",
    "verdict": "success"
  }
}
```

### `GET /api/runtime/eval`

Runs the built-in routing regression benchmark and returns pass/fail plus token estimates.

### `GET /api/runtime/readiness`

Returns the production maturity checklist for the runtime layer.

## Host Integration Pattern

1. Host receives user request.
2. Host calls `choosePipeline()` or `/api/runtime/route`.
3. If `useMemory`, host recalls Zenos Memory before final reasoning.
4. If `useTools`, host inspects local files/logs/web/source before answering.
5. If `useWorker`, host delegates bounded compression/extraction to cheap worker.
6. If `useVerifier`, host verifies draft/action before final answer.
7. Host stores `routeEventMemoryContent(routeEvent)` to Zenos Memory for durable route learning.

## Worker Contract

Workers must return `WorkerResultSchema`. They are not allowed to dump raw context. They must provide concise findings, evidence references, confidence, and suggested next step.

## Verifier Contract

Verifiers must return `VerifierResultSchema` with `pass`, `revise`, `escalate`, or `block`. Deterministic checks should run before LLM verifier calls when possible.

## Memory Policy

Store route events only when useful:

- production/high-risk tasks;
- verifier failures;
- escalations;
- repeated task patterns;
- successful procedures worth reusing;
- user corrections or preferences.

Avoid noisy writes for trivial fast-path chats.

## Validation

Run:

```bash
npm run smoke:runtime
npm run build
```
