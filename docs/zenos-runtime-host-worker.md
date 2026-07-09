# Zenos Runtime Host/Worker Execution

This is the part that actually targets premium-token savings.

## Strategy

```text
Cheap Worker = preprocess and compress raw context
Premium Host = read compact worker result and make final judgment
Verifier = optional quality/safety gate
```

The goal is not always lower total tokens. The goal is lower **premium host tokens**.

## Runtime Endpoint

`POST /api/runtime/run`

Input:

```json
{
  "request": "summarize these logs and tell me likely root cause",
  "context": "large raw context here",
  "memoryContext": "optional Zenos Memory recall",
  "toolContext": "optional file/log/tool output",
  "estimatedContextTokens": 9000,
  "dryRun": false
}
```

Use `dryRun: true` to test routing and token estimates without model calls.

## Model Environment

Default behavior: Zenos Runtime reads the same Hermes model/provider config from `~/.hermes/profiles/zenos/config.yaml`.

Optional command-style overrides are stored in `~/.hermes/profiles/zenos/zenos-runtime.json`:

```bash
npm run runtime:config -- /hmodel ag/claude-sonnet-4-6
npm run runtime:config -- /wmodel ag/gemini-3.5-flash-low
npm run runtime:config -- /vmodel ag/gemini-3-flash
npm run runtime:config -- show
```

Env names still override everything when needed:

```bash
ZENOS_LLM_BASE_URL=https://router.etla.me/v1
ZENOS_LLM_API_KEY=...
ZENOS_HOST_MODEL=ag/claude-sonnet-4-6
ZENOS_WORKER_MODEL=ag/gemini-3.5-flash-low
ZENOS_VERIFIER_MODEL=ag/gemini-3-flash
```

Fallback env names reuse the existing memory LLM config:

```bash
MEMORY_LLM_BASE_URL=...
MEMORY_LLM_API_KEY=...
MEMORY_LLM_MODEL=...
MEMORY_LLM_FALLBACK_MODEL=...
```

## Flow

1. `choosePipeline()` classifies the task.
2. If `useWorker`, `runWorkerCompression()` calls cheap worker and validates `WorkerResultSchema`.
3. `runHostSynthesis()` calls premium host with worker result instead of raw context when available.
4. If `useVerifier`, `runVerifier()` validates the draft with `VerifierResultSchema`.
5. Pipeline returns `premiumTokensAvoidedEstimate`.

## Important Limits

- Worker output is capped and structured.
- Worker does not own final decisions.
- Host still owns final answer.
- Verifier blocks or flags risky output.
- If worker fails, host still runs with focused context.
