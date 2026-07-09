# Zenos Runtime

Zenos Runtime is the standalone orchestration layer for Zenos: routing, host/worker/verifier pipelines, runtime evals, and telemetry.

It is intentionally separate from Zenos Memory. Runtime decides how work should flow; Memory stores durable context and route outcomes when configured.

```text
Zenos Runtime
  -> route request risk and task type
  -> optionally compress context with cheap workers
  -> call the host model for final synthesis
  -> optionally verify risky outputs
  -> optionally persist route events to Zenos Memory
```

## API

Runtime endpoints live under `/api/runtime/*`:

```text
POST /api/runtime/route        Classify a request and return routing policy
POST /api/runtime/run          Run Host/Worker/Verifier pipeline
POST /api/runtime/route-event  Record runtime route telemetry
GET  /api/runtime/eval         Run routing regression evals
GET  /api/runtime/readiness    Report production readiness checks
```

## Environment

```bash
ETLA_MASTER_SECRET=change_me
ZENOS_RUNTIME_API_KEY=change_me

ZENOS_LLM_BASE_URL=http://localhost:20128/model
ZENOS_HOST_MODEL=your-host-model
ZENOS_WORKER_MODEL=your-cheap-worker-model
ZENOS_VERIFIER_MODEL=your-verifier-model

# Optional: persist route events into Zenos Memory
ZENOS_MEMORY_BASE_URL=https://zenos-memory.vercel.app
ZENOS_MEMORY_API_KEY=change_me
```

The model base URL may be either a complete endpoint (`/model` or `/chat/completions`) or an OpenAI-compatible base URL. Complete endpoints are preserved.

## Roadmap

- Core runtime roadmap: `zenos-runtime-roadmap.md`
- Three-agent architecture roadmap: `docs/zenos-runtime-three-agent-roadmap.md`
- Cheap-worker quality amplification roadmap: `docs/zenos-runtime-quality-amplification-roadmap.md`
- Production v1 readiness: `docs/zenos-runtime-production-v1.md`

## Local Development

```bash
npm install
npm run smoke:runtime
npm run lint
npm run build
npm run dev
```

## Boundary

```text
zenos-memory  = durable context, recall, remember, graph, compact, storage
zenos-runtime = routing, orchestration, model calls, verifier, telemetry
```

Runtime can call Memory, but Runtime is not Memory.
