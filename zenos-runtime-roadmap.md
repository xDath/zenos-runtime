# Zenos Runtime Roadmap

**Status:** Primary roadmap now points to the three-agent architecture.  
**Canonical architecture:** `docs/zenos-runtime-three-agent-roadmap.md`

Zenos Runtime is moving from a simple router/worker/verifier layer into a supervised three-agent runtime:

```text
User
  -> Host / Middleman Agent
      -> Worker Agent Pool
      -> Boss Agent
  -> User
```

## Core Idea

- **Host / Middleman Agent:** medium-tier, user-facing, always active, supervises and routes.
- **Boss Agent:** premium-tier, called rarely for high-risk or ambiguous judgment.
- **Worker Agent Pool:** cheap-tier, high-volume tool/context work, untrusted by default.

The goal is to reduce premium-token usage without lowering quality.

```text
Workers do heavy context/tool work cheaply.
Host supervises and compresses results.
Boss receives only compact escalation packets.
```

## Roadmap Documents

- Main three-agent roadmap: `docs/zenos-runtime-three-agent-roadmap.md`
- Cheap-worker quality amplification: `docs/zenos-runtime-quality-amplification-roadmap.md`
- Integration docs: `docs/zenos-runtime-integration.md`
- Production notes: `docs/zenos-runtime-production.md`

## Implementation Phases

1. Architecture alignment and docs.
2. Runtime state + event bus.
3. Worker registry + templates.
4. Host supervisor.
5. Boss escalation.
6. Quality gate + anti-hallucination.
7. Budget manager + cost tracking.
8. Memory-backed learning.
9. Eval harness.
10. Hermes/Codex integration.

See `docs/zenos-runtime-three-agent-roadmap.md` for the full spec.
