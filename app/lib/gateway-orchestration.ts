import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  RouteDecision,
  RouteDecisionSchema,
  VerifierResult,
  WorkerResult,
  choosePipeline,
} from './zenos-runtime';
import {
  RuntimeModelResult,
  RuntimeRunRequestSchema,
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
import { createTokenBudgetPlan, estimateTokenCount } from './token-economy';
import { authorizeTokenSpend, completeTokenBudget, settleTokenSpend, tokenGovernorSnapshot } from './token-governor';
import {
  GatewayMemoryBrief,
  GatewayTurnPostflightInput,
  GatewayTurnPostflightRequestSchema,
  GatewayTurnPreflightInput,
  GatewayTurnPreflightRequest,
  GatewayTurnPreflightRequestSchema,
  GatewayTurnReceipt,
  StoredGatewayPreflight,
  StoredGatewayPreflightSchema,
} from './gateway-contracts';
import { accountGatewayModelUsage, callIdentity, gatewayHostCallCount } from './gateway-accounting';
import { hostWorkingSetForDecision, prepareGatewayContexts } from './gateway-continuity';
import { compactHostPlan, runGatewayHostPlanning } from './gateway-planning';
import { askUserAnswer, blockedAnswer, renderHostContext } from './gateway-rendering';
import {
  LatencyObservation,
  createLatencyBudgetPlan,
  observeLatency,
  roleLatencyTimeout,
} from './latency-budget';
import { recordOutcomePassport } from './outcome-ledger';
import {
  CodingTaskState,
  prepareCodexExecution,
  recordCodexPatch,
  recordCodingValidation,
  transitionCodingTask,
  updateCodingTask,
} from './codex-execution-core';

export { GatewayTurnPostflightRequestSchema, GatewayTurnPreflightRequestSchema } from './gateway-contracts';

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

function safeBossDecision(call: RuntimeModelResult): BossDecision | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = BossDecisionSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

function memoryCoverageScore(memory: GatewayMemoryBrief): number | undefined {
  if (!memory.coverage) return undefined;
  const checks = [
    memory.coverage.goal,
    memory.coverage.decisions,
    memory.coverage.pendingWork,
    memory.coverage.questions,
    memory.coverage.artifacts,
  ];
  return checks.filter(Boolean).length / checks.length;
}

function deterministicValidationState(toolSummary: string): 'passed' | 'failed' | 'unknown' {
  const text = String(toolSummary || '').toLowerCase();
  if (!text.trim()) return 'unknown';
  const hasValidation = /\b(test|tests|lint|typecheck|build|compile|validation|pytest|vitest|jest|py_compile)\b/.test(text);
  if (!hasValidation) return 'unknown';
  if (/\b(fail(?:ed|ure)?|error|errors|non[- ]?zero|exit\s+(?:code\s*)?[1-9]|timed out|timeout)\b/.test(text)) return 'failed';
  if (/\b(pass(?:ed)?|success(?:ful)?|completed|green|exit\s+(?:code\s*)?0|0\s+errors?)\b/.test(text)) return 'passed';
  return 'unknown';
}

const CODE_ARTIFACT_PATTERN = /(?:\/[A-Za-z0-9._/-]+|\b[A-Za-z0-9._-]+)\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|sql|sh)\b/i;
const CODING_ACTIVITY_PATTERN = /\b(?:read(?:ing)?|edit(?:ing|ed)?|patch(?:ing|ed)?|write|wrote|modified|changed|implement(?:ing|ed)?|refactor(?:ing|ed)?|test(?:ing|ed)?|lint(?:ing|ed)?|build(?:ing|ed)?|compil(?:e|ing|ed)|traceback)\b/i;
const CODING_MUTATION_PATTERN = /\b(?:edit(?:ing|ed)?|patch(?:ing|ed)?|write|wrote|modified|changed|implement(?:ing|ed)?|refactor(?:ing|ed)?|repair(?:ing|ed)?|fix(?:ing|ed)?)\b/i;
const CODING_UNFINISHED_PATTERN = /\b(?:indentationerror|syntaxerror|compile\s+error|typecheck\s+error|test(?:s)?\s+failed|lint\s+failed|build\s+failed|patch\s+failed|mid[- ]patch|belum\s+(?:selesai|beres|ke-?apply|di-?apply)|unfinished|pending|blocker|next\s+turn|remaining\s+work|rollback|rusak|broken|partial)\b/i;
const CODING_COMPLETED_PATTERN = /\b(?:all\s+tests?\s+passed|tests?\s+passed|validation\s+passed|typecheck\s+passed|lint\s+passed|build\s+passed|compile\s+passed|working\s+tree\s+clean|completed\s+successfully|selesai\s+dan\s+tervalidasi)\b/i;
const CODING_FOLLOW_UP_PATTERN = /^\s*(?:tapi|dan|terus|juga|sekalian|lanjut(?:kan)?|nah|yang\s+tadi|itu|ini|gas+|soalnya)\b/i;
const MUTATING_TOOL_PATTERN = /\b(?:apply_patch|patch|edit_file|write_file|replace_in_file|str_replace|create_file|delete_file|editing|updated|modified|wrote|applied\s+patch)\b/i;
const BROKEN_CODE_PATTERN = /\b(?:indentationerror|syntaxerror|compileerror|compile\s+error|typecheck\s+error|traceback|test(?:s)?\s+failed|lint\s+failed|build\s+failed|patch\s+failed|exit\s+(?:code\s*)?[1-9])\b/i;

function lastPatternIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  let index = -1;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    index = match.index ?? index;
  }
  return index;
}

function preserveUnfinishedCodingContinuity(request: GatewayTurnPreflightRequest): GatewayTurnPreflightRequest {
  if (request.hasCodeChangeIntent || !CODING_FOLLOW_UP_PATTERN.test(request.request)) return request;
  const previous = getRuntimeSession(request.sessionId);
  const continuity = [
    request.context,
    ...request.handoffMessages.slice(-24).map((message) => message.content),
    previous?.finalAnswer || '',
    previous?.lastError || '',
  ].filter(Boolean).join('\n').slice(-40_000);
  const hasRepositoryEvidence = Boolean(request.workspaceRoot) || CODE_ARTIFACT_PATTERN.test(continuity);
  const hasCodingActivity = CODE_ARTIFACT_PATTERN.test(continuity)
    && CODING_ACTIVITY_PATTERN.test(continuity)
    && CODING_MUTATION_PATTERN.test(continuity);
  const lastUnfinished = lastPatternIndex(continuity, CODING_UNFINISHED_PATTERN);
  const lastCompleted = lastPatternIndex(continuity, CODING_COMPLETED_PATTERN);
  if (!hasRepositoryEvidence || !hasCodingActivity || lastUnfinished < 0 || lastUnfinished < lastCompleted) return request;

  return GatewayTurnPreflightRequestSchema.parse({
    ...request,
    hasFiles: true,
    hasCodeChangeIntent: true,
    userRequestedVerification: true,
    intent: request.intent === 'execute' ? 'execute' : 'mutate',
    confidence: Math.max(request.confidence, 0.9),
  });
}

function workspaceMutationObserved(
  before: GatewayTurnPreflightRequest['workspaceState'],
  after: GatewayTurnPreflightRequest['workspaceState'],
): boolean {
  if (!before || !after) return false;
  if (before.dirtyDiffSha256 !== after.dirtyDiffSha256) return true;
  const beforeFiles = new Map(before.changedFiles.map((file) => [file.path, `${file.exists}:${file.sha256 || ''}`]));
  return after.changedFiles.some((file) => beforeFiles.get(file.path) !== `${file.exists}:${file.sha256 || ''}`)
    || before.changedFiles.some((file) => !after.changedFiles.some((candidate) => candidate.path === file.path));
}

function observedCodingState(toolSummary: string): { mutated: boolean; broken: boolean } {
  const text = String(toolSummary || '');
  const hasCodeArtifact = CODE_ARTIFACT_PATTERN.test(text);
  const mutated = MUTATING_TOOL_PATTERN.test(text)
    || (hasCodeArtifact && CODING_MUTATION_PATTERN.test(text));
  return {
    mutated,
    broken: mutated && BROKEN_CODE_PATTERN.test(text),
  };
}

function postflightDecisionForObservedMutation(
  current: RouteDecision,
  input: z.infer<typeof RuntimeRunRequestSchema>,
): RouteDecision {
  const upgraded = choosePipeline(input);
  const useWorker = current.useWorker;
  const useVerifier = upgraded.useVerifier;
  const useBoss = upgraded.useBoss;
  return RouteDecisionSchema.parse({
    ...upgraded,
    useWorker,
    workerTier: useWorker ? current.workerTier : 'none',
    maxWorkerCalls: useWorker ? current.maxWorkerCalls : 0,
    useVerifier,
    useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : upgraded.useTools || upgraded.useMemory
          ? 'grounded_path'
          : 'direct_fast_path',
    reasons: [
      ...upgraded.reasons,
      'postflight observed an actual code mutation from Hermes tool evidence',
    ],
  });
}

export async function preflightGatewayTurn(raw: GatewayTurnPreflightInput) {
  const turnStartedAtMs = Date.now();
  const store = getRuntimeStore();
  let request = preserveUnfinishedCodingContinuity(GatewayTurnPreflightRequestSchema.parse(raw));
  const activeCodingRecord = store.findActiveCodingTaskBySession(request.sessionId);
  if (activeCodingRecord && request.workspaceRoot) {
    request = GatewayTurnPreflightRequestSchema.parse({
      ...request,
      hasFiles: true,
      hasCodeChangeIntent: true,
      userRequestedVerification: true,
      intent: request.intent === 'execute' ? 'execute' : 'mutate',
      confidence: Math.max(request.confidence, 0.95),
    });
  }
  reconcileStaleRuntimeSessions({ excludeSessionId: request.sessionId });
  store.reconcileExpiredRuns(now());
  const runId = `gateway_${crypto.randomUUID()}`;
  const baselineDecision = choosePipeline(request);
  const latencyPlan = createLatencyBudgetPlan(baselineDecision);
  let decision = baselineDecision;
  const existingSession = Boolean(getRuntimeSession(request.sessionId));
  const preparedContexts = await prepareGatewayContexts({
    request,
    decision: baselineDecision,
    existingSession,
    latencyPlan,
  });
  const { repositoryContext, memoryBrief } = preparedContexts;
  const preflightLatency: LatencyObservation[] = [...preparedContexts.observations];
  let codingTask: CodingTaskState | undefined;
  let codingContext = '';
  if (
    request.workspaceRoot
    && ['coding_change', 'debugging'].includes(baselineDecision.taskType)
  ) {
    const preparedCoding = await prepareCodexExecution({
      taskId: activeCodingRecord?.taskId,
      runId,
      sessionId: request.sessionId,
      request: request.request,
      workspaceRoot: request.workspaceRoot,
      acceptanceCriteria: ['Requested behavior is implemented.', 'Affected deterministic validation passes.', 'No unrelated files are modified.'],
    }, store);
    codingTask = preparedCoding.state;
    codingContext = preparedCoding.context;
  }
  const input = RuntimeRunRequestSchema.parse({
    ...request,
    sessionId: request.sessionId,
    persistSession: true,
    context: [request.context, repositoryContext, codingContext].filter(Boolean).join('\n\n'),
    memoryContext: memoryBrief.context,
    toolContext: repositoryContext,
    namespace: 'zenos',
    autoRecallMemory: false,
    persistRouteEvent: false,
    tokenPriority: 'economy',
    approvalGranted: request.approvalGranted,
    dryRun: false,
    modelOverrides: request.modelOverrides,
    codingTaskId: codingTask?.taskId,
    autonomousCoding: false,
    includeExecutionReceipt: false,
  });
  const planningBudget = createTokenBudgetPlan(baselineDecision, input, {
    userPriority: input.tokenPriority,
    budgetId: runId,
  });

  ensureGatewaySession(input, baselineDecision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
    memorySource: memoryBrief.source,
    memoryCoverageComplete: memoryBrief.coverage?.complete,
  });
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
    latencyPlan,
    planningBudget,
  );
  if (hostPlanning.call) {
    preflightLatency.push(observeLatency('host', hostPlanning.call.latencyMs, latencyPlan.hostMs));
  }
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
  const baseBudget = createTokenBudgetPlan(decision, input, {
    userPriority: input.tokenPriority,
    budgetId: runId,
  });
  const budget = {
    ...baseBudget,
    host: { ...baseBudget.host, timeoutMs: roleLatencyTimeout(latencyPlan, 'host') },
    worker: { ...baseBudget.worker, timeoutMs: roleLatencyTimeout(latencyPlan, 'worker') },
    verifier: { ...baseBudget.verifier, timeoutMs: roleLatencyTimeout(latencyPlan, 'verifier') },
    boss: { ...baseBudget.boss, timeoutMs: roleLatencyTimeout(latencyPlan, 'boss') },
  };
  const hostCallId = `${runId}:hermes-host`;
  const hostReservationTokens = Math.min(
    budget.host.inputTokens + budget.host.outputTokens,
    estimateTokenCount([
      request.request,
      repositoryContext,
      memoryBrief.context,
    ].filter(Boolean).join('\n\n'), request.host.model) + budget.host.outputTokens,
  );
  const hostAuthorization = authorizeTokenSpend({
    plan: budget,
    requestId: hostCallId,
    role: 'host',
    estimatedTokens: hostReservationTokens,
    mandatory: true,
  });
  if (!hostAuthorization.allowed) {
    throw new Error(hostAuthorization.reason || 'Unable to reserve the mandatory Hermes Host token budget');
  }

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
    preflightLatency.push(observeLatency('worker', worker.call.latencyMs, latencyPlan.workerMs));
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
      maxInputTokens: budget.boss.inputTokens,
      maxOutputTokens: budget.boss.outputTokens,
      timeoutMs: roleLatencyTimeout(latencyPlan, 'boss'),
      trigger: request.userRequestedBoss ? 'user_requested_boss' : 'host_or_safety_escalation',
      tokenBudgetPlan: budget,
      mandatory: request.userRequestedBoss || decision.requiresApproval,
    });
    bossPreflight = safeBossDecision(bossCall);
    preflightLatency.push(observeLatency('boss', bossCall.latencyMs, latencyPlan.bossMs));
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
    kind: 'gateway_preflight_v2',
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
    memorySource: memoryBrief.source,
    memoryCoverage: memoryCoverageScore(memoryBrief),
    latencyPlan,
    preflightLatency,
    turnStartedAtMs,
    holdFinalDelivery,
    codingTaskId: codingTask?.taskId,
    codingPhase: codingTask?.currentPhase,
    workspaceState: request.workspaceState,
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
    codingTaskId: codingTask?.taskId,
    codingPhase: codingTask?.currentPhase,
    hostContext: [
      renderHostContext(decision, hostPlan, workerResult, bossPreflight, memoryBrief, runId),
      codingTask
        ? `Transactional coding state:\n- task_id: ${codingTask.taskId}\n- phase: ${codingTask.currentPhase}\n- checkpoint: ${codingTask.checkpoints.at(-1)?.checkpointId || 'pending'}\n- workspace_revision: ${codingTask.workspaceRevision}\n- Rule: before any new mutation after compaction or interruption, reconcile Git HEAD, dirty diff hash, and changed-file hashes. Never deploy or restart before deterministic validation passes.`
        : '',
    ].filter(Boolean).join('\n\n'),
    hostWorkingSetTokens: hostWorkingSetForDecision(decision),
    hostBudget: {
      budgetId: budget.budgetId,
      reservationId: hostCallId,
      reservedTokens: hostReservationTokens,
      maxCalls: budget.host.maxCalls,
      maxOutputTokens: budget.host.outputTokens,
      accounting: 'uncached-input-plus-cache-write-plus-output' as const,
    },
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

export async function postflightGatewayTurn(raw: GatewayTurnPostflightInput) {
  const request = GatewayTurnPostflightRequestSchema.parse(raw);
  const store = getRuntimeStore();
  const run = store.getRun(request.runId);
  if (!run || run.sessionId !== request.sessionId) throw new Error('Gateway Runtime run was not found for this session');
  const storedDecision = RouteDecisionSchema.parse(run.decision);
  const stored = StoredGatewayPreflightSchema.parse(run.result);
  const turnStartedAtMs = stored.turnStartedAtMs || Date.parse(run.startedAt) || Date.now();
  const deterministicValidation = deterministicValidationState(request.toolSummary);
  const textObservedCoding = observedCodingState(request.toolSummary);
  const workspaceMutated = workspaceMutationObserved(stored.workspaceState, request.workspaceState);
  const observedCoding = {
    mutated: textObservedCoding.mutated || workspaceMutated,
    broken: textObservedCoding.broken,
  };
  const missingWorkspaceEvidence = Boolean(stored.codingTaskId && observedCoding.mutated && !request.workspaceState);
  const unresolvedCodingMutation = observedCoding.mutated
    && (observedCoding.broken || deterministicValidation !== 'passed' || missingWorkspaceEvidence);
  const baseInput = RuntimeRunRequestSchema.parse({
    ...stored.input,
    sessionId: request.sessionId,
    toolContext: [
      stored.input.toolContext,
      stored.hostPlan ? `Host orchestration plan:\n${compactHostPlan(stored.hostPlan)}` : '',
      request.toolSummary,
    ].filter(Boolean).join('\n\n'),
  });
  const input = observedCoding.mutated
    ? RuntimeRunRequestSchema.parse({
        ...baseInput,
        hasFiles: true,
        hasCodeChangeIntent: true,
        userRequestedVerification: baseInput.userRequestedVerification || unresolvedCodingMutation,
        intent: baseInput.intent === 'execute' ? 'execute' : 'mutate',
        confidence: Math.max(baseInput.confidence, 0.9),
      })
    : baseInput;
  const decision = observedCoding.mutated
    ? postflightDecisionForObservedMutation(storedDecision, input)
    : storedDecision;

  if (stored.codingTaskId) {
    let codingTask = store.getCodingTask(stored.codingTaskId)?.state as CodingTaskState | undefined;
    if (codingTask && observedCoding.mutated && !request.workspaceState) {
      codingTask = updateCodingTask(codingTask.taskId, {
        status: 'blocked',
        unresolvedRisks: [
          ...codingTask.unresolvedRisks,
          'Postflight workspace state was missing after a reported code mutation; reconcile hashes before any further write.',
        ],
      }, store);
    } else if (codingTask && observedCoding.mutated && request.workspaceState) {
      const changedFiles = request.workspaceState.changedFiles.map((file) => file.path);
      const patch = await recordCodexPatch({
        taskId: codingTask.taskId,
        changedFiles,
        allowedFiles: [...new Set([...codingTask.filesInspected, ...codingTask.filesChanged])],
      }, store);
      codingTask = patch.state;
      if (deterministicValidation === 'passed' && codingTask.status === 'active') {
        codingTask = recordCodingValidation(codingTask.taskId, {
          kind: 'targeted_test',
          status: 'passed',
          summary: 'Hermes postflight tool evidence reported deterministic validation passed.',
        }, store);
        if (codingTask.currentPhase === 'patch' || codingTask.currentPhase === 'revise') {
          codingTask = transitionCodingTask(codingTask.taskId, 'targeted_validation', {
            summary: 'Recorded deterministic postflight validation evidence.',
          }, store);
        }
        if (codingTask.currentPhase === 'targeted_validation') {
          codingTask = transitionCodingTask(codingTask.taskId, 'summarize', {
            summary: 'Workspace hashes were reconciled and deterministic validation passed.',
            status: 'completed',
          }, store);
        }
      } else if (codingTask.status === 'active') {
        codingTask = updateCodingTask(codingTask.taskId, {
          unresolvedRisks: [
            ...codingTask.unresolvedRisks,
            missingWorkspaceEvidence
              ? 'Postflight workspace state was missing after a code mutation.'
              : 'Code mutation remains pending deterministic validation.',
          ],
        }, store);
      }
    }
  }
  const latencyPlan = decision.pipelineMode === storedDecision.pipelineMode
    ? stored.latencyPlan || createLatencyBudgetPlan(decision)
    : createLatencyBudgetPlan(decision);
  const baseBudget = createTokenBudgetPlan(decision, input, {
    userPriority: input.tokenPriority,
    budgetId: request.runId,
  });
  const budget = {
    ...baseBudget,
    host: { ...baseBudget.host, timeoutMs: roleLatencyTimeout(latencyPlan, 'host') },
    worker: { ...baseBudget.worker, timeoutMs: roleLatencyTimeout(latencyPlan, 'worker') },
    verifier: { ...baseBudget.verifier, timeoutMs: roleLatencyTimeout(latencyPlan, 'verifier') },
    boss: { ...baseBudget.boss, timeoutMs: roleLatencyTimeout(latencyPlan, 'boss') },
  };
  const postflightLatency: LatencyObservation[] = [
    ...stored.preflightLatency,
    observeLatency('host', request.hostDurationMs, latencyPlan.hostMs),
  ];
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
  const hostGovernor = settleTokenSpend({
    plan: budget,
    requestId: `${request.runId}:hermes-host`,
    role: 'host',
    actualTokens: request.hostUsage.inputTokens
      + request.hostUsage.cacheWriteTokens
      + request.hostUsage.outputTokens,
    attempted: request.hostUsage.calls > 0,
    usageValid: request.hostUsage.valid,
    invalidReason: request.hostUsage.invalidReason,
  });

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
        estimated: request.hostUsage.source === 'estimate',
        source: request.hostUsage.source,
        valid: request.hostUsage.valid,
        invalidReason: request.hostUsage.invalidReason,
        providerRequestId: request.hostUsage.providerRequestId,
      },
      latencyMs: request.hostDurationMs,
    },
    request.failed ? 'failed' : 'success',
  );

  if (request.failed) {
    accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
    recordOutcomePassport({
      runId: request.runId,
      sessionId: request.sessionId,
      request: input.request,
      decision,
      verdict: 'failed',
      transformed: false,
      calls,
      hostUsage: request.hostUsage,
      latencyObservations: [
        ...postflightLatency,
        observeLatency('total', Date.now() - turnStartedAtMs, latencyPlan.totalMs),
      ],
      bossVerdict: stored.bossPreflight?.verdict,
      bossConfidence: stored.bossPreflight?.confidence,
      evidenceCoverage: stored.memoryCoverage,
      memorySource: stored.memorySource,
      hostModel: stored.host.model,
      hostProvider: stored.host.provider,
    });
    store.saveRun({
      ...run,
      status: 'failed',
      result: { ...stored, finalAnswer: request.draft, failed: true, tokenBudget: hostGovernor },
      errors: ['Hermes Host reported a failed turn'],
      completedAt: now(),
    });
    updateRuntimeSession(request.sessionId, { status: 'failed', lastError: 'Hermes Host reported a failed turn', activeRunId: undefined });
    completeTokenBudget(request.runId);
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
  const hostInputTokens = request.hostUsage.inputTokens + request.hostUsage.cacheWriteTokens;
  const hostInputBudget = Math.max(
    24_000,
    Number(process.env.ZENOS_GATEWAY_HOST_INPUT_BUDGET_TOKENS || 96_000),
  );
  const hostOverBudget = hostInputTokens > hostInputBudget;
  const verifierMandatory = input.userRequestedVerification
    || unresolvedCodingMutation
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const verifierMayRewriteHost = verifierMandatory || decision.requiresApproval || request.failed;
  const deterministicPassReplacesOptionalVerifier = deterministicValidation === 'passed'
    && ['coding_change', 'debugging', 'repo_question'].includes(decision.taskType)
    && !verifierMandatory;
  let verifierResult: VerifierResult | undefined;
  let verifierCall: RuntimeModelResult | undefined;
  let bossDecision = stored.bossPreflight;
  let bossCall = calls.find((call) => call.role === 'boss');

  if (
    decision.useVerifier
    && (!hostOverBudget || verifierMandatory)
    && !deterministicPassReplacesOptionalVerifier
  ) {
    const verifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:1`,
      budget,
      mandatory: verifierMandatory,
    });
    verifierResult = verifier.result;
    verifierCall = verifier.call;
    calls.push(verifier.call);
    postflightLatency.push(observeLatency('verifier', verifier.call.latencyMs, latencyPlan.verifierMs));
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

    if (verifier.result?.verdict === 'revise' && verifierMayRewriteHost) {
      const fixes = verifier.result.issues.map((issue) => issue.requiredFix || issue.issue).filter(Boolean);
      const revision = await runHostRevision(input, finalAnswer, fixes, stored.workerResult, {
        requestId: `${request.runId}:gateway-host-revision:1`,
        budget,
      });
      calls.push(revision);
      postflightLatency.push(observeLatency('host', revision.latencyMs, latencyPlan.hostMs));
      if (revision.ok && revision.content) {
        finalAnswer = revision.content;
        transformed = finalAnswer !== request.draft;
        recordActivity(
          request.sessionId,
          'host',
          `Runtime Host ${revision.model} revised the Hermes draft from mandatory verifier feedback.`,
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
    } else if (verifier.result?.verdict === 'revise') {
      recordActivity(
        request.sessionId,
        'verifier',
        'Optional verifier feedback was recorded as advisory; Hermes Host retained final-answer authority.',
        {
          runId: request.runId,
          turnId: request.turnId,
          verdict: verifier.result.verdict,
          advisoryIssues: verifier.result.issues.length,
        },
        'success',
      );
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
      deterministicPassReplacesOptionalVerifier
        ? 'Verifier skipped because deterministic code validation passed and no high-risk review was required.'
        : hostOverBudget && decision.useVerifier
          ? `Verifier skipped because Hermes Host already consumed ${hostInputTokens} input tokens (budget ${hostInputBudget}).`
          : 'Verifier skipped by Host orchestration and safety policy.',
      {
        runId: request.runId,
        turnId: request.turnId,
        hostInputTokens,
        hostInputBudget,
        hostOverBudget,
        deterministicValidation,
      },
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
      maxInputTokens: budget.boss.inputTokens,
      maxOutputTokens: budget.boss.outputTokens,
      timeoutMs: roleLatencyTimeout(latencyPlan, 'boss'),
      trigger: verifierResult?.verdict === 'escalate' ? 'verifier_escalation' : 'critical_postflight_authority',
      tokenBudgetPlan: budget,
      mandatory: decision.requiresApproval || verifierResult?.verdict === 'escalate',
    });
    calls.push(finalBossCall);
    postflightLatency.push(observeLatency('boss', finalBossCall.latencyMs, latencyPlan.bossMs));
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
      postflightLatency.push(observeLatency('host', revision.latencyMs, latencyPlan.hostMs));
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

  if (
    transformed
    && decision.useVerifier
    && verifierResult?.verdict === 'revise'
    && (decision.risk === 'high' || decision.risk === 'critical')
  ) {
    const finalVerifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:final`,
      budget,
      mandatory: decision.risk === 'critical',
    });
    calls.push(finalVerifier.call);
    postflightLatency.push(observeLatency('verifier', finalVerifier.call.latencyMs, latencyPlan.verifierMs));
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

  const terminalCodingFailure = unresolvedCodingMutation;
  if (terminalCodingFailure) {
    finalAnswer = blockedAnswer(
      observedCoding.broken
        ? 'Hermes mengubah source code, tetapi bukti tool menunjukkan file berada dalam kondisi rusak atau validasi gagal.'
        : 'Hermes mengubah source code, tetapi tidak ada bukti deterministic validation yang lulus.',
      [
        'Perbaiki atau rollback perubahan sampai syntax, typecheck, lint, atau targeted test yang relevan lulus.',
        'Jangan restart, deploy, atau menandai pekerjaan selesai saat working tree masih broken atau belum tervalidasi.',
      ],
    );
    transformed = true;
    recordActivity(
      request.sessionId,
      'verifier',
      'Runtime failed closed because a code mutation did not pass deterministic validation.',
      {
        runId: request.runId,
        turnId: request.turnId,
        deterministicValidation,
        brokenCodeEvidence: observedCoding.broken,
      },
      'failed',
    );
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

  const finalTokenBudget = tokenGovernorSnapshot(budget);
  store.saveRun({
    ...run,
    decision,
    status: terminalCodingFailure
      ? 'failed'
      : bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block'
        ? 'blocked'
        : 'done',
    result: {
      preflight: stored,
      finalAnswer,
      verifierResult,
      bossDecision,
      receipt,
      modelCalls: calls,
      tokenBudget: finalTokenBudget,
      codingValidation: observedCoding.mutated
        ? { deterministic: deterministicValidation, broken: observedCoding.broken }
        : undefined,
    },
    errors: terminalCodingFailure
      ? ['Code mutation did not pass deterministic validation']
      : [],
    completedAt: now(),
  });
  accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
  const outcomeVerdict = terminalCodingFailure
    ? 'failed'
    : bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block'
      ? 'blocked'
      : transformed || verifierResult?.verdict === 'revise' || bossDecision?.verdict === 'revise'
        ? 'revised'
        : 'success';
  recordOutcomePassport({
    runId: request.runId,
    sessionId: request.sessionId,
    request: input.request,
    decision,
    verdict: outcomeVerdict,
    transformed,
    calls,
    hostUsage: request.hostUsage,
    latencyObservations: [
      ...postflightLatency,
      observeLatency('total', Date.now() - turnStartedAtMs, latencyPlan.totalMs),
    ],
    verifierVerdict: verifierResult?.verdict,
    verifierConfidence: verifierResult?.confidence,
    bossVerdict: bossDecision?.verdict,
    bossConfidence: bossDecision?.confidence,
    evidenceCoverage: stored.memoryCoverage,
    memorySource: stored.memorySource,
    hostModel: stored.host.model,
    hostProvider: stored.host.provider,
  });
  if (terminalCodingFailure) {
    updateRuntimeSession(request.sessionId, {
      status: 'failed',
      finalAnswer,
      lastError: 'Code mutation did not pass deterministic validation',
      activeRunId: undefined,
    });
  } else {
    completeRuntimeSession(request.sessionId, finalAnswer);
  }
  completeTokenBudget(request.runId);

  return {
    ok: !terminalCodingFailure,
    failed: terminalCodingFailure,
    finalAnswer,
    transformed,
    receipt,
    verifier: verifierResult,
    boss: bossDecision,
    tokenBudget: finalTokenBudget,
  };
}
