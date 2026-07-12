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
  runBossReviewModel,
  runHostRevision,
  runVerifier,
  runWorkerCompression,
} from './zenos-runtime-executor';
import {
  completeRuntimeSession,
  createRuntimeSession,
  getRuntimeSession,
  updateRuntimeSession,
} from './zenos-runtime-three-agent';
import { BossDecision, BossDecisionSchema } from './zenos-runtime-state';
import { getRuntimeStore } from './zenos-runtime-store';
import { createTokenBudgetPlan } from './token-economy';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  renderRepositoryContext,
} from './repository-intelligence';

const GatewayModelIdentitySchema = z.object({
  model: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(200),
});

export const GatewayTurnPreflightRequestSchema = RuntimeContextSchema.extend({
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  platform: z.string().trim().min(1).max(80).default('gateway'),
  host: GatewayModelIdentitySchema,
  context: z.string().max(120_000).optional().default(''),
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
  }).optional().default({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }),
  hostDurationMs: z.number().int().nonnegative().max(86_400_000).optional().default(0),
});

const StoredGatewayPreflightSchema = z.object({
  kind: z.literal('gateway_preflight_v1'),
  input: RuntimeRunRequestSchema,
  turnId: z.string(),
  platform: z.string(),
  host: GatewayModelIdentitySchema,
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
  host: { model: string; provider: string; invoked: boolean };
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
  worker: WorkerResult | undefined,
  boss: BossDecision | undefined,
  runId: string,
): string {
  return [
    '[Zenos Runtime native turn brief — internal execution context]',
    `Run: ${runId}`,
    `Route: ${decision.pipelineMode}; task=${decision.taskType}; risk=${decision.risk}`,
    `Roles required: worker=${decision.useWorker}; verifier=${decision.useVerifier}; boss=${decision.useBoss}`,
    decision.useWorker ? '' : 'Worker skipped by deterministic route policy.',
    decision.useVerifier ? '' : 'Verifier skipped by deterministic route policy.',
    decision.useBoss ? '' : 'Boss skipped by deterministic route policy.',
    `Route reasons: ${decision.reasons.join('; ')}`,
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

function safeBossDecision(call: RuntimeModelResult): BossDecision | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = BossDecisionSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

export async function preflightGatewayTurn(raw: GatewayTurnPreflightInput) {
  const request = GatewayTurnPreflightRequestSchema.parse(raw);
  const runId = `gateway_${crypto.randomUUID()}`;
  const decision = choosePipeline(request);
  const repositoryContext = await repositoryContextFor(request, decision);
  const input = RuntimeRunRequestSchema.parse({
    ...request,
    sessionId: request.sessionId,
    persistSession: true,
    context: [request.context, repositoryContext].filter(Boolean).join('\n\n'),
    memoryContext: '',
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
  const budget = createTokenBudgetPlan(decision, input, { userPriority: input.tokenPriority });

  ensureGatewaySession(input, decision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
  });
  const store = getRuntimeStore();
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
    `Hermes Host ${request.host.model} queued behind Runtime preflight.`,
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

  let workerResult: WorkerResult | undefined;
  let workerCall: RuntimeModelResult | undefined;
  if (decision.useWorker) {
    const worker = await runWorkerCompression(input, undefined, {
      pass: 1,
      totalPasses: 1,
      requestId: `${runId}:gateway-worker:1`,
      budget,
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
      'Worker skipped by deterministic direct-path policy.',
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
      workerResult,
      host: request.host,
    }, {
      sessionId: request.sessionId,
      modelOverrides: input.modelOverrides,
      requestId: `${runId}:gateway-boss-preflight`,
      maxInputTokens: 1_800,
      maxOutputTokens: 600,
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
      'Boss skipped because the route does not require premium judgment.',
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
      trigger: request.userRequestedBoss ? 'user_requested_boss' : 'route_policy',
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
    hostContext: renderHostContext(decision, workerResult, bossPreflight, runId),
    receipt: {
      pipeline: decision.pipelineMode,
      host: { ...request.host, invoked: true },
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
    toolContext: [stored.input.toolContext, request.toolSummary].filter(Boolean).join('\n\n'),
  });
  const budget = createTokenBudgetPlan(decision, input, { userPriority: input.tokenPriority });
  const calls: RuntimeModelResult[] = [];
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
        host: { ...request.host, invoked: true },
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
      'Verifier skipped by deterministic route policy.',
      { runId: request.runId, turnId: request.turnId },
      'skipped',
    );
  }

  const shouldRunBoss = decision.requiresApproval
    || verifierResult?.verdict === 'escalate'
    || (decision.useBoss && !input.userRequestedBoss);
  if (shouldRunBoss) {
    const finalBossCall = await runBossReviewModel({
      stage: 'postflight',
      runId: request.runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      userGoal: input.request,
      decision,
      currentDraft: finalAnswer,
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
    host: { ...request.host, invoked: true },
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
