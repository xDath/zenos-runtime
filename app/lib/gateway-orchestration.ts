import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  RouteDecision,
  RouteDecisionSchema,
  RuntimeContextSchema,
  VerifierResult,
  WorkerResult,
  WorkerResultSchema,
  choosePipeline,
} from './zenos-runtime';
import {
  RuntimeModelResult,
  RuntimeRunRequestSchema,
  callRuntimeModel,
  runBossReviewModel,
  runHostRevision,
  runVerifier,
  runWorkerCompression,
} from './zenos-runtime-executor';
import {
  completeRuntimeSession,
  createRuntimeSession,
  getRuntimeSession,
  reconcileStaleRuntimeSessions,
  updateRuntimeSession,
} from './zenos-runtime-three-agent';
import { BossDecision, BossDecisionSchema } from './zenos-runtime-state';
import { getRuntimeStore } from './zenos-runtime-store';
import { createTokenBudgetPlan, estimateTokenCount, truncateToTokenBudget } from './token-economy';
import {
  bootstrapMemoryContext,
  compactMemoryHandoff,
  MemoryCoverage,
  recallMemoryContext,
} from './zenos-memory-client';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  renderRepositoryContext,
} from './repository-intelligence';

const GatewayModelIdentitySchema = z.object({
  model: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(200),
});

const GatewayContextMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().max(24_000),
  name: z.string().trim().max(200).optional(),
  tool_call_id: z.string().trim().max(500).optional(),
});

export const GatewayTurnPreflightRequestSchema = RuntimeContextSchema.extend({
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  platform: z.string().trim().min(1).max(80).default('gateway'),
  host: GatewayModelIdentitySchema,
  context: z.string().max(120_000).optional().default(''),
  handoffMessages: z.array(GatewayContextMessageSchema).max(400).optional().default([]),
  workspaceRoot: z.string().trim().min(1).max(4_096).optional(),
  approvalGranted: z.boolean().optional().default(false),
  modelOverrides: z.object({
    baseUrl: z.string().trim().min(1).optional(),
    apiKey: z.string().trim().min(1).optional(),
    hostModel: z.string().trim().min(1).optional(),
    hostProvider: z.string().trim().min(1).optional(),
    workerModel: z.string().trim().min(1).optional(),
    workerProvider: z.string().trim().min(1).optional(),
    bossModel: z.string().trim().min(1).optional(),
    bossProvider: z.string().trim().min(1).optional(),
    verifierModel: z.string().trim().min(1).optional(),
    verifierProvider: z.string().trim().min(1).optional(),
  }).optional().default({}),
});

export const GatewayTurnPostflightRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(220),
  runId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  draft: z.string().max(200_000),
  host: GatewayModelIdentitySchema,
  toolSummary: z.string().max(80_000).optional().default(''),
  failed: z.boolean().optional().default(false),
  hostUsage: z.object({
    inputTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().default(0),
    calls: z.number().int().nonnegative().max(500).default(1),
  }).optional().default({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 1,
  }),
  hostDurationMs: z.number().int().nonnegative().max(86_400_000).optional().default(0),
});

const GatewayHostPlanSchema = z.object({
  intentSummary: z.string().trim().min(1).max(4_000),
  useWorker: z.boolean(),
  workerTask: z.string().trim().max(8_000).default(''),
  useVerifier: z.boolean(),
  useBoss: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(10).default([]),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(10).default([]),
});

type GatewayHostPlan = z.infer<typeof GatewayHostPlanSchema>;

type GatewayMemoryBrief = {
  context: string;
  source: 'none' | 'handoff' | 'recall' | 'bootstrap';
  coverage?: MemoryCoverage;
  degraded?: boolean;
  cacheHit?: boolean;
  latencyMs?: number;
};

const StoredGatewayPreflightSchema = z.object({
  kind: z.literal('gateway_preflight_v1'),
  input: RuntimeRunRequestSchema,
  turnId: z.string(),
  platform: z.string(),
  host: GatewayModelIdentitySchema,
  hostPlan: GatewayHostPlanSchema.optional(),
  hostPlanCall: z.unknown().optional(),
  workerResult: WorkerResultSchema.optional(),
  workerCall: z.unknown().optional(),
  bossPreflight: BossDecisionSchema.optional(),
  bossCall: z.unknown().optional(),
  repositoryContext: z.string().optional(),
  holdFinalDelivery: z.boolean(),
});

type GatewayTurnPreflightRequest = z.output<typeof GatewayTurnPreflightRequestSchema>;
type GatewayTurnPreflightInput = z.input<typeof GatewayTurnPreflightRequestSchema>;
type GatewayTurnPostflightInput = z.input<typeof GatewayTurnPostflightRequestSchema>;
type StoredGatewayPreflight = z.infer<typeof StoredGatewayPreflightSchema>;

export type GatewayTurnReceipt = {
  pipeline: RouteDecision['pipelineMode'];
  host: { model: string; provider: string; invoked: boolean; plannerInvoked?: boolean; calls?: number };
  worker: { model?: string; provider?: string; invoked: boolean; ok?: boolean };
  verifier: { model?: string; provider?: string; invoked: boolean; verdict?: string; ok?: boolean };
  boss: { model?: string; provider?: string; invoked: boolean; verdict?: string; ok?: boolean };
  transformed: boolean;
};

function now(): string {
  return new Date().toISOString();
}

function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ensureGatewaySession(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  decision: RouteDecision,
  runId: string,
  metadata: Record<string, unknown>,
): void {
  const current = getRuntimeSession(input.sessionId || '');
  if (!current) {
    createRuntimeSession(input, {
      sessionId: input.sessionId,
      modelOverrides: input.modelOverrides,
      metadata: { createdBy: 'hermes-native-gateway', ...metadata },
    });
  }
  const session = getRuntimeSession(input.sessionId || '');
  if (!session) throw new Error('Failed to create Runtime gateway session');
  getRuntimeStore().saveSession({
    ...session,
    userGoal: input.request,
    status: 'working',
    routeDecision: decision,
    activeRunId: runId,
    finalAnswer: undefined,
    lastError: undefined,
    metadata: { ...session.metadata, createdBy: 'hermes-native-gateway', ...metadata },
    version: session.version + 1,
    updatedAt: now(),
  });
}

function recordActivity(
  sessionId: string,
  role: 'host' | 'worker' | 'verifier' | 'boss' | 'tool',
  summary: string,
  metadata: Record<string, unknown>,
  outcome: 'queued' | 'started' | 'success' | 'failed' | 'skipped' = 'success',
): void {
  getRuntimeStore().insertEvent({
    sessionId,
    workerId: `gateway-${role}`,
    type: outcome === 'failed' ? 'error' : 'progress',
    summary,
    evidence: [],
    severity: 'low',
    confidence: outcome === 'failed' ? 0 : 1,
    needsBoss: false,
    metadata: { role, outcome, ...metadata },
    createdAt: now(),
  });
}

function callIdentity(call?: RuntimeModelResult): { model?: string; provider?: string; invoked: boolean; ok?: boolean } {
  return call
    ? { model: call.model, provider: call.provider, invoked: true, ok: call.ok }
    : { invoked: false };
}

function modelCallTokens(call: RuntimeModelResult): number {
  const usage = call.usage;
  if (!usage) return 0;
  return Math.max(0, Math.round(
    usage.totalTokens
      || usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + usage.outputTokens,
  ));
}

function accountGatewayModelUsage(
  sessionId: string,
  calls: RuntimeModelResult[],
  hostUsage: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    calls: number;
  },
): void {
  const session = getRuntimeSession(sessionId);
  if (!session) return;
  const byRole = (role: RuntimeModelResult['role']) => calls
    .filter((call) => call.role === role)
    .reduce((sum, call) => sum + modelCallTokens(call), 0);
  const hermesHostTokens = Math.max(0, Math.round(
    hostUsage.inputTokens
      + hostUsage.cacheReadTokens
      + hostUsage.cacheWriteTokens
      + hostUsage.outputTokens,
  ));
  updateRuntimeSession(sessionId, {
    budget: {
      ...session.budget,
      premiumTokensUsed: session.budget.premiumTokensUsed + byRole('boss'),
      hostTokensUsed: session.budget.hostTokensUsed + hermesHostTokens + byRole('host'),
      workerTokensUsed: session.budget.workerTokensUsed + byRole('worker'),
      verifierTokensUsed: session.budget.verifierTokensUsed + byRole('verifier'),
      modelCallsUsed: session.budget.modelCallsUsed + Math.max(0, hostUsage.calls) + calls.length,
    },
  });
}

function gatewayHostCallCount(
  calls: RuntimeModelResult[],
  hostUsage: { calls: number },
): number {
  return Math.max(0, hostUsage.calls) + calls.filter((call) => call.role === 'host').length;
}

function compactWorkerBrief(worker?: WorkerResult): string {
  if (!worker) return '';
  const findings = worker.findings.slice(0, 8).map((finding) =>
    `- ${finding.claim} [confidence=${finding.confidence.toFixed(2)}; evidence=${finding.evidence.join(', ') || 'none'}]`,
  );
  return [
    'Worker summary:',
    ...worker.summary.slice(0, 8).map((item) => `- ${item}`),
    findings.length ? 'Evidence-backed findings:' : '',
    ...findings,
    worker.contradictions.length ? `Contradictions: ${worker.contradictions.join('; ')}` : '',
    worker.unknowns.length ? `Unknowns: ${worker.unknowns.join('; ')}` : '',
    worker.needsHostAttention.length ? `Host attention: ${worker.needsHostAttention.join('; ')}` : '',
    `Suggested next step: ${worker.suggestedNextStep}`,
  ].filter(Boolean).join('\n');
}

function compactBossGuardrails(boss?: BossDecision): string {
  if (!boss) return '';
  return [
    `Boss preflight verdict: ${boss.verdict} (${boss.confidence.toFixed(2)})`,
    `Reason: ${boss.reasoningSummary}`,
    boss.allowedActions.length ? `Allowed actions: ${boss.allowedActions.join('; ')}` : '',
    boss.forbiddenActions.length ? `Forbidden actions: ${boss.forbiddenActions.join('; ')}` : '',
    boss.requiredChanges.length ? `Required changes: ${boss.requiredChanges.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

function renderHostContext(
  decision: RouteDecision,
  hostPlan: GatewayHostPlan | undefined,
  worker: WorkerResult | undefined,
  boss: BossDecision | undefined,
  memory: GatewayMemoryBrief,
  runId: string,
): string {
  return [
    '[Zenos Runtime native turn brief — internal execution context]',
    `Run: ${runId}`,
    `Route: ${decision.pipelineMode}; task=${decision.taskType}; risk=${decision.risk}`,
    `Roles required: worker=${decision.useWorker}; verifier=${decision.useVerifier}; boss=${decision.useBoss}`,
    compactHostPlan(hostPlan),
    decision.useWorker ? '' : 'Worker skipped by Host orchestration and safety policy.',
    decision.useVerifier ? '' : 'Verifier skipped by Host orchestration and safety policy.',
    decision.useBoss ? '' : 'Boss skipped by Host orchestration and safety policy.',
    `Route reasons: ${decision.reasons.join('; ')}`,
    memory.context ? truncateToTokenBudget(memory.context, 3_000, '\n[MEMORY CONTEXT TRUNCATED]') : '',
    memory.coverage && !memory.coverage.complete
      ? 'Memory handoff coverage is partial. Preserve the recent raw conversation tail and retrieve archived evidence before relying on missing details.'
      : '',
    compactWorkerBrief(worker),
    compactBossGuardrails(boss),
    'Use this brief as bounded supporting context. Do not claim a tool, file, test, or source was inspected unless Hermes actually inspected it during this turn.',
    'The user-facing response must not reveal raw internal packets unless the user explicitly asks for execution details.',
  ].filter(Boolean).join('\n\n');
}

async function repositoryContextFor(input: GatewayTurnPreflightRequest, decision: RouteDecision): Promise<string> {
  if (!input.workspaceRoot || !decision.useTools) return '';
  if (!['repo_question', 'coding_change', 'debugging', 'security_or_secret'].includes(decision.taskType)) return '';
  try {
    const index = await buildRepositoryIndex(input.workspaceRoot);
    return renderRepositoryContext(index, analyzeChangeImpact(index));
  } catch (error) {
    return `Repository intelligence unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
}

async function gatewayMemoryContextFor(
  request: GatewayTurnPreflightRequest,
  decision: RouteDecision,
  existingSession: boolean,
): Promise<GatewayMemoryBrief> {
  const namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  const softLimit = Math.max(40_000, Number(process.env.ZENOS_HOST_CONTEXT_SOFT_LIMIT_TOKENS || 160_000));
  const underPressure = request.estimatedContextTokens >= softLimit;
  const hasHandoffSource = request.handoffMessages.length >= 4;

  if (underPressure && hasHandoffSource) {
    const compact = await compactMemoryHandoff({
      messages: request.handoffMessages,
      namespace,
      sessionId: request.sessionId,
      conversationId: request.turnId,
      approxTokens: request.estimatedContextTokens,
      maxChars: 10_000,
      inputMaxChars: 240_000,
      reason: 'hermes-host-working-set-pressure',
    });
    if (compact.ok && compact.value?.context) {
      let context = compact.value.context;
      if (decision.taskType === 'memory_question') {
        const recalled = await recallMemoryContext({
          query: request.request,
          namespace,
          limit: Math.max(4, decision.maxMemoryItems),
          maxChars: 5_000,
        });
        if (recalled.ok && recalled.value) context = `${context}\n\n${recalled.value}`;
      }
      return {
        context: truncateToTokenBudget(context, 4_000, '\n[MEMORY BRIEF TRUNCATED]'),
        source: 'handoff',
        coverage: compact.value.coverage,
        degraded: compact.degraded,
        cacheHit: compact.cacheHit,
        latencyMs: compact.latencyMs,
      };
    }
  }

  if (!decision.useMemory) return { context: '', source: 'none' };

  if (!existingSession) {
    const bootstrap = await bootstrapMemoryContext({
      namespace,
      queries: [request.request, 'current active project goal decisions blockers pending work'],
      limit: Math.max(8, decision.maxMemoryItems),
      maxChars: 6_000,
    });
    if (bootstrap.ok && bootstrap.value) {
      return {
        context: bootstrap.value,
        source: 'bootstrap',
        degraded: bootstrap.degraded,
        cacheHit: bootstrap.cacheHit,
        latencyMs: bootstrap.latencyMs,
      };
    }
  }

  const recalled = await recallMemoryContext({
    query: request.request,
    namespace,
    limit: Math.max(1, decision.maxMemoryItems),
    maxChars: 8_000,
  });
  if (recalled.ok && recalled.value) {
    return {
      context: recalled.value,
      source: 'recall',
      degraded: recalled.degraded,
      cacheHit: recalled.cacheHit,
      latencyMs: recalled.latencyMs,
    };
  }
  return { context: '', source: 'none', degraded: true, latencyMs: recalled.latencyMs };
}

function safeBossDecision(call: RuntimeModelResult): BossDecision | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = BossDecisionSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

function safeHostPlan(call: RuntimeModelResult): GatewayHostPlan | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = GatewayHostPlanSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

function needsHostPlanning(request: GatewayTurnPreflightRequest, decision: RouteDecision): boolean {
  if (request.userRequestedBoss || request.userRequestedVerification) return true;
  if (decision.risk === 'high' || decision.risk === 'critical' || request.confidence < 0.7) return true;
  if (['planning_or_architecture', 'summarization', 'eval_or_benchmark', 'security_or_secret', 'deploy_or_destructive_action'].includes(decision.taskType)) return true;
  if (decision.useWorker && !['repo_question', 'coding_change', 'debugging'].includes(decision.taskType)) return true;
  return false;
}

function pipelineForHostPlan(
  decision: RouteDecision,
  plan: GatewayHostPlan,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const safetyVerifier = request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const safetyBoss = request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  const useWorker = plan.useWorker;
  const useVerifier = safetyVerifier || plan.useVerifier;
  const useBoss = safetyBoss || plan.useBoss;
  const pipelineMode: RouteDecision['pipelineMode'] = useBoss
    ? 'escalated_deep_path'
    : useVerifier
      ? 'verified_path'
      : useWorker
        ? 'worker_compression_path'
        : decision.useTools || decision.useMemory
          ? 'grounded_path'
          : 'direct_fast_path';

  return RouteDecisionSchema.parse({
    ...decision,
    pipelineMode,
    useWorker,
    useVerifier,
    useBoss,
    allowEscalation: decision.allowEscalation || useBoss || plan.confidence < 0.55,
    workerTier: useWorker ? (decision.workerTier === 'none' ? 'standard' : decision.workerTier) : 'none',
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    maxWorkerCalls: useWorker ? Math.max(1, decision.maxWorkerCalls) : 0,
    maxRevisionAttempts: useVerifier ? Math.max(1, decision.maxRevisionAttempts) : 0,
    reasons: [
      ...decision.reasons,
      `host-plan:${plan.rationale}`,
      useWorker ? 'Host delegated bounded work to Worker' : 'Host retained the task without Worker delegation',
      useBoss ? 'Boss authority requested by Host or mandatory safety policy' : 'Boss not required by Host or safety policy',
    ],
  });
}

function hostPlanningFallback(
  decision: RouteDecision,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const useVerifier = request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const useBoss = request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  return RouteDecisionSchema.parse({
    ...decision,
    useWorker: false,
    workerTier: 'none',
    maxWorkerCalls: 0,
    useVerifier,
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    useBoss,
    allowEscalation: decision.allowEscalation || useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : decision.useTools || decision.useMemory
          ? 'grounded_path'
          : 'direct_fast_path',
    reasons: [
      ...decision.reasons,
      'Host planner unavailable; Worker delegation disabled rather than letting Worker lead the turn',
    ],
  });
}

async function runGatewayHostPlanning(
  request: GatewayTurnPreflightRequest,
  input: z.infer<typeof RuntimeRunRequestSchema>,
  baseline: RouteDecision,
  repositoryContext: string,
  memory: GatewayMemoryBrief,
  runId: string,
): Promise<{ plan?: GatewayHostPlan; call?: RuntimeModelResult; decision: RouteDecision }> {
  if (!needsHostPlanning(request, baseline)) return { decision: baseline };

  const complexPlanner = baseline.risk === 'high'
    || baseline.risk === 'critical'
    || baseline.taskType === 'planning_or_architecture'
    || request.estimatedContextTokens >= 40_000;
  const plannerPromptTokens = estimateTokenCount([
    request.request,
    request.context.slice(-12_000),
    repositoryContext.slice(0, 16_000),
    memory.context.slice(0, 10_000),
  ].join('\n\n'));

  const call = await callRuntimeModel('host', [
    {
      role: 'system',
      content: `You are the Zenos Host Planner, the primary brain and orchestrator for this user turn.
Understand the user's goal before any Worker or Boss is invoked. Do not answer the user yet.
Delegate to Worker only for bounded inspection, evidence extraction, compression, or implementation support.
Use Verifier when independent checking materially improves reliability.
Boss is the highest decision authority, but invoke Boss only for explicit user requests, critical/high-stakes uncertainty, unresolved conflict, or when your confidence is genuinely insufficient.
Return ONLY JSON matching:
{"intentSummary":"...","useWorker":true,"workerTask":"...","useVerifier":false,"useBoss":false,"confidence":0.0,"rationale":"...","acceptanceCriteria":["..."],"constraints":["..."]}`,
    },
    {
      role: 'user',
      content: `User request:\n${request.request}\n\nDeterministic safety baseline:\n${JSON.stringify(baseline)}\n\nConversation context (bounded):\n${request.context.slice(-12_000) || '(none)'}\n\nDurable Memory context (bounded):\n${memory.context.slice(0, 10_000) || '(none)'}\n\nRepository context (bounded):\n${repositoryContext.slice(0, 16_000) || '(none)'}\n\nChoose the minimum sufficient delegation while keeping Host responsible for the final decision.`,
    },
  ], {
    json: true,
    maxTokens: complexPlanner ? 600 : 400,
    maxInputTokens: complexPlanner
      ? 6_000
      : Math.max(1_800, Math.min(3_500, plannerPromptTokens + 500)),
    sessionId: request.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: `${runId}:gateway-host-plan`,
    trigger: 'host_planning',
  });
  const plan = safeHostPlan(call);
  return {
    plan,
    call,
    decision: plan
      ? pipelineForHostPlan(baseline, plan, request)
      : hostPlanningFallback(baseline, request),
  };
}

function compactHostPlan(plan?: GatewayHostPlan): string {
  if (!plan) return '';
  return [
    `Host intent: ${plan.intentSummary}`,
    `Host orchestration: worker=${plan.useWorker}; verifier=${plan.useVerifier}; boss=${plan.useBoss}; confidence=${plan.confidence.toFixed(2)}`,
    plan.workerTask ? `Worker delegation: ${plan.workerTask}` : '',
    plan.acceptanceCriteria.length ? `Acceptance criteria: ${plan.acceptanceCriteria.join('; ')}` : '',
    plan.constraints.length ? `Constraints: ${plan.constraints.join('; ')}` : '',
    `Host rationale: ${plan.rationale}`,
  ].filter(Boolean).join('\n');
}

export async function preflightGatewayTurn(raw: GatewayTurnPreflightInput) {
  const request = GatewayTurnPreflightRequestSchema.parse(raw);
  reconcileStaleRuntimeSessions({ excludeSessionId: request.sessionId });
  const runId = `gateway_${crypto.randomUUID()}`;
  const baselineDecision = choosePipeline(request);
  let decision = baselineDecision;
  const existingSession = Boolean(getRuntimeSession(request.sessionId));
  const [repositoryContext, memoryBrief] = await Promise.all([
    repositoryContextFor(request, baselineDecision),
    gatewayMemoryContextFor(request, baselineDecision, existingSession),
  ]);
  const input = RuntimeRunRequestSchema.parse({
    ...request,
    sessionId: request.sessionId,
    persistSession: true,
    context: [request.context, repositoryContext].filter(Boolean).join('\n\n'),
    memoryContext: memoryBrief.context,
    toolContext: repositoryContext,
    namespace: 'zenos',
    autoRecallMemory: false,
    persistRouteEvent: false,
    tokenPriority: 'balanced',
    approvalGranted: request.approvalGranted,
    dryRun: false,
    modelOverrides: request.modelOverrides,
    autonomousCoding: false,
    includeExecutionReceipt: false,
  });

  ensureGatewaySession(input, baselineDecision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
    memorySource: memoryBrief.source,
    memoryCoverageComplete: memoryBrief.coverage?.complete,
  });
  const store = getRuntimeStore();
  recordActivity(
    request.sessionId,
    'tool',
    memoryBrief.source === 'none'
      ? 'Zenos Memory context was not required or was unavailable for this turn.'
      : `Zenos Memory supplied bounded ${memoryBrief.source} context.`,
    {
      subsystem: 'zenos-memory',
      runId,
      turnId: request.turnId,
      source: memoryBrief.source,
      coverage: memoryBrief.coverage,
      degraded: memoryBrief.degraded,
      cacheHit: memoryBrief.cacheHit,
      latencyMs: memoryBrief.latencyMs,
    },
    memoryBrief.source === 'none' ? 'skipped' : 'success',
  );
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    errors: [],
    startedAt: now(),
  });
  recordActivity(
    request.sessionId,
    'host',
    `Hermes Host ${request.host.model} owns the turn and is preparing orchestration.`,
    {
      lifecycle: 'role_state',
      runId,
      turnId: request.turnId,
      role: 'host',
      status: 'queued',
      model: request.host.model,
      provider: request.host.provider,
    },
    'queued',
  );

  const hostPlanning = await runGatewayHostPlanning(
    request,
    input,
    baselineDecision,
    repositoryContext,
    memoryBrief,
    runId,
  );
  const hostPlan = hostPlanning.plan;
  const hostPlanCall = hostPlanning.call;
  decision = hostPlanning.decision;
  ensureGatewaySession(input, decision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
    orchestration: hostPlan ? 'host-led' : 'deterministic-fallback',
    hostPlanConfidence: hostPlan?.confidence,
  });
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    errors: hostPlanCall && !hostPlan ? ['Host planning failed; deterministic safety route retained'] : [],
    startedAt: now(),
  });
  const budget = createTokenBudgetPlan(decision, input, { userPriority: input.tokenPriority });

  let workerResult: WorkerResult | undefined;
  let workerCall: RuntimeModelResult | undefined;
  if (decision.useWorker) {
    const worker = await runWorkerCompression(input, undefined, {
      pass: 1,
      totalPasses: 1,
      requestId: `${runId}:gateway-worker:1`,
      budget,
      delegationTask: hostPlan?.workerTask,
      acceptanceCriteria: hostPlan?.acceptanceCriteria,
      constraints: hostPlan?.constraints,
    });
    workerResult = worker.result;
    workerCall = worker.call;
    recordActivity(
      request.sessionId,
      'worker',
      worker.result
        ? `Worker ${worker.call.model} produced a bounded execution brief.`
        : `Worker ${worker.call.model || 'unknown'} failed to produce a valid brief.`,
      {
        runId,
        turnId: request.turnId,
        model: worker.call.model,
        provider: worker.call.provider,
        modelUsage: worker.call.usage,
      },
      worker.result ? 'success' : 'failed',
    );
  } else {
    recordActivity(
      request.sessionId,
      'worker',
      'Worker skipped by Host orchestration and safety policy.',
      { runId, turnId: request.turnId },
      'skipped',
    );
  }

  let bossPreflight: BossDecision | undefined;
  let bossCall: RuntimeModelResult | undefined;
  if (decision.useBoss || decision.requiresApproval) {
    bossCall = await runBossReviewModel({
      stage: 'preflight',
      runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      userGoal: input.request,
      decision,
      approvalGranted: request.approvalGranted,
      hostPlan,
      workerResult,
      host: request.host,
    }, {
      sessionId: request.sessionId,
      modelOverrides: input.modelOverrides,
      requestId: `${runId}:gateway-boss-preflight`,
      maxInputTokens: 1_800,
      maxOutputTokens: 600,
      trigger: request.userRequestedBoss ? 'user_requested_boss' : 'host_or_safety_escalation',
    });
    bossPreflight = safeBossDecision(bossCall);
    recordActivity(
      request.sessionId,
      'boss',
      bossPreflight
        ? `Boss ${bossCall.model} returned preflight verdict ${bossPreflight.verdict}.`
        : `Boss ${bossCall.model || 'unknown'} preflight failed.`,
      {
        runId,
        turnId: request.turnId,
        model: bossCall.model,
        provider: bossCall.provider,
        verdict: bossPreflight?.verdict,
        modelUsage: bossCall.usage,
      },
      bossPreflight ? 'success' : 'failed',
    );
  } else {
    recordActivity(
      request.sessionId,
      'boss',
      'Boss skipped because Host and safety policy did not require highest-authority review.',
      { runId, turnId: request.turnId },
      'skipped',
    );
  }

  const hostCallId = `${runId}:hermes-host`;
  recordActivity(
    request.sessionId,
    'host',
    `Hermes Host ${request.host.model} started the user-facing turn.`,
    {
      lifecycle: 'model_call',
      runId,
      turnId: request.turnId,
      callId: hostCallId,
      role: 'host',
      status: 'calling',
      model: request.host.model,
      provider: request.host.provider,
      trigger: 'host_final_synthesis',
    },
    'started',
  );

  const holdFinalDelivery = decision.useVerifier || decision.useBoss || decision.requiresApproval;
  const stored: StoredGatewayPreflight = {
    kind: 'gateway_preflight_v1',
    input,
    turnId: request.turnId,
    platform: request.platform,
    host: request.host,
    hostPlan,
    hostPlanCall,
    workerResult,
    workerCall,
    bossPreflight,
    bossCall,
    repositoryContext: repositoryContext || undefined,
    holdFinalDelivery,
  };
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    result: stored,
    errors: [],
    startedAt: now(),
  });

  return {
    ok: true,
    runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    decision,
    holdFinalDelivery,
    hostContext: renderHostContext(decision, hostPlan, workerResult, bossPreflight, memoryBrief, runId),
    receipt: {
      pipeline: decision.pipelineMode,
      host: {
        ...request.host,
        invoked: true,
        plannerInvoked: Boolean(hostPlanCall),
        calls: hostPlanCall ? 2 : 1,
      },
      worker: callIdentity(workerCall),
      verifier: { invoked: false },
      boss: { ...callIdentity(bossCall), verdict: bossPreflight?.verdict },
      transformed: false,
    } satisfies GatewayTurnReceipt,
  };
}

function blockedAnswer(reason: string, requiredChanges: string[] = []): string {
  return [
    `Gue belum bisa melanjutkan hasil itu karena Runtime memblokirnya: ${reason}`,
    requiredChanges.length ? `Yang perlu dibereskan dulu: ${requiredChanges.join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function askUserAnswer(reason: string, requiredChanges: string[] = []): string {
  return [
    `Sebelum lanjut, gue butuh konfirmasi atau detail tambahan: ${reason}`,
    requiredChanges.length ? requiredChanges.join('; ') : '',
  ].filter(Boolean).join('\n\n');
}

export async function postflightGatewayTurn(raw: GatewayTurnPostflightInput) {
  const request = GatewayTurnPostflightRequestSchema.parse(raw);
  const store = getRuntimeStore();
  const run = store.getRun(request.runId);
  if (!run || run.sessionId !== request.sessionId) throw new Error('Gateway Runtime run was not found for this session');
  const decision = RouteDecisionSchema.parse(run.decision);
  const stored = StoredGatewayPreflightSchema.parse(run.result);
  const input = RuntimeRunRequestSchema.parse({
    ...stored.input,
    sessionId: request.sessionId,
    toolContext: [
      stored.input.toolContext,
      stored.hostPlan ? `Host orchestration plan:\n${compactHostPlan(stored.hostPlan)}` : '',
      request.toolSummary,
    ].filter(Boolean).join('\n\n'),
  });
  const budget = createTokenBudgetPlan(decision, input, { userPriority: input.tokenPriority });
  const calls: RuntimeModelResult[] = [];
  if (stored.hostPlanCall) {
    const parsed = stored.hostPlanCall as RuntimeModelResult;
    if (parsed.role === 'host') calls.push(parsed);
  }
  if (stored.workerCall) {
    const parsed = stored.workerCall as RuntimeModelResult;
    if (parsed.role === 'worker') calls.push(parsed);
  }
  if (stored.bossCall) {
    const parsed = stored.bossCall as RuntimeModelResult;
    if (parsed.role === 'boss') calls.push(parsed);
  }

  recordActivity(
    request.sessionId,
    'host',
    request.failed
      ? `Hermes Host ${request.host.model} failed turn ${request.turnId}.`
      : `Hermes Host ${request.host.model} completed a candidate response.`,
    {
      runId: request.runId,
      turnId: request.turnId,
      model: request.host.model,
      provider: request.host.provider,
      lifecycle: 'model_call',
      callId: `${request.runId}:hermes-host`,
      status: request.failed ? 'failed' : 'completed',
      modelUsage: {
        inputTokens: request.hostUsage.inputTokens,
        cacheReadTokens: request.hostUsage.cacheReadTokens,
        cacheWriteTokens: request.hostUsage.cacheWriteTokens,
        outputTokens: request.hostUsage.outputTokens,
        reasoningTokens: request.hostUsage.reasoningTokens,
        calls: request.hostUsage.calls,
        totalTokens: request.hostUsage.inputTokens
          + request.hostUsage.cacheReadTokens
          + request.hostUsage.cacheWriteTokens
          + request.hostUsage.outputTokens,
        estimated: false,
      },
      latencyMs: request.hostDurationMs,
    },
    request.failed ? 'failed' : 'success',
  );

  if (request.failed) {
    accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
    store.saveRun({
      ...run,
      status: 'failed',
      result: { ...stored, finalAnswer: request.draft, failed: true },
      errors: ['Hermes Host reported a failed turn'],
      completedAt: now(),
    });
    updateRuntimeSession(request.sessionId, { status: 'failed', lastError: 'Hermes Host reported a failed turn', activeRunId: undefined });
    return {
      ok: false,
      finalAnswer: request.draft,
      transformed: false,
      receipt: {
        pipeline: decision.pipelineMode,
        host: {
          ...request.host,
          invoked: true,
          plannerInvoked: Boolean(stored.hostPlanCall),
          calls: gatewayHostCallCount(calls, request.hostUsage),
        },
        worker: callIdentity(calls.find((call) => call.role === 'worker')),
        verifier: { invoked: false },
        boss: { ...callIdentity(calls.find((call) => call.role === 'boss')), verdict: stored.bossPreflight?.verdict },
        transformed: false,
      } satisfies GatewayTurnReceipt,
    };
  }

  let finalAnswer = request.draft;
  let transformed = false;
  let verifierResult: VerifierResult | undefined;
  let verifierCall: RuntimeModelResult | undefined;
  let bossDecision = stored.bossPreflight;
  let bossCall = calls.find((call) => call.role === 'boss');

  if (decision.useVerifier) {
    const verifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:1`,
      budget,
    });
    verifierResult = verifier.result;
    verifierCall = verifier.call;
    calls.push(verifier.call);
    recordActivity(
      request.sessionId,
      'verifier',
      verifier.result
        ? `Verifier ${verifier.call.model} returned ${verifier.result.verdict}.`
        : `Verifier ${verifier.call.model || 'unknown'} failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: verifier.call.model,
        provider: verifier.call.provider,
        verdict: verifier.result?.verdict,
        modelUsage: verifier.call.usage,
      },
      verifier.result ? 'success' : 'failed',
    );

    if (verifier.result?.verdict === 'revise') {
      const fixes = verifier.result.issues.map((issue) => issue.requiredFix || issue.issue).filter(Boolean);
      const revision = await runHostRevision(input, finalAnswer, fixes, stored.workerResult, {
        requestId: `${request.runId}:gateway-host-revision:1`,
        budget,
      });
      calls.push(revision);
      if (revision.ok && revision.content) {
        finalAnswer = revision.content;
        transformed = finalAnswer !== request.draft;
        recordActivity(
          request.sessionId,
          'host',
          `Runtime Host ${revision.model} revised the Hermes draft from verifier feedback.`,
          {
            runId: request.runId,
            turnId: request.turnId,
            model: revision.model,
            provider: revision.provider,
            revision: 1,
            modelUsage: revision.usage,
          },
        );
      }
    } else if (verifier.result?.verdict === 'block') {
      finalAnswer = blockedAnswer(
        verifier.result.issues.map((issue) => issue.issue).join('; ') || 'verifier safety gate failed',
        verifier.result.issues.map((issue) => issue.requiredFix).filter(Boolean),
      );
      transformed = true;
    }
  } else {
    recordActivity(
      request.sessionId,
      'verifier',
      'Verifier skipped by Host orchestration and safety policy.',
      { runId: request.runId, turnId: request.turnId },
      'skipped',
    );
  }

  const shouldRunBoss = decision.requiresApproval
    || verifierResult?.verdict === 'escalate'
    || (decision.useBoss && decision.risk === 'critical' && !input.userRequestedBoss);
  if (shouldRunBoss) {
    const finalBossCall = await runBossReviewModel({
      stage: 'postflight',
      runId: request.runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      userGoal: input.request,
      decision,
      currentDraft: finalAnswer,
      hostPlan: stored.hostPlan,
      workerResult: stored.workerResult,
      verifierResult,
      toolSummary: request.toolSummary,
      preflightDecision: stored.bossPreflight,
    }, {
      sessionId: request.sessionId,
      modelOverrides: input.modelOverrides,
      requestId: `${request.runId}:gateway-boss-postflight`,
      maxInputTokens: 2_400,
      maxOutputTokens: 700,
      trigger: verifierResult?.verdict === 'escalate' ? 'verifier_escalation' : 'critical_postflight_authority',
    });
    calls.push(finalBossCall);
    const parsedBoss = safeBossDecision(finalBossCall);
    if (parsedBoss) {
      bossDecision = parsedBoss;
      bossCall = finalBossCall;
    }
    recordActivity(
      request.sessionId,
      'boss',
      parsedBoss
        ? `Boss ${finalBossCall.model} returned postflight verdict ${parsedBoss.verdict}.`
        : `Boss ${finalBossCall.model || 'unknown'} postflight failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: finalBossCall.model,
        provider: finalBossCall.provider,
        verdict: parsedBoss?.verdict,
        modelUsage: finalBossCall.usage,
      },
      parsedBoss ? 'success' : 'failed',
    );

    if (parsedBoss?.verdict === 'revise') {
      const revision = await runHostRevision(input, finalAnswer, parsedBoss.requiredChanges, stored.workerResult, {
        requestId: `${request.runId}:gateway-host-boss-revision`,
        budget,
      });
      calls.push(revision);
      if (revision.ok && revision.content) {
        finalAnswer = revision.content;
        transformed = finalAnswer !== request.draft;
        recordActivity(
          request.sessionId,
          'host',
          `Runtime Host ${revision.model} revised the draft from Boss feedback.`,
          {
            runId: request.runId,
            turnId: request.turnId,
            model: revision.model,
            provider: revision.provider,
            revision: 1,
            modelUsage: revision.usage,
          },
        );
      }
    } else if (parsedBoss?.verdict === 'block') {
      finalAnswer = blockedAnswer(parsedBoss.reasoningSummary, parsedBoss.requiredChanges);
      transformed = true;
    } else if (parsedBoss?.verdict === 'ask_user') {
      finalAnswer = askUserAnswer(parsedBoss.reasoningSummary, parsedBoss.requiredChanges);
      transformed = true;
    } else if (parsedBoss?.verdict === 'delegate') {
      finalAnswer = askUserAnswer(
        'Runtime menilai bukti yang tersedia belum cukup untuk jawaban final.',
        parsedBoss.requiredChanges,
      );
      transformed = true;
    }
  }

  if (transformed && decision.useVerifier && verifierResult?.verdict === 'revise') {
    const finalVerifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:final`,
      budget,
    });
    calls.push(finalVerifier.call);
    if (finalVerifier.result) verifierResult = finalVerifier.result;
    recordActivity(
      request.sessionId,
      'verifier',
      finalVerifier.result
        ? `Final Verifier ${finalVerifier.call.model} returned ${finalVerifier.result.verdict}.`
        : `Final Verifier ${finalVerifier.call.model || 'unknown'} failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: finalVerifier.call.model,
        provider: finalVerifier.call.provider,
        verdict: finalVerifier.result?.verdict,
        modelUsage: finalVerifier.call.usage,
      },
      finalVerifier.result ? 'success' : 'failed',
    );
    if (finalVerifier.result?.verdict === 'block') {
      finalAnswer = blockedAnswer(
        finalVerifier.result.issues.map((issue) => issue.issue).join('; ') || 'final verification failed',
        finalVerifier.result.issues.map((issue) => issue.requiredFix).filter(Boolean),
      );
      transformed = true;
    }
  }

  const receipt: GatewayTurnReceipt = {
    pipeline: decision.pipelineMode,
    host: {
      ...request.host,
      invoked: true,
      plannerInvoked: Boolean(stored.hostPlanCall),
      calls: gatewayHostCallCount(calls, request.hostUsage),
    },
    worker: callIdentity(calls.find((call) => call.role === 'worker')),
    verifier: {
      ...callIdentity(verifierCall || [...calls].reverse().find((call) => call.role === 'verifier')),
      verdict: verifierResult?.verdict,
    },
    boss: {
      ...callIdentity(bossCall || [...calls].reverse().find((call) => call.role === 'boss')),
      verdict: bossDecision?.verdict,
    },
    transformed,
  };

  store.saveRun({
    ...run,
    status: bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block' ? 'blocked' : 'done',
    result: {
      preflight: stored,
      finalAnswer,
      verifierResult,
      bossDecision,
      receipt,
      modelCalls: calls,
    },
    errors: [],
    completedAt: now(),
  });
  accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
  completeRuntimeSession(request.sessionId, finalAnswer);

  return {
    ok: true,
    finalAnswer,
    transformed,
    receipt,
    verifier: verifierResult,
    boss: bossDecision,
  };
}
