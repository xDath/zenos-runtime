import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { choosePipeline, RuntimeContextSchema, WorkerFinding, WorkerFindingSchema } from './zenos-runtime';
import { RuntimeModelSlotsSchema } from './zenos-runtime-model-config';
import { getRuntimeStore } from './zenos-runtime-store';
import {
  BossDecisionSchema,
  EscalationPacket,
  EscalationPacketSchema,
  QualityGateInputSchema,
  QualityGateResult,
  QualityGateResultSchema,
  RuntimeSessionState,
  RuntimeSessionStateSchema,
  WorkerEvent,
  WorkerEventSchema,
  WorkerLease,
  WorkerLeaseSchema,
  WorkerTemplateName,
  workerTemplates,
} from './zenos-runtime-state';

export {
  AgentRoleSchema,
  BossDecisionSchema,
  BossVerdictSchema,
  EscalationPacketSchema,
  QualityGateInputSchema,
  QualityGateResultSchema,
  RuntimeBudgetStateSchema,
  RuntimeSessionStateSchema,
  RuntimeSessionStatusSchema,
  WorkerEventSchema,
  WorkerEventTypeSchema,
  WorkerLeaseSchema,
  WorkerLeaseStatusSchema,
  workerTemplates,
} from './zenos-runtime-state';

export type {
  BossDecision,
  EscalationPacket,
  QualityGateResult,
  RuntimeSessionState,
  WorkerEvent,
  WorkerLease,
  WorkerTemplateName,
} from './zenos-runtime-state';

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function withVersion(session: RuntimeSessionState, patch: Partial<RuntimeSessionState>): RuntimeSessionState {
  return RuntimeSessionStateSchema.parse({
    ...session,
    ...patch,
    version: session.version + 1,
    updatedAt: now(),
  });
}

export function createRuntimeSession(
  input: z.input<typeof RuntimeContextSchema>,
  options: {
    sessionId?: string;
    modelOverrides?: z.input<typeof RuntimeModelSlotsSchema>;
    metadata?: Record<string, unknown>;
  } = {},
): RuntimeSessionState {
  const context = RuntimeContextSchema.parse(input);
  const decision = choosePipeline(context);
  const started = now();
  const session = RuntimeSessionStateSchema.parse({
    sessionId: options.sessionId || id('session'),
    userGoal: context.request,
    status: 'routing',
    hostModel: decision.hostTier,
    bossModel: decision.useBoss ? 'premium' : undefined,
    modelOverrides: RuntimeModelSlotsSchema.parse(options.modelOverrides || {}),
    routeDecision: decision,
    workers: [],
    events: [],
    budget: {
      maxPremiumTokens: decision.risk === 'critical' ? 10_000 : decision.hostTier === 'premium' ? 6_000 : 2_000,
      maxHostTokens: decision.maxContextTokens,
      maxWorkerTokens: decision.useWorker ? Math.max(20_000, decision.maxWorkerCalls * 10_000) : 0,
      maxModelCalls: Math.max(4, 2 + decision.maxWorkerCalls + decision.maxRevisionAttempts * 2 + (decision.useBoss ? 1 : 0)),
      premiumTokensUsed: 0,
      hostTokensUsed: 0,
      workerTokensUsed: 0,
      verifierTokensUsed: 0,
      modelCallsUsed: 0,
      estimatedPremiumTokensAvoided: Math.max(0, context.estimatedContextTokens - decision.maxContextTokens),
    },
    metadata: options.metadata || {},
    version: 1,
    createdAt: started,
    updatedAt: started,
  });
  return getRuntimeStore().saveSession(session);
}

export function getRuntimeSession(sessionId: string): RuntimeSessionState | undefined {
  return getRuntimeStore().getSession(sessionId);
}

export function listRuntimeSessions(limit = 100): RuntimeSessionState[] {
  return getRuntimeStore().listSessions(limit);
}

export function reconcileStaleRuntimeSessions(options: {
  staleAfterMs?: number;
  limit?: number;
  excludeSessionId?: string;
  nowMs?: number;
} = {}): { reconciled: number; sessionIds: string[] } {
  const store = getRuntimeStore();
  const staleAfterMs = Math.max(
    15 * 60_000,
    options.staleAfterMs || Number(process.env.ZENOS_RUNTIME_STALE_SESSION_MS || 6 * 60 * 60_000),
  );
  const nowMs = options.nowMs || Date.now();
  const activeStatuses = new Set<RuntimeSessionState['status']>([
    'routing',
    'working',
    'paused',
    'boss_review',
    'revising',
    'finalizing',
  ]);
  const stale = store.listSessions(Math.min(Math.max(options.limit || 500, 1), 2_000))
    .filter((session) => session.sessionId !== options.excludeSessionId)
    .filter((session) => activeStatuses.has(session.status))
    .filter((session) => nowMs - new Date(session.updatedAt).getTime() >= staleAfterMs);

  for (const session of stale) {
    store.transaction(() => {
      for (const worker of session.workers.filter((item) => ['queued', 'running', 'paused'].includes(item.status))) {
        store.saveWorker(session.sessionId, WorkerLeaseSchema.parse({
          ...worker,
          status: 'cancelled',
          error: worker.error || 'Cancelled by stale-session reconciliation.',
          updatedAt: now(),
        }));
      }
      store.saveSession(withVersion(session, {
        status: 'cancelled',
        activeRunId: undefined,
        lastError: 'Stale active session reconciled after exceeding the inactivity window.',
        metadata: {
          ...session.metadata,
          staleReconciledAt: now(),
          staleAfterMs,
          previousStatus: session.status,
        },
      }));
    });
  }

  return { reconciled: stale.length, sessionIds: stale.map((session) => session.sessionId) };
}

export function updateRuntimeSession(
  sessionId: string,
  patch: Partial<Pick<RuntimeSessionState, 'status' | 'finalAnswer' | 'lastError' | 'activeRunId' | 'budget' | 'metadata' | 'modelOverrides'>>,
): RuntimeSessionState {
  const session = getRuntimeSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  return getRuntimeStore().saveSession(withVersion(session, patch));
}

export function dispatchWorker(sessionId: string, templateName: WorkerTemplateName, task: string): RuntimeSessionState {
  const store = getRuntimeStore();
  const session = store.getSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  if (['done', 'failed', 'cancelled'].includes(session.status)) throw new Error(`Cannot dispatch worker for ${session.status} session`);
  const template = workerTemplates[templateName];
  const createdAt = now();
  const worker = WorkerLeaseSchema.parse({
    workerId: id('worker'),
    template: templateName,
    modelTier: template.modelTier,
    task,
    status: 'queued',
    maxTokens: template.maxTokens,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  });
  store.transaction(() => {
    store.saveWorker(sessionId, worker);
    store.saveSession(withVersion(session, { status: 'working' }));
    store.insertEvent({
      sessionId,
      workerId: worker.workerId,
      type: 'progress',
      summary: `Worker queued with template ${templateName}.`,
      evidence: [],
      severity: 'low',
      confidence: 1,
      needsBoss: false,
      metadata: { template: templateName },
      createdAt,
    });
  });
  return store.getSession(sessionId) as RuntimeSessionState;
}

export function updateWorkerLease(
  sessionId: string,
  workerId: string,
  patch: Partial<Pick<WorkerLease, 'status' | 'attempts' | 'result' | 'error'>>,
): WorkerLease {
  const store = getRuntimeStore();
  const session = store.getSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const worker = session.workers.find((item) => item.workerId === workerId);
  if (!worker) throw new Error('Runtime worker not found');
  const updated = WorkerLeaseSchema.parse({ ...worker, ...patch, updatedAt: now() });
  return store.saveWorker(sessionId, updated);
}

export function recordWorkerEvent(input: z.input<typeof WorkerEventSchema>): RuntimeSessionState {
  const store = getRuntimeStore();
  const event = WorkerEventSchema.parse({ ...input, createdAt: input.createdAt || now() });
  const session = store.getSession(event.sessionId);
  if (!session) throw new Error('Runtime session not found');
  const worker = session.workers.find((item) => item.workerId === event.workerId);
  const needsPause = event.needsBoss || event.severity === 'critical' || event.type === 'risk' || event.type === 'conflict';
  const terminalWorkerStatus = event.type === 'done' ? 'done' : event.type === 'error' ? 'failed' : undefined;
  const reportedUsage = event.metadata.usage && typeof event.metadata.usage === 'object' && !Array.isArray(event.metadata.usage)
    ? event.metadata.usage as Record<string, unknown>
    : undefined;
  const reportedWorkerTokens = typeof reportedUsage?.totalTokens === 'number' && Number.isFinite(reportedUsage.totalTokens)
    ? Math.max(0, Math.round(reportedUsage.totalTokens))
    : 0;

  store.transaction(() => {
    store.insertEvent(event);
    if (worker) {
      store.saveWorker(event.sessionId, WorkerLeaseSchema.parse({
        ...worker,
        status: terminalWorkerStatus || (needsPause ? 'paused' : worker.status === 'queued' ? 'running' : worker.status),
        error: event.type === 'error' ? event.summary : worker.error,
        updatedAt: now(),
      }));
    }
    const nextStatus = event.type === 'error' && session.workers.length <= 1
      ? 'failed'
      : needsPause
        ? 'paused'
        : session.status === 'routing'
          ? 'working'
          : session.status;
    store.saveSession(withVersion(session, {
      status: nextStatus,
      lastError: event.type === 'error' ? event.summary : session.lastError,
      budget: {
        ...session.budget,
        workerTokensUsed: session.budget.workerTokensUsed + reportedWorkerTokens,
      },
    }));
  });
  return store.getSession(event.sessionId) as RuntimeSessionState;
}

export function runQualityGate(input: z.input<typeof QualityGateInputSchema>): QualityGateResult {
  const parsed = QualityGateInputSchema.parse(input);
  const usableFindings = parsed.findings.filter((finding) => {
    const hasEvidence = !parsed.requireEvidence || finding.evidence.length > 0;
    return hasEvidence && finding.confidence >= parsed.minConfidence;
  });
  const discardedFindings = parsed.findings.filter((finding) => !usableFindings.includes(finding));
  const criticalEvents = parsed.events.filter((event) => event.severity === 'critical');
  const severeEvents = parsed.events.filter((event) => event.needsBoss || event.severity === 'high' || event.severity === 'critical');
  const reasons = [
    ...discardedFindings.map((finding) => `discarded:${finding.claim}`),
    ...severeEvents.map((event) => `event:${event.type}:${event.summary}`),
  ];
  const needsBoss = severeEvents.length > 0 || discardedFindings.some((finding) => finding.risk === 'high' || finding.risk === 'critical');
  const verdict = criticalEvents.some((event) => event.type === 'risk')
    ? 'block'
    : needsBoss
      ? 'escalate'
      : discardedFindings.length
        ? 'revise'
        : 'pass';
  return QualityGateResultSchema.parse({ verdict, usableFindings, discardedFindings, reasons, needsBoss });
}

function findingsFromEvents(events: WorkerEvent[]): WorkerFinding[] {
  const findings: WorkerFinding[] = [];
  for (const event of events) {
    if (event.type !== 'finding' && event.type !== 'risk' && event.type !== 'conflict') continue;
    const candidate = WorkerFindingSchema.safeParse({
      claim: event.summary,
      evidence: event.evidence,
      confidence: event.confidence,
      risk: event.severity,
    });
    if (candidate.success) findings.push(candidate.data);
  }
  return findings.slice(0, 20);
}

export function buildEscalationPacket(
  sessionId: string,
  hostAssessment = 'Host requests Boss review.',
  extras: { currentDraft?: string; runId?: string; verifierIssues?: EscalationPacket['verifierIssues'] } = {},
): EscalationPacket {
  const session = getRuntimeSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const triggeringEvents = session.events.filter((event) => event.needsBoss || event.severity === 'high' || event.severity === 'critical' || event.type === 'conflict' || event.type === 'risk');
  const conflicts = session.events.filter((event) => event.type === 'conflict').map((event) => event.summary);
  const unknowns = session.events.filter((event) => event.confidence < 0.6).map((event) => event.summary);
  return EscalationPacketSchema.parse({
    sessionId,
    runId: extras.runId,
    userGoal: session.userGoal,
    hostAssessment,
    currentDraft: extras.currentDraft || session.finalAnswer || '',
    decisionNeeded: triggeringEvents.length ? 'approve' : 'revise',
    workerFindings: findingsFromEvents(session.events),
    verifierIssues: extras.verifierIssues || [],
    conflicts,
    unknowns,
    triggeringEvents,
    budget: session.budget,
  });
}

export function applyBossDecision(
  sessionId: string,
  decisionInput: z.input<typeof BossDecisionSchema>,
  accounting: { usageTokens?: number; modelCall?: boolean } = {},
): RuntimeSessionState {
  const store = getRuntimeStore();
  const decision = BossDecisionSchema.parse(decisionInput);
  const session = store.getSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const status = decision.verdict === 'block'
    ? 'failed'
    : decision.verdict === 'ask_user'
      ? 'paused'
      : decision.verdict === 'revise'
        ? 'revising'
        : 'working';
  store.transaction(() => {
    store.insertEvent({
      sessionId,
      workerId: 'boss',
      type: decision.verdict === 'block' ? 'risk' : 'progress',
      summary: `Boss decision: ${decision.verdict}. ${decision.reasoningSummary}`,
      evidence: decision.requiredChanges,
      severity: decision.verdict === 'block' ? 'critical' : decision.verdict === 'revise' ? 'medium' : 'low',
      confidence: decision.confidence,
      needsBoss: false,
      metadata: {
        allowedActions: decision.allowedActions,
        forbiddenActions: decision.forbiddenActions,
        ...(accounting.modelCall ? { usage: { totalTokens: Math.max(0, Math.round(accounting.usageTokens || 0)) } } : {}),
      },
      createdAt: now(),
    });
    store.saveSession(withVersion(session, {
      status,
      lastError: decision.verdict === 'block' ? decision.reasoningSummary : session.lastError,
      budget: accounting.modelCall
        ? {
            ...session.budget,
            premiumTokensUsed: session.budget.premiumTokensUsed + Math.max(0, Math.round(accounting.usageTokens || 0)),
            modelCallsUsed: session.budget.modelCallsUsed + 1,
          }
        : session.budget,
    }));
  });
  return store.getSession(sessionId) as RuntimeSessionState;
}

export function completeRuntimeSession(sessionId: string, finalAnswer?: string): RuntimeSessionState {
  const session = getRuntimeSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  return getRuntimeStore().saveSession(withVersion(session, { status: 'done', finalAnswer, lastError: undefined, activeRunId: undefined }));
}

export function failRuntimeSession(sessionId: string, error: string): RuntimeSessionState {
  const session = getRuntimeSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  return getRuntimeStore().saveSession(withVersion(session, { status: 'failed', lastError: error, activeRunId: undefined }));
}

export function cancelRuntimeSession(sessionId: string): RuntimeSessionState {
  const store = getRuntimeStore();
  const session = store.getSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  store.transaction(() => {
    for (const worker of session.workers.filter((item) => ['queued', 'running', 'paused'].includes(item.status))) {
      store.saveWorker(sessionId, WorkerLeaseSchema.parse({ ...worker, status: 'cancelled', updatedAt: now() }));
    }
    store.saveSession(withVersion(session, { status: 'cancelled', activeRunId: undefined }));
  });
  return store.getSession(sessionId) as RuntimeSessionState;
}

export function runtimeStoreInfo(): ReturnType<ReturnType<typeof getRuntimeStore>['health']> & { sessions: number; engine: string } {
  const store = getRuntimeStore();
  return { ...store.health(), sessions: store.listSessions(500).length, engine: 'sqlite-wal' };
}

export function updateSessionModelOverrides(sessionId: string, update: z.input<typeof RuntimeModelSlotsSchema>): RuntimeSessionState {
  const session = getRuntimeSession(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const modelOverrides = RuntimeModelSlotsSchema.parse({ ...session.modelOverrides, ...update });
  return getRuntimeStore().saveSession(withVersion(session, { modelOverrides }));
}

export function getRuntimeModels() {
  return {
    architecture: 'host-led-cognitive-runtime-v1',
    orchestrationMode: 'host-led',
    modelPolicy: 'single-session-model-inherited-by-all-roles',
    roles: [
      { role: 'host', tier: 'session-model', purpose: 'sole orchestrator, tool-loop owner, final judgment, and user-facing synthesis' },
      { role: 'worker', tier: 'session-model', purpose: 'native Hermes subagent for bounded browser, repository, coding, validation, operations, or extraction work' },
      { role: 'verifier', tier: 'session-model', purpose: 'explicit-only independent review; disabled for ordinary execution' },
      { role: 'boss', tier: 'session-model', purpose: 'rare explicit, approval-boundary, or critical-risk authority' },
    ],
    nativeWorkerProfiles: [
      'browser-research',
      'repo-inspector',
      'coding-worker',
      'validation-worker',
      'ops-observer',
      'data-extractor',
    ],
    workerTemplates,
  };
}
