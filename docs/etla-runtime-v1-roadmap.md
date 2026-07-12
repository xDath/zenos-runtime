# Etla Runtime v1 Roadmap

**Status:** Canonical implementation roadmap  
**Project:** Etla Runtime v1  
**Runtime base:** Zenos Runtime  
**Primary objective:** Deliver a Codex-class agentic workflow while minimizing premium-model usage and amplifying lower-tier models through context engineering, tools, skills, validation, memory, and adaptive execution.

---

## 1. Mission

Etla Runtime v1 is an intelligence operating system for heterogeneous LLMs.

It must make inexpensive models productive, predictable, and comfortable inside a structured environment while reserving expensive models for rare, high-value judgment.

The system optimizes for:

```text
lowest total cost per successfully completed task
```

It does not optimize merely for the cheapest token or the fewest model calls.

### Core outcomes

1. Premium-tier Boss usage is rare and compact.
2. Lower-tier models complete most routine work.
3. Every model receives only relevant, role-specific context.
4. Tools and deterministic validators replace model guessing wherever possible.
5. Coding workflows support inspect, plan, edit, test, revise, and verify loops.
6. Zenos Memory remains fully cloud-hosted and keeps all current capabilities.
7. Zenos Memory may receive additive Runtime-specific APIs and namespaces.
8. Heavy builds, calibration, evaluation, and optimization run outside the VPS.
9. The VPS remains the local execution authority and stays responsive.
10. The ecosystem improves from measured outcomes rather than intuition alone.

---

## 2. Product Positioning

```text
Hermes         = user interaction and local agent environment
9Router        = model/provider access layer
Etla Runtime   = execution intelligence and orchestration
Zenos Memory   = durable context, continuity, and learned knowledge
Runtime Lab    = cloud evaluation and optimization plane
```

Etla Runtime is not merely a router between models. It is responsible for:

- compiling context;
- decomposing work;
- selecting skills and tools;
- supervising lower-tier models;
- validating outputs;
- controlling risk;
- managing budgets;
- deciding escalation;
- learning from observable outcomes.

---

## 3. Non-Negotiable Design Principles

### 3.1 Tools before tokens

Use deterministic systems whenever a fact can be measured or verified directly.

```text
File existence       -> repository index
Symbol references    -> parser/index
Code correctness     -> tests/typecheck/lint/build
JSON correctness     -> schema validation
Service health       -> process and health checks
Patch impact         -> diff and dependency analysis
Current state        -> tool evidence, not model assumptions
```

### 3.2 Cheap first, premium last

```text
Tier 0 deterministic compute
    -> Tier 1 lower-tier model
    -> Tier 2 standard model
    -> Tier 3 premium Boss only when justified
```

### 3.3 Boss is a judge, not an expensive worker

The Boss must not normally:

- read full repositories;
- inspect raw logs;
- summarize long tool output;
- generate boilerplate;
- repair schemas;
- perform broad retrieval;
- recreate work already completed by Workers or tools.

The Boss receives a compact, evidence-backed decision packet and returns a bounded verdict.

### 3.4 Context is compiled, not dumped

Models receive work packets, not raw collections of memory, chat, files, logs, and agent messages.

### 3.5 Lower-tier models get a supported environment

A lower-tier model should receive:

- one bounded task;
- explicit goal;
- relevant facts;
- relevant source snippets;
- selected procedure or skill;
- tool contracts;
- output schema;
- forbidden actions;
- acceptance criteria;
- precise failure feedback.

### 3.6 Every token must justify its presence

Stable prompts, retrieved context, source snippets, and intermediate messages must be measured and pruned.

### 3.7 Heavy work never competes with production services unnecessarily

Full builds, large test matrices, model calibration, prompt optimization, and large-scale analytics should run in GitHub Actions, Vercel, or another approved remote compute environment.

### 3.8 Zenos Memory upgrades are additive

Runtime-specific Memory features may be added, but existing cloud memory functions must remain operational and backward-compatible.

---

## 4. Target Architecture

```text
User / Hermes
      |
      v
Request Normalizer
      |
      v
Task Classifier + Risk Policy
      |
      v
Token Economy Engine
      |
      v
Runtime Context Compiler
      |\
      | \-- Zenos Memory Cloud
      |     - recall
      |     - bootstrap
      |     - compact
      |     - Runtime context API
      |     - skills/profiles/lessons
      |
      +---- Repository Intelligence
      +---- Session and task state
      +---- Tool evidence
      +---- Local outcome history
      |
      v
Skill Selector + Execution Planner
      |
      v
Tool Broker + Lower-tier Workers
      |
      v
Host Synthesis
      |
      v
Deterministic Validation
      |
      v
Verifier
      |\
      | \-- pass -> final
      | \-- revise -> bounded retry
      | \-- delegate -> more tool/worker evidence
      | \-- escalate -> compact Boss packet
      |
      v
Premium Boss, only when required
```

### Execution planes

```text
VPS Runtime Core
- hot path
- local tools
- repository/filesystem access
- task state
- routing
- budget control
- local cache
- approval and safety

Zenos Memory Cloud
- durable memory
- hybrid recall
- lifecycle and conflict handling
- Runtime-specific durable knowledge
- optional cloud context preprocessing

Runtime Lab on Vercel
- calibration
- prompt evaluation
- skill benchmarking
- trace distillation
- routing simulation
- candidate comparison

GitHub Actions
- installs
- typecheck
- lint
- tests
- production builds
- audit
- matrix evaluations
- remote full validation
```

---

## 5. Model Hierarchy

### Tier 0: Deterministic compute

No LLM usage.

Responsibilities:

- routing rules;
- schema validation;
- token accounting;
- cache lookup;
- repository indexing;
- symbol resolution;
- source selection;
- diff inspection;
- test execution;
- lint/typecheck/build;
- secret scanning;
- policy enforcement;
- retry and timeout logic.

### Tier 1: Lower-tier models

Primary workforce.

Responsibilities:

- classification;
- extraction;
- bounded planning;
- file relevance ranking;
- log summarization;
- simple patches;
- structured transformations;
- candidate generation;
- low-risk tool argument generation.

### Tier 2: Standard models

Responsibilities:

- synthesis;
- medium-complexity debugging;
- architecture within bounded scope;
- verification of non-deterministic qualities;
- resolving moderate conflicts;
- revising failed lower-tier outputs.

### Tier 3: Premium Boss

Responsibilities:

- high-risk judgment;
- unresolved conflicts;
- production-impacting decisions;
- security-sensitive decisions;
- destructive or irreversible actions;
- major architecture decisions;
- repeated failures where cheaper recovery is exhausted.

---

## 6. Token Economy Engine

The Token Economy Engine is the first major capability of Etla Runtime v1.

### 6.1 Dynamic budgets

Each run receives a budget based on:

- task family;
- risk;
- source size;
- target model capability;
- historical pass rate;
- skill complexity;
- validation availability;
- prior retries;
- user priority.

Example:

```json
{
  "total_tokens": 16000,
  "worker_tokens": 4500,
  "host_tokens": 4000,
  "verifier_tokens": 2500,
  "boss_tokens": 1000,
  "reserve_tokens": 4000
}
```

### 6.2 Hard role limits

Every role receives explicit maximums for:

- input context;
- output tokens;
- retries;
- concurrent calls;
- total cost;
- elapsed time.

### 6.3 Delta revisions

A retry receives only:

```text
previous candidate
failed checks
relevant evidence
required correction
```

It must not receive the entire original context unless a full reset is explicitly justified.

### 6.4 Early stopping

A pipeline ends when:

- acceptance criteria pass;
- deterministic checks pass;
- no unresolved critical issue exists;
- confidence is above policy threshold;
- escalation is unnecessary.

### 6.5 Boss token minimization

Boss input target:

```text
500-1500 tokens
```

Boss output target:

```text
100-500 tokens
```

Boss packet schema:

```json
{
  "decision_required": "...",
  "risk": "high",
  "facts": [],
  "conflicts": [],
  "unknowns": [],
  "options": [],
  "host_recommendation": "...",
  "verifier_concern": "...",
  "required_output": {
    "verdict": "approve|revise|block|delegate",
    "required_changes": []
  }
}
```

### 6.6 Output discipline

Workers, Host, Verifier, and Boss use concise structured schemas for internal communication. Prose is reserved for the final user-facing response where appropriate.

---

## 7. Multi-Layer Caching

Etla Runtime should cache all stable and safely reusable computations.

### Cache classes

1. Request result cache.
2. Memory recall cache.
3. Context packet cache.
4. Repository search cache.
5. Symbol and reference cache.
6. Tool result cache.
7. Validation cache.
8. Model classification cache.
9. Prompt-prefix cache where provider support exists.
10. Skill bundle and model profile cache.

### Cache key requirements

```text
request hash
workspace revision
memory revision
model identifier
prompt version
skill version
tool version
policy version
```

No cache result may be reused when its dependency revision is stale.

---

## 8. Runtime Context Compiler

The Runtime Context Compiler converts raw information into model-specific work packets.

### Inputs

- user request;
- current session state;
- Zenos Memory recall;
- repository index;
- selected source chunks;
- tool evidence;
- selected skill;
- target role;
- target model profile;
- token budget.

### Canonical work packet

```json
{
  "goal": "...",
  "task_family": "...",
  "constraints": [],
  "verified_facts": [],
  "relevant_files": [],
  "procedures": [],
  "previous_failures": [],
  "unknowns": [],
  "contradictions": [],
  "acceptance_criteria": [],
  "forbidden_actions": [],
  "evidence_map": []
}
```

### Compiler responsibilities

- deduplicate context;
- remove stale data;
- retain provenance;
- filter low-confidence claims;
- redact secrets;
- identify contradictions;
- preserve unknowns;
- rank evidence;
- enforce token budget;
- shape context by model and role;
- produce a deterministic fallback when cloud or LLM compression is unavailable.

### Role-specific packets

#### Worker packet

- exact subtask;
- relevant files and snippets;
- procedure;
- required output schema;
- acceptance criteria;
- forbidden behavior.

#### Host packet

- user intent;
- worker findings;
- evidence summary;
- trade-offs;
- unresolved unknowns;
- budget state.

#### Verifier packet

- original requirements;
- claims in candidate output;
- evidence map;
- deterministic results;
- validation rubric.

#### Boss packet

- one decision;
- critical facts;
- risk;
- conflicts;
- options;
- recommendation.

---

## 9. Repository Intelligence Layer

To reach a Codex-class workflow, Runtime must understand repositories without repeatedly asking models to rediscover structure.

### Required indexes

- file map;
- language map;
- symbol definitions;
- symbol references;
- import graph;
- dependency graph;
- package scripts;
- configuration map;
- test-to-source relationships;
- service topology;
- recent Git change summary;
- file hash and revision metadata.

### Incremental indexing

Only changed files and affected relationships should be re-indexed.

### Change impact analysis

Before applying a patch, Runtime should produce:

```json
{
  "changed_symbols": [],
  "direct_dependents": [],
  "related_tests": [],
  "risk": "low|medium|high"
}
```

### Token benefit

Models receive selected definitions, references, and affected tests instead of whole files or broad repository dumps.

---

## 10. Tool Broker

Runtime owns local tool execution and evidence generation.

### Initial tool families

```text
repo.search
repo.read
repo.symbol
repo.references
repo.diff
repo.patch

test.run
typecheck.run
lint.run
build.run

service.status
service.logs
service.restart
port.inspect

browser.fetch
browser.search

json.validate
schema.validate
secret.scan
```

### Tool contract

```json
{
  "name": "test.run",
  "risk": "read_only",
  "timeout_ms": 120000,
  "requires_approval": false,
  "cacheable": true,
  "produces_evidence": true,
  "input_schema": {},
  "output_schema": {}
}
```

### Normalized evidence

Raw output remains in local artifacts. Models receive normalized summaries.

```json
{
  "tool": "typecheck.run",
  "status": "failed",
  "exit_code": 2,
  "errors": [
    {
      "file": "app/lib/auth.ts",
      "line": 128,
      "code": "TS2339",
      "message": "Property exp does not exist"
    }
  ],
  "raw_artifact_id": "tool-output-123"
}
```

### Risk and approval

Tools are classified as:

- read-only;
- reversible write;
- irreversible/destructive;
- production-impacting;
- secret-sensitive.

Runtime enforces approval before unsafe actions.

---

## 11. Codex-Class Coding Loop

```text
Understand
-> inspect
-> plan
-> patch
-> targeted validation
-> analyze failure
-> revise
-> full validation
-> summarize
```

### Persistent task state

Each coding task records:

- task ID;
- workspace revision;
- files inspected;
- files changed;
- assumptions;
- tools called;
- tests run;
- failures;
- checkpoints;
- unresolved risks;
- token and cost usage.

### Checkpoint and rollback

Before significant edits:

- capture baseline diff;
- record affected files;
- establish rollback point;
- define expected validation.

### Minimal patch policy

Runtime should reject or flag patches that:

- modify unrelated files;
- disable checks;
- delete tests to obtain a pass;
- introduce unjustified dependencies;
- change public APIs without approval;
- expand scope without evidence.

### Validation ladder

```text
syntax/schema
-> targeted test
-> affected typecheck/lint
-> package test
-> full build or remote validation when required
```

---

## 12. Skill System

Skills make lower-tier models more reliable by providing proven procedures.

### Skill layout

```text
skills/
  fix-typescript-bug/
  fix-runtime-error/
  investigate-service/
  review-authentication/
  implement-api-route/
  refactor-module/
  upgrade-dependency/
  deploy-nextjs/
  review-pull-request/
  research-topic/
```

### Skill schema

```yaml
name: fix-typescript-bug
required_context:
  - compiler error
  - affected symbol
  - related callers
  - related tests
steps:
  - reproduce
  - inspect
  - design smallest correction
  - patch
  - run targeted validation
  - run typecheck
success_criteria:
  - original error resolved
  - related tests pass
  - no public API regression
forbidden:
  - ignoreBuildErrors
  - deleting tests
  - unbounded any casts
```

### Runtime behavior

- select no more than three relevant skills;
- prefer one primary skill;
- inject only relevant steps;
- validate skill preconditions;
- track skill success locally;
- version every skill;
- support rollback to prior versions.

---

## 13. Candidate Generation and Deterministic Selection

For testable outputs, two inexpensive candidates may be cheaper than one premium attempt.

```text
candidate A
candidate B
    -> deterministic validation
    -> choose valid/best candidate
```

Enable only when:

- the task is testable;
- the lower-tier model is inexpensive;
- confidence is low;
- total estimated cost remains below escalation cost;
- candidate isolation is safe.

---

## 14. Failure-Specific Recovery

Do not escalate every failure to a more expensive model.

### Invalid JSON

```text
schema repair
-> regenerate invalid fields only
-> cheap repair model
-> escalate only if repeated
```

### Invalid tool arguments

```text
validate arguments
-> regenerate arguments only
```

### Missing evidence

```text
run additional retrieval/tool step
```

### Failed test

```text
send failure delta + relevant code to Worker
```

### Excessive context

```text
compress low-priority sections
preserve constraints, evidence, and acceptance criteria
```

### Reasoning conflict

```text
Verifier
-> standard-model revision
-> Boss only if unresolved or high-risk
```

---

## 15. Model Calibration and Capability Profiles

Every model exposed through 9Router should be calibrated before receiving a major role.

### Evaluation dimensions

- instruction following;
- JSON reliability;
- coding success;
- debugging success;
- source utilization;
- tool selection;
- tool argument accuracy;
- self-correction;
- Indonesian quality;
- long-context degradation;
- latency;
- token use;
- cost.

### Capability profile

```json
{
  "model": "build",
  "recommended_roles": ["worker"],
  "json_reliability": 0.94,
  "coding_success": 0.82,
  "tool_accuracy": 0.78,
  "source_utilization": 0.73,
  "preferred_context_tokens": 2400,
  "effective_context_limit": 12000,
  "known_failures": []
}
```

### Compute location

Calibration runs in:

- GitHub Actions for repository and build-oriented evaluations;
- Vercel Runtime Lab for API/model-oriented workflows;
- another approved remote compute system when Vercel limits are insufficient.

The VPS imports only validated profile artifacts.

---

## 16. Adaptive Router

Safety rules remain deterministic. Performance optimization is layered on top.

### Outcome fields

- task family;
- selected model;
- skill version;
- prompt version;
- context size;
- tool sequence;
- validation outcome;
- revision count;
- latency;
- token usage;
- cost;
- final success;
- user correction.

### Routing objective

```text
cheapest model with acceptable predicted probability of success
```

### Example ladder

```text
Build
-> bounded retry with failure delta
-> Grok or standard model
-> compact Boss escalation only when policy requires it
```

### Guardrails

- do not route high-risk actions solely from learned statistics;
- do not auto-promote a model after a small sample;
- maintain minimum evaluation sample sizes;
- retain deterministic fallbacks;
- support immediate rollback of model profiles and policies.

---

## 17. Prompt Registry

Prompts are versioned by role and model.

```text
prompts/
  worker/build/v1
  worker/grok/v1
  host/grok/v1
  verifier/grok/v1
  boss/codex/v1
```

### Prompt metadata

- prompt ID;
- role;
- compatible models;
- schema pass rate;
- evidence score;
- average token use;
- known failures;
- status: candidate, active, deprecated, rollback.

### Promotion flow

```text
candidate prompt
-> offline evaluation
-> comparison against active prompt
-> quality gate
-> controlled promotion
-> monitored rollout
-> rollback when regression appears
```

---

## 18. Local Outcome Store

Raw Runtime telemetry remains local first.

### SQLite tables or equivalent entities

- runs;
- execution steps;
- model calls;
- tool calls;
- context packets;
- validations;
- failures;
- revisions;
- costs;
- user corrections;
- route decisions;
- prompt and skill versions.

Do not store private chain-of-thought. Store observable inputs, outputs, decisions, tool evidence, and outcomes.

---

## 19. Zenos Memory Integration

Zenos Memory remains fully cloud-hosted with Vercel compute and Google Drive canonical storage.

### Existing functions that must remain intact

- remember;
- recall;
- hybrid recall;
- bootstrap;
- compact;
- lifecycle;
- conflict handling;
- graph projection;
- backup and recovery;
- scoped authentication;
- secret rejection;
- current SDK and Hermes integration.

### Additive Runtime namespaces

```text
runtime.models
runtime.skills
runtime.failures
runtime.prompts
runtime.tools
runtime.architecture
runtime.learning
```

### Additive Runtime APIs

Potential versioned endpoints:

```text
POST /api/memory/runtime/context
GET  /api/memory/runtime/skills
POST /api/memory/runtime/skills/promote
GET  /api/memory/runtime/models
POST /api/memory/runtime/learning/distill
GET  /api/memory/runtime/bundle
```

### Runtime Context API

Memory may perform durable-knowledge retrieval and return a typed packet:

```json
{
  "facts": [],
  "procedures": [],
  "decisions": [],
  "previous_failures": [],
  "constraints": [],
  "contradictions": [],
  "sources": []
}
```

Runtime merges this with local source and tool evidence.

### Resilience

- Runtime keeps a local cache of the latest valid skill/model bundle.
- Memory timeout must not block low-risk tasks.
- Memory outage activates degraded mode.
- Runtime must never invent recalled knowledge.
- New Runtime APIs are feature-flagged and backward-compatible.

---

## 20. Learning Bridge

Raw Runtime events must not be written to Zenos Memory one by one.

### Flow

```text
50-100 local outcomes
-> Runtime Lab distillation
-> candidate lessons
-> deterministic/Verifier quality gate
-> 1-5 durable records
-> Zenos Memory runtime.learning
```

### Durable records

- repeated failure patterns;
- reliable procedures;
- model weaknesses;
- tool limitations;
- routing lessons;
- prompt evaluation results;
- architecture decisions.

---

## 21. Remote Compute Strategy

The VPS currently has constrained RAM and swap. Etla Runtime v1 must treat remote compute as a first-class architecture requirement.

### VPS responsibilities

- hot-path routing;
- local tools;
- repository access;
- task state;
- lightweight indexing;
- targeted checks;
- local cache;
- safety and approval;
- active model orchestration.

### Vercel Runtime Lab responsibilities

- context compression when expensive;
- model API evaluation;
- prompt comparison;
- skill benchmarking;
- failure clustering;
- trace distillation;
- routing simulation;
- resumable cloud workflows.

### GitHub Actions responsibilities

- dependency installation;
- typecheck;
- lint;
- unit and integration tests;
- production builds;
- security audit;
- benchmark matrices;
- remote coding validation;
- branch and commit comparison.

### Remote coding validation flow

```text
Runtime creates isolated task branch/commit
-> pushes to private GitHub branch
-> GitHub Actions runs full quality gate
-> optional Vercel preview deployment
-> Runtime reads structured result
-> promotion or merge only after pass
```

### Local resource governor

Every local command must support:

- timeout;
- process priority;
- concurrency limit;
- memory-aware scheduling;
- kill and cleanup;
- cancellation;
- output truncation with retained raw artifact.

---

## 22. Security and Safety

### Required controls

- explicit tool risk levels;
- approvals for destructive or production actions;
- scoped Memory tokens;
- secret redaction;
- raw credential rejection;
- signed or checksummed cloud artifacts;
- isolated remote branches;
- no unreviewed production merges;
- audit records for model, tool, and policy decisions;
- fail-closed behavior for critical validation.

### Prohibited shortcuts

Token savings must not be achieved by:

- disabling tests;
- suppressing type errors;
- deleting failing tests;
- bypassing approval;
- hiding validation failures;
- fabricating tool evidence;
- sending secrets to models or remote logs;
- silently modifying production.

All aggressive optimization must remain authorized, measurable, and reversible.

---

## 23. Implementation Phases

## Phase 0 — Stabilization and workload separation

### Deliverables

1. Upgrade Runtime Memory client to HMAC v2 token exchange.
2. Add scoped bearer-token cache and 401 refresh behavior.
3. Stop default per-run telemetry writes to Memory.
4. Add Memory circuit breaker and degraded mode.
5. Add local resource governor.
6. Establish GitHub Actions full Runtime quality gate.
7. Establish Vercel Runtime Lab project and deployment contract.
8. Define versioned API contracts across Runtime, Memory, and Lab.
9. Add baseline token, cost, latency, and escalation telemetry.

### Acceptance criteria

- Runtime recall works against current Zenos Memory production auth.
- Memory outage does not block low-risk Runtime tasks.
- No full production build is required on the VPS for normal development flow.
- Raw per-run Runtime telemetry is no longer sent to Memory by default.
- Resource-heavy local commands are bounded and cancellable.

---

## Phase 1 — Token Efficiency Foundation

### Deliverables

1. Token Economy Engine.
2. Dynamic per-role budgets.
3. Hard context and output caps.
4. Boss Token Minimizer.
5. Delta-context revision protocol.
6. Early stopping.
7. Multi-layer cache.
8. Structured internal schemas.
9. Token/cost dashboard and metrics.

### Acceptance criteria

- Every model call has a recorded budget and actual usage.
- Boss input never receives raw repository or log dumps by default.
- Revisions reuse delta context.
- Simple tasks skip unnecessary roles.
- Cache invalidation includes workspace, prompt, model, skill, and policy revisions.

---

## Phase 2 — Context Intelligence

### Deliverables

1. Runtime Context Compiler.
2. Canonical work-packet schema.
3. Role-specific packets.
4. Evidence and contradiction map.
5. Token-aware source selection.
6. Model-aware context shaping.
7. Deterministic compression fallback.
8. Additive Zenos Memory Runtime Context API.
9. Memory recall/context cache.

### Acceptance criteria

- Workers receive only bounded task-specific packets.
- Provenance and unknowns survive compilation.
- Context compiler remains functional without an additional LLM call.
- Runtime Context API does not modify existing Memory behavior.
- Context reduction is measured against raw input.

---

## Phase 3 — Codex Execution Core

### Deliverables

1. Repository index.
2. Symbol and reference graph.
3. Import and test relationship map.
4. Tool Broker.
5. Normalized tool evidence.
6. Persistent task state machine.
7. Checkpoints and rollback.
8. Plan-edit-validate-revise loop.
9. Targeted validation ladder.
10. Remote full validation through GitHub Actions.
11. Optional Vercel preview deployment integration.

### Acceptance criteria

- Runtime can autonomously inspect, patch, test, revise, and summarize a bounded coding task.
- Raw long logs are stored as artifacts and not injected by default.
- Changes are validated before success is declared.
- Failed patches can be rolled back.
- Full validation can execute remotely without exhausting VPS resources.

### Implementation checkpoint — 2026-07-12

Implemented and connected:

- incremental file/hash/language index with symbol definitions, references, imports, reverse dependencies, package scripts, configuration files, Git awareness, and test relationships;
- deterministic affected-file and change-risk analysis;
- real Tool Broker implementations for repository inspection/patching, validation scripts, service/port inspection, JSON/schema validation, and redacted secret scanning;
- full builds return `remote_required` through Resource Governor policy instead of consuming the VPS hot path;
- SQLite-backed coding task state, guarded phase transitions, checkpoints, approval-gated rollback, minimal-patch policy, targeted/full validation, failure-specific delta revision packets, and remote-result recording;
- Runtime pipeline compilation of repository evidence and persistent Codex task packets when a workspace root is supplied;
- approval-gated autonomous coding loop that asks the Worker for a structured plan, deterministically inspects files, applies exact `repo.patch` replacements, enforces minimal-patch policy, runs targeted/full validation, and performs bounded failure-specific revisions;
- persisted role/tool activity events, SSE `activity` delivery, a one-second SQLite watcher, safe model-slot setup wizard, dashboard model visibility, and deterministic Host execution receipts;
- native two-phase Hermes Gateway middleware: every enabled chat turn receives deterministic Runtime routing, real Worker/Boss preflight when required, bounded current-turn context injection, Verifier/Boss postflight before delivery, fail-open availability policy, verified transcript rewrite, and a user-visible role receipt;
- `/wmodel` Host write-through now updates the actual Hermes per-session Host runtime and rolls back Runtime role config when provider resolution fails, preventing control-plane drift;
- approval-gated GitHub remote-validation dispatcher with clean-worktree enforcement, isolated `etla/runtime/*` branch pushes, structured Actions job/step ingestion, bounded polling, local JSON artifacts, Codex task-state recording, and configurable branch cleanup;
- dedicated `zenos-runtime-validation.yml` workflow for typecheck, lint, tests, dependency audit, and production build on temporary Runtime branches.

Still required before Phase 3 is complete:

- end-to-end remote validation against the real GitHub repository after this workflow lands on the default branch;
- optional Vercel preview integration only for changes that benefit from an externally viewable web preview.

---

## Phase 4 — Skill Ecosystem

### Deliverables

1. Versioned local skill registry.
2. Skill selection policy.
3. Skill preconditions.
4. Acceptance criteria engine.
5. Per-skill token limits.
6. Skill performance tracking.
7. Additive Memory Runtime Skill Registry.
8. Signed/versioned bundle delivery.
9. Local fallback bundle.
10. Few-shot retrieval of successful procedures.

### Acceptance criteria

- Lower-tier Workers receive one primary procedure by default.
- Runtime continues with cached skills when Memory is unavailable.
- Skills can be promoted and rolled back.
- Skill success is measured by deterministic outcomes.

---

## Phase 5 — Model Intelligence

### Deliverables

1. Calibration datasets.
2. Model capability profiler.
3. GitHub/Vercel calibration workflows.
4. Per-model context limits.
5. Per-model prompt variants.
6. Candidate generation policy.
7. Failure-specific recovery policy.
8. Additive Memory model-profile storage.
9. Local validated profile cache.

### Acceptance criteria

- Every routed model has a capability profile.
- Calibration does not require heavy VPS computation.
- Models are prevented from roles where measured reliability is insufficient.
- Profile versions can be rolled back.

---

## Phase 6 — Adaptive Runtime

### Deliverables

1. Outcome-based routing.
2. Cost-per-success optimization.
3. Dynamic escalation thresholds.
4. Prompt registry.
5. Prompt offline evaluation.
6. Routing simulation.
7. Controlled promotion and rollback.
8. Performance drift detection.
9. Boss-use optimization.

### Acceptance criteria

- Learned routing cannot override critical safety rules.
- Model selection uses measured outcomes and minimum sample sizes.
- Prompt or route regressions trigger rollback.
- Boss calls are explainable and measurable.

---

## Phase 7 — Intelligence Bridge

### Deliverables

1. Batch outcome exporter.
2. Runtime Lab distillation pipeline.
3. Candidate lesson validation.
4. Durable failure-pattern memories.
5. Durable procedure memories.
6. Tool reliability learning.
7. Model-profile refresh.
8. Cross-session Runtime intelligence.
9. Memory namespace-scoped authorization if required.

### Acceptance criteria

- Memory receives compact lessons, not raw per-run telemetry.
- Stored lessons have evidence, provenance, confidence, and versioning.
- Runtime remains functional when the learning bridge is disabled.
- Existing personal Memory namespaces remain unaffected.

---

## 24. Target Metrics

These are roadmap targets, not current claims.

### Premium usage

```text
Boss invocation rate:
- initial target: below 10%
- mature target: 3-7%

Boss token share:
- below 5% of total Runtime model tokens
```

### Lower-tier success

```text
Cheap-only completion:
- above 80% overall
- above 90% for routine, deterministically verifiable coding tasks
```

### Validation

```text
First-pass validation:
- above 70% initially
- above 85% after calibration and skill tuning
```

### Context efficiency

```text
Context reduction versus raw input:
- 60-90% depending on task type
```

### VPS protection

```text
Full development builds on VPS:
- approach zero in normal workflow
```

### Memory hygiene

```text
Raw per-run Runtime events written to Memory:
- zero by default
- only distilled durable lessons are promoted
```

### Primary business metric

```text
total model and compute cost
--------------------------------
successfully completed tasks
```

---

## 25. Definition of Etla Runtime v1 Complete

Etla Runtime v1 is considered complete when:

1. A bounded coding task can be completed through inspect, plan, edit, test, revise, and verify without manual orchestration.
2. Lower-tier models perform most routine work using skills and structured context.
3. Premium Boss usage is rare, compact, and justified by policy.
4. Runtime can use Zenos Memory deeply without depending on Memory availability for every task.
5. Heavy quality gates and evaluations execute remotely.
6. Token, cost, latency, and success are observable end to end.
7. Model, prompt, skill, and routing changes are versioned and reversible.
8. Deterministic validation prevents unsupported success claims.
9. Existing Zenos Memory cloud functions remain intact.
10. The measured cost per successful task improves over the current Runtime baseline.

---

## 26. Immediate Build Order

When implementation begins, execute in this order:

```text
1. Phase 0 compatibility and resource protection
2. Token Economy Engine
3. Boss Token Minimizer and delta revisions
4. Runtime Context Compiler
5. Repository Intelligence
6. Tool Broker
7. Codex coding state machine
8. Remote validation pipeline
9. Skill System
10. Model Calibration
11. Adaptive Router
12. Prompt optimization
13. Intelligence Bridge with Zenos Memory
```

This order protects the VPS early, fixes current Memory compatibility, produces immediate token savings, and establishes reliable execution before adding adaptive learning.

---

## 27. Final System Model

```text
Lower-tier models = primary workforce
Tools             = source of truth
Skills            = proven operating procedures
Runtime           = manager, compiler, and execution authority
Verifier          = quality control
Boss              = rare premium judgment
Zenos Memory      = cloud continuity and durable ecosystem knowledge
Runtime Lab       = heavy evaluation and optimization compute
GitHub Actions    = remote build and validation infrastructure
```

Etla Runtime v1 succeeds when inexpensive models become effective members of a high-discipline ecosystem and premium intelligence is purchased only at the narrow points where it creates measurable value.
