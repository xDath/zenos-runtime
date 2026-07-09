# Zenos Runtime Three-Agent Roadmap

**Status:** Primary architecture direction  
**Purpose:** Minimize premium-token usage while keeping output quality high by splitting responsibilities across a medium Host/Middleman, a premium Boss, and cheap Worker pool.

## Executive Direction

Zenos Runtime should not be a single agent that does everything. It should be a supervised multi-agent runtime:

```text
User
  -> Host / Middleman Agent (medium tier, user-facing, always active)
      -> Worker Agent Pool (cheap tier, high-volume tool/context work)
      -> Boss Agent (premium tier, low-volume judgment/escalation)
  -> User
```

The goal is not to make cheap models magically smart. The goal is to make them useful under supervision:

```text
Worker output = untrusted proposal + evidence
Host output   = operational coordination + user interaction
Boss output   = premium judgment on compressed packets only
```

## Agent Roles

### 1. Host / Middleman Agent

The Host is the default user-facing runtime agent. It should usually be a medium/normal-tier model.

Responsibilities:

- talk with the user;
- classify request intent and risk;
- decide whether to answer directly, call Workers, or escalate to Boss;
- supervise Worker progress through compact events;
- compress Worker results into decision briefs;
- keep conversation continuity;
- send only high-value decision packets to Boss;
- produce final response when no premium judgment is needed.

The Host is not the most expensive model. It is the traffic controller, supervisor, and translator between user, Workers, Boss, tools, and Memory.

### 2. Boss Agent

The Boss is the premium-tier model. It should be called rarely.

Responsibilities:

- high-risk judgment;
- architecture decisions;
- ambiguous/rancu event resolution;
- security/deploy/destructive action approval;
- final review for expensive or production-impacting tasks;
- correcting Host plans when the Host is uncertain;
- deciding whether to approve, revise, block, or ask user.

Boss must never receive raw long logs/files by default. Boss receives compressed escalation packets.

Boss input shape:

```json
{
  "user_goal": "...",
  "host_assessment": "...",
  "decision_needed": "approve|revise|block|ask_user|delegate",
  "worker_findings": [
    {
      "claim": "...",
      "evidence": ["file.ts:42", "log timestamp", "url"],
      "confidence": 0.87,
      "risk": "medium"
    }
  ],
  "conflicts": ["..."],
  "unknowns": ["..."],
  "budget": {
    "premium_tokens_used": 0,
    "cheap_tokens_used": 0,
    "estimated_premium_tokens_avoided": 0
  }
}
```

### 3. Worker Agent Pool

Workers are cheap/lower-tier models, possibly many in parallel.

Responsibilities:

- browse/search/read docs;
- inspect files/logs;
- extract facts;
- summarize chunks;
- classify task/risk;
- compare APIs or diffs;
- produce coding briefs;
- generate low-risk drafts;
- run tool-heavy or context-heavy steps through the host/tool layer;
- emit compact progress events.

Workers are untrusted by default. They must return schema-constrained outputs with evidence and confidence.

Workers should spend the most total tokens because their tokens are cheap and their work is bounded.

## Core Runtime Components

```text
Runtime Router
- chooses direct Host, Worker path, Boss escalation, or verified path.

Worker Registry
- maps task families to worker templates, model tiers, budgets, and schemas.

Event Bus
- receives Worker progress/risk/findings as small structured events.

Host Supervisor
- watches Worker events, pauses bad paths, escalates suspicious events.

Boss Escalation Policy
- decides when premium Boss judgment is required.

Context Compressor
- chunks, dedupes, redacts, summarizes, and merges raw context before Host/Boss.

Quality Gate
- validates schema, evidence, confidence, and policy compliance.

Budget Manager
- tracks host, boss, worker, verifier token/cost budgets.

Memory Adapter
- stores route events, failures, model performance, and learned routing outcomes in Zenos Memory.
```

## Live Worker Supervision

The Host should not read every Worker token. That would defeat the token-saving goal.

Workers emit structured events:

```json
{
  "session_id": "runtime-session-id",
  "worker_id": "worker-2",
  "type": "finding|progress|risk|conflict|tool_result|done|error",
  "summary": "Found a destructive command in deploy script",
  "evidence": ["scripts/deploy.sh:31"],
  "severity": "high",
  "confidence": 0.91,
  "needs_boss": true
}
```

Host receives event summaries, not full raw Worker chatter.

Host actions:

```text
continue       -> Worker may proceed
pause          -> Worker stops pending review
request_more   -> Worker must provide evidence/details
reroute        -> send task to another Worker/template
escalate       -> package event for Boss
terminate      -> stop Worker path
```

## Boss Escalation Triggers

Host must escalate to Boss when any of these happen:

- security/secret/credential risk;
- destructive command or irreversible action;
- production deploy/rollback/release;
- Worker confidence is low but task is important;
- Workers disagree on facts or recommendation;
- Worker output has unsupported claims;
- source evidence is missing or weak;
- task scope changes unexpectedly;
- cost/token usage exceeds budget;
- user intent is ambiguous and consequence is high;
- tests/build fail in a non-obvious way;
- Host is uncertain about final recommendation.

Escalation packet should be short and evidence-backed. Boss should never be used as a log reader.

## Token Strategy

### Token Roles

```text
Worker tokens = high volume, cheap, bounded, evidence extraction
Host tokens   = medium volume, conversation + supervision + synthesis
Boss tokens   = lowest volume, premium judgment only
```

### Host Token Savings

Host should avoid:

- raw logs;
- full source dumps;
- repeated memory context;
- all Worker intermediate messages;
- unfiltered browser/search output;
- low-confidence unsupported claims.

Host should receive:

- route decision;
- compact Worker events;
- final Worker brief;
- top evidence pointers;
- unknowns/conflicts;
- Boss decision if escalated.

### Boss Token Savings

Boss should receive only:

- escalation packet;
- minimal source snippets;
- conflicts;
- decision requested;
- host recommendation;
- Worker evidence summary.

Boss should not be called for normal chat, trivial coding, formatting, simple summarization, or low-risk drafts.

## Worker Anti-Hallucination Policy

Cheap Workers hallucinate. Runtime must treat them as untrusted.

Rules:

```text
No evidence -> not usable.
Low confidence -> needs review.
Schema fail -> retry once, then discard/escalate.
Risky decision -> Worker cannot decide.
Contradiction -> Host resolves or escalates to Boss.
```

Worker output must include:

- claims;
- evidence;
- confidence;
- risk;
- unknowns;
- raw context needed by Host/Boss if any.

## Patterns To Borrow From Existing Ecosystem

These are design inspirations, not dependencies to copy blindly.

### LangGraph-style State Machine

Useful pattern:

- explicit nodes;
- conditional edges;
- checkpointable state;
- deterministic routing between Host, Worker, Boss, Verifier.

Zenos Runtime adaptation:

```text
route -> dispatch_workers -> collect_events -> quality_gate -> maybe_boss -> final
```

### AutoGen-style Manager/Worker Delegation

Useful pattern:

- manager agent coordinates specialist agents;
- agents can collaborate on bounded tasks.

Zenos Runtime adaptation:

- Host is manager/middleman;
- Workers are specialists;
- Boss is premium judge;
- free-form group chat is avoided because it burns tokens.

### CrewAI-style Role + Task + Expected Output

Useful pattern:

- clear role definitions;
- task descriptions;
- expected output contracts.

Zenos Runtime adaptation:

- each Worker template declares role, task, schema, evidence rules, and budget.

### LiteLLM-style Model Routing + Cost Tracking

Useful pattern:

- provider abstraction;
- model fallback;
- cost accounting;
- tier selection.

Zenos Runtime adaptation:

- choose cheap/medium/premium model by task risk;
- track premium tokens avoided;
- fallback from failed cheap Worker to stronger model only when needed.

### DSPy-style Prompt/Eval Optimization

Useful pattern:

- prompts are programs;
- measure outputs against eval cases;
- optimize templates over time.

Zenos Runtime adaptation:

- Worker templates are versioned;
- route events and evals identify bad templates;
- Memory stores learned model/template performance.

### LlamaIndex-style Chunk/Retrieval/Synthesis

Useful pattern:

- chunk raw sources;
- retrieve top-k relevant snippets;
- synthesize from compact nodes;
- cite sources.

Zenos Runtime adaptation:

- deterministic chunker + cheap summary per chunk;
- Host/Boss receives top evidence, not full context.

### OpenAI Swarm-style Handoff

Useful pattern:

- lightweight agent handoff;
- simple delegation between roles.

Zenos Runtime adaptation:

- Host can hand off specific bounded tasks to Worker templates or Boss review.

## Runtime Pipelines

### Pipeline 0: Direct Host

Use for simple, low-risk conversation.

```text
User -> Host -> User
```

No Worker, no Boss.

### Pipeline 1: Host + Worker Brief

Use for context-heavy but low/medium-risk tasks.

```text
User -> Host -> Workers -> Quality Gate -> Host -> User
```

Boss not needed unless ambiguity/risk appears.

### Pipeline 2: Host + Worker + Boss

Use for risky, ambiguous, or strategic tasks.

```text
User -> Host -> Workers -> Quality Gate -> Escalation Packet -> Boss -> Host -> User
```

Boss only sees compressed packet.

### Pipeline 3: Live Supervised Workers

Use for long-running or tool-heavy work.

```text
Host dispatches Workers
Workers emit events
Host monitors events
Host pauses/escalates on risk
Boss reviews only suspicious/high-impact packets
Host finalizes
```

### Pipeline 4: Memory-Learned Routing

Use after enough route history exists.

```text
Request -> Host/Router -> Memory recalls similar route outcomes -> choose model/template -> execute -> store outcome
```

## Schemas To Implement

### RuntimeSessionState

```ts
type RuntimeSessionState = {
  sessionId: string;
  userGoal: string;
  status: 'routing' | 'working' | 'paused' | 'boss_review' | 'finalizing' | 'done' | 'failed';
  hostModel: string;
  bossModel?: string;
  workers: WorkerLease[];
  events: WorkerEvent[];
  budget: RuntimeBudgetState;
};
```

### WorkerLease

```ts
type WorkerLease = {
  workerId: string;
  template: string;
  modelTier: 'cheap' | 'standard';
  task: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  maxTokens: number;
};
```

### WorkerEvent

```ts
type WorkerEvent = {
  sessionId: string;
  workerId: string;
  type: 'progress' | 'finding' | 'risk' | 'conflict' | 'tool_result' | 'done' | 'error';
  summary: string;
  evidence: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  needsBoss: boolean;
};
```

### EscalationPacket

```ts
type EscalationPacket = {
  sessionId: string;
  userGoal: string;
  hostAssessment: string;
  decisionNeeded: 'approve' | 'revise' | 'block' | 'ask_user' | 'delegate';
  workerFindings: WorkerFinding[];
  conflicts: string[];
  unknowns: string[];
  budget: RuntimeBudgetState;
};
```

### BossDecision

```ts
type BossDecision = {
  verdict: 'approve' | 'revise' | 'block' | 'ask_user' | 'delegate';
  confidence: number;
  reasoningSummary: string;
  requiredChanges: string[];
  allowedActions: string[];
  forbiddenActions: string[];
};
```

## API Roadmap

Current canonical endpoints:

```text
POST /api/runtime/route
POST /api/runtime/run
POST /api/runtime/route-event
GET  /api/runtime/eval
GET  /api/runtime/readiness
```

New endpoints:

```text
POST /api/runtime/session
GET  /api/runtime/session/:id
POST /api/runtime/dispatch
POST /api/runtime/worker-event
POST /api/runtime/escalate
POST /api/runtime/boss-review
POST /api/runtime/quality-gate
GET  /api/runtime/models
GET  /api/runtime/budget/:sessionId
```

## Implementation Phases

### Phase 1: Roadmap + Architecture Alignment

- Adopt Host/Middleman + Boss + Worker Pool as the primary runtime model.
- Keep `/api/runtime/*` as canonical namespace.
- Keep Zenos Memory only as remote durable context/telemetry service.
- Document borrowed ecosystem patterns and Zenos-specific adaptations.

### Phase 2: Runtime State + Event Bus

Implement:

- `runtime-agent-roles.ts`;
- `runtime-session-state.ts`;
- `runtime-event-bus.ts`;
- `WorkerEventSchema`;
- `RuntimeSessionStateSchema`.

Goal:

- Workers can emit compact events;
- Host can inspect current session state;
- no Boss call needed yet.

### Phase 3: Worker Registry + Templates

Implement templates:

- extractor;
- summarizer;
- classifier;
- comparator;
- coding brief;
- browser/research brief;
- checklist generator.

Each template defines:

- role;
- task family;
- input budget;
- output schema;
- evidence requirements;
- retry policy;
- escalation policy.

### Phase 4: Host Supervisor

Implement:

- event severity scoring;
- pause/reroute/continue decisions;
- compact Worker event feed;
- suspicious event detection;
- Host brief builder.

Goal:

- Host monitors Worker activity without consuming raw Worker chatter.

### Phase 5: Boss Escalation

Implement:

- escalation trigger rules;
- escalation packet builder;
- Boss model call;
- BossDecision schema;
- Boss decision enforcement.

Goal:

- Boss receives only compressed packets;
- premium-token usage stays minimal.

### Phase 6: Quality Gate + Anti-Hallucination

Implement:

- evidence required checks;
- confidence thresholds;
- schema retries;
- unsupported claim discard;
- deterministic checks before LLM checks;
- conflict detection across Workers.

Goal:

- cheap Worker hallucinations do not contaminate Host/Boss output.

### Phase 7: Budget Manager + Cost Tracking

Implement:

- per-session token budget;
- per-agent usage accounting;
- premium-token avoided estimate;
- stop/escalate if budget exceeded;
- model fallback policy.

Goal:

- prove Host/Boss token savings.

### Phase 8: Memory-Backed Learning

Persist to Zenos Memory:

- route decisions;
- Worker template/model used;
- Boss escalation reason;
- verifier/quality gate verdict;
- token/cost outcome;
- final success/failure;
- known bad model-template combinations.

Goal:

- Runtime improves routing over time.

### Phase 9: Eval Harness

Create evals for:

- direct Host vs Host+Worker cost;
- Worker hallucination filtering;
- Boss escalation correctness;
- live event supervision;
- coding brief quality;
- browser/research brief quality;
- memory-backed routing improvements.

### Phase 10: Integration

Integrate with Hermes/Codex lifecycle:

- route before complex work;
- dispatch Worker jobs for heavy context/tool tasks;
- stream Worker events to Host;
- escalate Boss only when needed;
- store route event after completion.

## Non-Goals

- Letting Workers freely chat with each other without budget control;
- making Boss read all raw context;
- replacing Hermes tools;
- requiring local LLM inference;
- making cheap Workers responsible for final risky decisions;
- storing raw Worker transcripts as durable memory.

## Definition of Done

Zenos Runtime v2 is successful when:

- Host/Middleman can route and supervise tasks;
- Workers can emit live compact events;
- Boss is called only through escalation packets;
- cheap Worker output is evidence-gated;
- premium Boss token usage is lower than direct premium-host baseline;
- final answer quality remains equal or better in evals;
- route outcomes are persisted to Zenos Memory;
- Runtime remains standalone from Zenos Memory.
