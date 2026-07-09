# Zenos Runtime Research Matrix

**Purpose:** collect reusable patterns for Zenos Runtime without rebuilding Hermes.

## Selection Criteria

- Routes between cheap and premium models.
- Supports agentic loops or tool-aware workflows.
- Provides verifier, guardrail, or eval patterns.
- Can work with cloud model APIs and does not require local LLM inference.
- Can integrate beside Hermes/Codex as a layer, proxy, plugin, or sidecar.

## Matrix

| Repo | Category | What To Steal | What Not To Copy | Fit |
| --- | --- | --- | --- | --- |
| `BerriAI/litellm` | model gateway | provider abstraction, cost accounting, OpenAI-compatible surface | full proxy dependency before v1 needs it | High |
| `lm-sys/RouteLLM` | model routing | weak/strong model routing and threshold ideas | training-heavy route selection as the first version | High |
| `NadirRouter/NadirClaw` | agent cost router | simple-vs-complex routing for agent clients | any harness-specific assumptions | High |
| `bitrouter/bitrouter` | agentic gateway | policy-driven routing for agent loops | replacing Hermes provider stack outright | Medium |
| `RelayPlane/proxy` | cost proxy | dashboard, policy engine, cost intelligence | cloud proxy as mandatory path | Medium |
| `harrrshall/tinyrouter` | learned router | very small router/classifier concept | learned router before telemetry exists | Low-Medium |
| `langchain-ai/langgraph` | orchestration | graph/state-machine pattern for pipeline modes | pulling in a heavy graph framework too early | High as pattern |
| `microsoft/autogen` | multi-agent | worker role/task delegation patterns | open-ended multi-agent chat loops | Medium |
| `crewAIInc/crewAI` | role agents | role abstraction and task handoff wording | high-level framework lock-in | Medium |
| `sfw/loom` | harness/runtime | structured state, decomposition, verification harness | complete runtime replacement | High as pattern |
| `linghungegeg/Linghun` | grounded coding runtime | evidence-first answers, tool grounding, verification | copying broad AGI/runtime scope | High as pattern |
| `AbyssCN/xihe` | multi-agent runtime | deterministic orchestration, cross-model verifier, memory concept | self-contained runtime replacement | Medium-High |
| `vasundras/agent-runtime-patterns` | architecture patterns | production runtime examples and eval harness structure | demo-specific business flow | Medium |
| `guardrails-ai/guardrails` | validation | structured output validation and guardrails | full guardrails stack unless needed | High as pattern |
| `dspy-ai/dspy` | eval/optimization | pipeline optimization and eval discipline | prompt optimizer in v1 | Medium |
| `explodinggradients/ragas` | RAG eval | RAG quality metrics | RAG-only assumptions | Medium |

## V1 Recommendation

Do not adopt a heavy framework first. Build a small TypeScript policy/router module inside this repo and keep integration points simple.

```text
v1 stack:
- rule-based router
- Zod schemas for route/worker/verifier contracts
- memory-backed route event shape
- deterministic verifier helpers
- optional direct cloud model/API adapter later
```

## What Zenos Should Build First

1. Task taxonomy and route decision schema.
2. Worker output contract with strict compression requirements.
3. Verifier result contract with pass/revise/escalate/block.
4. Route logging shape for Zenos Memory.
5. Offline smoke tests for representative requests.

## What Zenos Should Delay

- Learned router.
- Cloud control plane.
- Full model gateway/proxy.
- Always-on multi-agent pipeline.
- Heavy graph orchestration framework.
