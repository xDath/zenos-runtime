# Zenos Runtime Quality Amplification Roadmap

**Status:** Draft for implementation planning  
**Goal:** Reduce premium host tokens while making cheaper worker models more useful, reliable, and measurable under premium-host supervision.

## Core Thesis

Cheap models do not need to become as smart as the host. They need to become excellent at bounded, checkable, structured work.

The premium host remains the judge, planner, user-facing synthesizer, and risk owner. Cheap workers become force multipliers by preparing better evidence, smaller context, candidate answers, checks, and classifications.

```text
Bad pattern:
raw context -> premium host does everything

Better pattern:
raw context -> cheap workers extract/clean/classify/summarize -> premium host judges -> verifier checks -> answer
```

The result should follow host quality because the host controls:

- task decomposition;
- worker prompt templates;
- evidence requirements;
- acceptance criteria;
- verifier rules;
- final synthesis.

## Success Metrics

Zenos Runtime should prove improvement with measurable outcomes:

- lower premium input tokens per completed task;
- equal or better final answer quality;
- higher source-grounding rate;
- lower hallucination/unsupported-claim rate;
- lower rework rate for coding/research tasks;
- lower cost per successful task;
- known escalation rate from cheap workers to premium host.

## Runtime vs Memory Boundary

```text
Zenos Runtime
- routes tasks;
- decomposes work;
- calls host/worker/verifier models;
- compresses context;
- enforces schemas and policy;
- measures token/cost/quality outcomes.

Zenos Memory
- stores durable context;
- recalls project/user facts;
- stores route events and eval outcomes;
- stores learned model/task performance;
- does not own orchestration decisions.
```

Runtime may call Memory, but Runtime must remain a standalone orchestration layer.

## Quality Amplification Strategy

### 1. Constrain Cheap Workers

Cheap workers fail when asked to reason broadly. They improve when tasks are narrow and output is strictly shaped.

Worker task families:

```text
extract       -> pull facts, APIs, errors, names, paths, dates
summarize     -> compress long source into decision-grade bullets
classify      -> label task type, risk, affected area, confidence
compare       -> diff two contracts/logs/files semantically
normalize     -> convert messy text into schema
validate      -> check formatting, citations, required sections
draft         -> produce candidate text that host may accept/rewrite
```

Every worker call must include:

- exact role;
- bounded input;
- schema-only output;
- evidence fields;
- confidence fields;
- explicit non-goals;
- max output size.

### 2. Make Workers Evidence-First

Workers should not return vibes. They should return compact claims with evidence.

```json
{
  "claim": "The runtime endpoint is now /api/runtime/run",
  "evidence": ["app/api/runtime/run/route.ts", "README.md"],
  "confidence": 0.93,
  "risk": "low"
}
```

The host can then decide quickly without reading full raw context.

### 3. Use Multi-Pass Cheap Work Before Premium Judgment

For large tasks, one cheap worker is often worse than several narrow cheap passes.

Recommended pattern:

```text
Pass A: deterministic extraction / chunking
Pass B: cheap worker summaries per chunk
Pass C: cheap worker merge into structured brief
Pass D: premium host reads brief and decides
Pass E: verifier checks final answer/action
```

This spends more cheap tokens to save premium tokens and preserve host attention.

### 4. Calibrate Workers by Task Type

Runtime should keep a performance table by task type and model tier.

```text
task_type             cheap_ok?    needs_verifier?    notes
summarization         yes          sometimes          require evidence bullets
schema_normalization  yes          deterministic      zod validation catches issues
coding_change         partial      yes                worker proposes, host edits
security              no final     yes/premium        worker extracts only
deploy                no final     premium            worker checklist only
```

Over time, route decisions should use stored outcomes from Zenos Memory:

- which cheap model works for log compression;
- which worker prompt fails on coding diffs;
- when verifier catches issues;
- when premium escalation was needed.

### 5. Add Verifier as Cheap-Model Safety Net

A cheap verifier can catch many cheap-worker errors if the check is simple.

Verifier checks:

- follows user request;
- source-grounded;
- secrets not exposed;
- action safe;
- validation/tests mentioned;
- output matches schema;
- unresolved assumptions listed.

Premium verifier is only needed for high-risk decisions.

### 6. Teach Workers Through Templates, Not Fine-Tuning First

Immediate quality gains should come from runtime-level scaffolding:

- prompt templates per task family;
- few-shot examples for good and bad outputs;
- schema validation and retries;
- confidence thresholds;
- host feedback stored as route events;
- eval cases for regressions.

Fine-tuning can come later, after enough route events and failures are collected.

## Pipeline Designs

### Pipeline A: Cheap Context Compressor

Use for long files/logs/research.

```text
input chunks -> worker summary per chunk -> merge summary -> host final
```

Required output:

- top findings;
- evidence references;
- contradictions;
- unknowns;
- raw sections host should inspect if needed.

### Pipeline B: Cheap Classifier + Router

Use before selecting expensive path.

```text
request -> cheap classifier -> rule router -> host confirms or overrides
```

Cheap classifier can suggest:

- task type;
- risk;
- source dependency;
- expected tools;
- whether worker/verifier is useful.

Router remains deterministic at first; cheap classifier is advisory.

### Pipeline C: Worker Draft, Host Rewrite

Use for low/medium-risk text generation.

```text
worker draft -> verifier/schema check -> host rewrite/final
```

The worker saves host tokens by producing structure, not final authority.

### Pipeline D: Coding Assistant Brief

Use for codebase tasks.

```text
tools inspect files -> worker extracts change map -> host edits -> tests -> verifier checks diff
```

Worker should produce:

- affected files;
- relevant symbols;
- likely change points;
- risks;
- suggested tests.

Worker should not apply patches unless explicitly allowed.

### Pipeline E: Runtime Learning Loop

Use after every meaningful task.

```text
route decision + model calls + verifier verdict + final outcome -> route event -> Zenos Memory
```

Later routing uses these records to avoid repeating bad cheap-model choices.

## Implementation Phases

### Phase 1: Standalone Runtime Cleanup

- Keep `/api/runtime/*` as canonical namespace.
- Remove lingering `/api/memory/runtime/*` docs from Runtime repo.
- Keep Zenos Memory only as remote dependency.
- Validate smoke, lint, build.

### Phase 2: Worker Template Registry

Implement reusable worker templates:

- summarizer;
- extractor;
- classifier;
- comparator;
- coding brief;
- schema normalizer;
- checklist generator.

Each template defines:

- input contract;
- output schema;
- model tier;
- max tokens;
- retry policy;
- verifier policy.

### Phase 3: Context Chunker + Merger

Add deterministic chunking before worker calls:

- max chunk tokens;
- overlap policy;
- source labels;
- dedupe repeated lines;
- secret redaction before external model calls.

Add worker merge pass with strict budget.

### Phase 4: Worker Eval Harness

Create eval cases for cheap workers:

- log summarization accuracy;
- API contract extraction;
- code change map quality;
- security redaction;
- schema compliance;
- unsupported claim detection.

Track:

- pass rate;
- schema failure rate;
- retry rate;
- host override rate;
- verifier catch rate.

### Phase 5: Verifier Integration

Add verifier policies:

```text
low risk      -> no verifier or cheap deterministic verifier
medium risk   -> cheap verifier
high risk     -> cheap verifier + host review
critical risk -> premium verifier or user confirmation
```

Verifier output must decide:

- answer;
- revise;
- ask user;
- escalate;
- block.

### Phase 6: Memory-Backed Routing

Persist route outcomes to Zenos Memory:

- task type;
- chosen model tier;
- worker template;
- verifier verdict;
- errors;
- premium tokens avoided;
- final success/failure.

Recall these records before routing similar tasks.

### Phase 7: Host Integration

Expose Runtime to Hermes/Codex as a small client:

- `runtime route` before complex work;
- `runtime compress` before feeding large context to host;
- `runtime verify` before risky final answer/action;
- `runtime event` after completion.

Do not replace Hermes tools.

### Phase 8: Policy Dashboard Later

Only after core runtime works:

- route metrics;
- model leaderboard by task type;
- cost report;
- verifier catch report;
- prompt/template version history.

## Cheap Worker Prompt Rules

Every worker prompt should include:

```text
You are a bounded worker, not the final agent.
Return only the requested JSON schema.
Use evidence references for every important claim.
Say unknown when evidence is missing.
Do not make risky decisions.
Do not expose secrets.
Keep output short.
```

## Host Prompt Rules

Host should receive:

- user request;
- route decision;
- worker result;
- evidence references;
- verifier result if any;
- selected raw snippets only when needed.

Host should not receive:

- full raw logs by default;
- all worker intermediate chatter;
- duplicate chunks;
- low-confidence claims without labels.

## Why This Improves Lower-Tier Models

Lower-tier models improve operationally because Runtime changes the environment around them:

- narrow tasks reduce reasoning load;
- schemas reduce rambling;
- evidence fields reduce hallucination;
- retries repair formatting failures;
- verifier catches weak outputs;
- host only trusts claims with confidence/evidence;
- memory learns which worker/model/template combinations work.

The cheap model does not become smarter internally. The system makes its useful behavior easier and its bad behavior less dangerous.

## Near-Term Definition of Done

The next implementation pass is done when:

- Runtime repo is standalone and validates cleanly;
- worker template registry exists;
- chunked worker compression exists;
- verifier policy is wired into `/api/runtime/run`;
- route events can persist to Zenos Memory remotely;
- smoke tests cover cheap-worker quality amplification;
- README clearly separates Runtime from Memory;
- no `/api/memory/runtime/*` routes remain in Runtime.
