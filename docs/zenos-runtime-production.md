# Zenos Runtime Production Readiness

**Status:** production-ready v1 foundation, not full roadmap completion.

This does not mean every future roadmap idea is complete. It means the current runtime layer is safe, testable, authenticated, measurable, and integrated enough to operate as a v1 production foundation beside Hermes/Codex. The earlier phrase "production mature" should be read as "production-ready foundation", not as a finished learned router/control-plane product.

## Production Surface

- `POST /api/runtime/route`
  - authenticated route decision API;
  - returns task type, pipeline mode, model tiers, tool/memory/worker/verifier policy, and token estimate event.

- `POST /api/runtime/route-event`
  - authenticated route event persistence API;
  - stores high-signal routing outcomes into Zenos Memory as event memories.

- `GET /api/runtime/eval`
  - authenticated regression suite for routing policy.

- `GET /api/runtime/readiness`
  - authenticated production readiness report.

## Production Guarantees

- No local LLM requirement.
- No Hermes rebuild.
- Auth and rate-limit wrappers on runtime APIs.
- Zod validation on runtime inputs and contracts.
- Worker outputs are capped and structured.
- Verifier outputs are structured for pass/revise/escalate/block.
- Route events can be stored in Zenos Memory for long-term routing learning.
- Built-in eval covers fast, memory, worker, coding, security, and deploy paths.
- Smoke test verifies schemas, eval, memory serialization, and readiness status.

## Operating Procedure

Run local validation:

```bash
npm run smoke:runtime
npm run build
npm run lint
```

Expected:

- smoke passes;
- build passes;
- lint has no errors. Existing warnings may remain until separately cleaned.

Check runtime readiness through API:

```bash
GET /api/runtime/readiness
```

Expected status:

```text
production_ready_v1
```

## Route Event Persistence Policy

Persist route events when they are useful for learning:

- verifier failed;
- route escalated;
- task was high-risk;
- user corrected the result;
- task represented a reusable procedure;
- model performance matters for future routing.

Do not persist trivial fast-path chat noise.

## Remaining Future Enhancements

These are not required for production-mature v1, but they are the next upgrades:

- provider-specific live cost pricing;
- learned router from stored route events;
- dashboard visualization for route quality/cost/latency;
- direct Hermes hook/plugin packaging;
- broader benchmark dataset;
- RAG/worker evals with real model calls.
