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
import { createTokenBudgetPlan } from './token-economy';
import { completeTokenBudget } from './token-governor';
import {
  GatewayMemoryBrief,
  GatewayTurnPostflightInput,
  GatewayTurnPostflightRequestSchema,
  GatewayTurnPreflightInput,
  GatewayTurnPreflightRequestSchema,
  GatewayTurnReceipt,
  StoredGatewayPreflight,
  StoredGatewayPreflightSchema,
} from './gateway-contracts';
import { accountGatewayModelUsage, callIdentity, gatewayHostCallCount } from './gateway-accounting';
import { prepareGatewayContexts } from './gateway-continuity';
import { compactHostPlan, runGatewayHostPlanning } from './gateway-planning';
import { askUserAnswer, blockedAnswer, renderHostContext } from './gateway-rendering';
import {
  LatencyObservation,
  createLatencyBudgetPlan,
  observeLatency,
  roleLatencyTimeout,
} from './latency-budget';
import { recordOutcomePassport } from './outcome-ledger';

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
  const hasValidation = /\b(test|tests|lint|typecheck|build|compile|validation|pytest|vitest|jest)\b/.test(text);
  if (!hasValidation) return 'unknown';
  if (/\b(fail(?:ed|ure)?|error|errors|non[- ]?zero|exit\s+[1-9]|timed out|timeout)\b/.test(text)) return 'failed';
  if (/\b(pass(?:ed)?|success(?:ful)?|completed|green|exit\s+0|0\s+errors?)\b/.test(text)) return 'passed';
  return 'unknown';
}

export async function preflightGatewayTurn(raw: GatewayTurnPreflightInput) {
  const turnStartedAtMs = Date.now();
  const request = GatewayTurnPreflightRequestSchema.parse(raw);
  reconcileStaleRuntimeSessions({ excludeSessionId: request.sessionId });
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
    tokenPriority: 'economy',
    approvalGranted: request.approvalGranted,
    dryRun: false,
    modelOverrides: request.modelOverrides,
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
      maxInputTokens: 1_800,
      maxOutputTokens: 600,
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

export async function postflightGatewayTurn(raw: GatewayTurnPostflightInput) {
  const request = GatewayTurnPostflightRequestSchema.parse(raw);
  const store = getRuntimeStore();
  const run = store.getRun(request.runId);
  if (!run || run.sessionId !== request.sessionId) throw new Error('Gateway Runtime run was not found for this session');
  const decision = RouteDecisionSchema.parse(run.decision);
  const stored = StoredGatewayPreflightSchema.parse(run.result);
  const latencyPlan = stored.latencyPlan || createLatencyBudgetPlan(decision);
  const turnStartedAtMs = stored.turnStartedAtMs || Date.parse(run.startedAt) || Date.now();
  const input = RuntimeRunRequestSchema.parse({
    ...stored.input,
    sessionId: request.sessionId,
    toolContext: [
      stored.input.toolContext,
      stored.hostPlan ? `Host orchestration plan:\n${compactHostPlan(stored.hostPlan)}` : '',
      request.toolSummary,
    ].filter(Boolean).join('\n\n'),
  });
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
    });
    store.saveRun({
      ...run,
      status: 'failed',
      result: { ...stored, finalAnswer: request.draft, failed: true },
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
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const deterministicValidation = deterministicValidationState(request.toolSummary);
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

    if (verifier.result?.verdict === 'revise') {
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
      maxInputTokens: 2_400,
      maxOutputTokens: 700,
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
  const outcomeVerdict = bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block'
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
  });
  completeRuntimeSession(request.sessionId, finalAnswer);
  completeTokenBudget(request.runId);

  return {
    ok: true,
    finalAnswer,
    transformed,
    receipt,
    verifier: verifierResult,
    boss: bossDecision,
  };
}
