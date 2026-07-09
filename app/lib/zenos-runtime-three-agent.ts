import { z } from 'zod';
import { choosePipeline, ModelTierSchema, RiskLevelSchema, RuntimeContextSchema, WorkerFindingSchema } from './zenos-runtime';

export const AgentRoleSchema = z.enum(['host', 'boss', 'worker']);
export const WorkerEventTypeSchema = z.enum(['progress', 'finding', 'risk', 'conflict', 'tool_result', 'done', 'error']);
export const RuntimeSessionStatusSchema = z.enum(['routing', 'working', 'paused', 'boss_review', 'finalizing', 'done', 'failed']);
export const WorkerLeaseStatusSchema = z.enum(['queued', 'running', 'paused', 'done', 'failed', 'cancelled']);
export const BossVerdictSchema = z.enum(['approve', 'revise', 'block', 'ask_user', 'delegate']);

export const RuntimeBudgetStateSchema = z.object({
  maxPremiumTokens: z.number().int().nonnegative().default(4000),
  maxHostTokens: z.number().int().nonnegative().default(8000),
  maxWorkerTokens: z.number().int().nonnegative().default(40000),
  premiumTokensUsed: z.number().int().nonnegative().default(0),
  hostTokensUsed: z.number().int().nonnegative().default(0),
  workerTokensUsed: z.number().int().nonnegative().default(0),
  estimatedPremiumTokensAvoided: z.number().int().nonnegative().default(0),
});

export const WorkerLeaseSchema = z.object({
  workerId: z.string().min(1),
  template: z.string().min(1),
  modelTier: ModelTierSchema.extract(['cheap', 'standard']),
  task: z.string().min(1),
  status: WorkerLeaseStatusSchema.default('queued'),
  maxTokens: z.number().int().positive().default(6000),
});

export const WorkerEventSchema = z.object({
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  type: WorkerEventTypeSchema,
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  severity: RiskLevelSchema.default('low'),
  confidence: z.number().min(0).max(1).default(0.75),
  needsBoss: z.boolean().default(false),
  createdAt: z.string().datetime().optional(),
});

export const RuntimeSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  userGoal: z.string().min(1),
  status: RuntimeSessionStatusSchema.default('routing'),
  hostModel: z.string().default('standard'),
  bossModel: z.string().optional(),
  routeDecision: z.unknown().optional(),
  workers: z.array(WorkerLeaseSchema).default([]),
  events: z.array(WorkerEventSchema).default([]),
  budget: RuntimeBudgetStateSchema.default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const EscalationPacketSchema = z.object({
  sessionId: z.string().min(1),
  userGoal: z.string().min(1),
  hostAssessment: z.string().min(1),
  decisionNeeded: BossVerdictSchema,
  workerFindings: z.array(WorkerFindingSchema).default([]),
  conflicts: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  triggeringEvents: z.array(WorkerEventSchema).default([]),
  budget: RuntimeBudgetStateSchema,
});

export const BossDecisionSchema = z.object({
  verdict: BossVerdictSchema,
  confidence: z.number().min(0).max(1),
  reasoningSummary: z.string().min(1),
  requiredChanges: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).default([]),
  forbiddenActions: z.array(z.string()).default([]),
});

export const QualityGateInputSchema = z.object({
  findings: z.array(WorkerFindingSchema).default([]),
  events: z.array(WorkerEventSchema).default([]),
  minConfidence: z.number().min(0).max(1).default(0.75),
  requireEvidence: z.boolean().default(true),
});

export const QualityGateResultSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'escalate', 'block']),
  usableFindings: z.array(WorkerFindingSchema),
  discardedFindings: z.array(WorkerFindingSchema),
  reasons: z.array(z.string()),
  needsBoss: z.boolean(),
});

export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type EscalationPacket = z.infer<typeof EscalationPacketSchema>;
export type BossDecision = z.infer<typeof BossDecisionSchema>;
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

const sessions = new Map<string, RuntimeSessionState>();

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export const workerTemplates = {
  extractor: { modelTier: 'cheap', maxTokens: 5000, description: 'Extract explicit facts with evidence only.' },
  summarizer: { modelTier: 'cheap', maxTokens: 7000, description: 'Compress long context into evidence-backed bullets.' },
  classifier: { modelTier: 'cheap', maxTokens: 2500, description: 'Classify task, risk, and source dependency.' },
  comparator: { modelTier: 'cheap', maxTokens: 6000, description: 'Compare two sources and identify differences.' },
  coding_brief: { modelTier: 'standard', maxTokens: 8000, description: 'Map files, symbols, risks, and tests for code work.' },
  research_brief: { modelTier: 'cheap', maxTokens: 8000, description: 'Summarize browser/search results with citations.' },
  checklist: { modelTier: 'cheap', maxTokens: 3000, description: 'Create operational checklist from known facts.' },
} as const;

export function createRuntimeSession(input: z.input<typeof RuntimeContextSchema>): RuntimeSessionState {
  const context = RuntimeContextSchema.parse(input);
  const decision = choosePipeline(context);
  const started = now();
  const session: RuntimeSessionState = RuntimeSessionStateSchema.parse({
    sessionId: id('session'),
    userGoal: context.request,
    status: decision.useWorker ? 'working' : 'routing',
    hostModel: decision.hostTier,
    bossModel: decision.allowEscalation ? 'premium' : undefined,
    routeDecision: decision,
    workers: [],
    events: [],
    budget: {
      maxPremiumTokens: decision.risk === 'critical' ? 6000 : 3000,
      maxHostTokens: decision.maxContextTokens,
      maxWorkerTokens: decision.useWorker ? 50000 : 0,
      premiumTokensUsed: 0,
      hostTokensUsed: estimateTokens(context.request),
      workerTokensUsed: 0,
      estimatedPremiumTokensAvoided: Math.max(0, context.estimatedContextTokens - decision.maxContextTokens),
    },
    createdAt: started,
    updatedAt: started,
  });
  sessions.set(session.sessionId, session);
  return session;
}

export function getRuntimeSession(sessionId: string): RuntimeSessionState | undefined {
  return sessions.get(sessionId);
}

export function listRuntimeSessions(): RuntimeSessionState[] {
  return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function dispatchWorker(sessionId: string, templateName: keyof typeof workerTemplates, task: string): RuntimeSessionState {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const template = workerTemplates[templateName];
  const worker: WorkerLease = WorkerLeaseSchema.parse({
    workerId: id('worker'),
    template: templateName,
    modelTier: template.modelTier,
    task,
    status: 'running',
    maxTokens: template.maxTokens,
  });
  const updated = RuntimeSessionStateSchema.parse({
    ...session,
    status: 'working',
    workers: [...session.workers, worker],
    updatedAt: now(),
  });
  sessions.set(sessionId, updated);
  return updated;
}

export function recordWorkerEvent(input: z.input<typeof WorkerEventSchema>): RuntimeSessionState {
  const event = WorkerEventSchema.parse({ ...input, createdAt: input.createdAt || now() });
  const session = sessions.get(event.sessionId);
  if (!session) throw new Error('Runtime session not found');
  const needsPause = event.needsBoss || event.severity === 'critical' || event.type === 'risk' || event.type === 'conflict';
  const updatedWorkers = session.workers.map((worker) => worker.workerId === event.workerId && needsPause
    ? { ...worker, status: 'paused' as const }
    : worker);
  const updated = RuntimeSessionStateSchema.parse({
    ...session,
    status: needsPause ? 'paused' : session.status,
    workers: updatedWorkers,
    events: [...session.events, event],
    budget: {
      ...session.budget,
      workerTokensUsed: session.budget.workerTokensUsed + estimateTokens(event.summary + event.evidence.join('\n')),
    },
    updatedAt: now(),
  });
  sessions.set(event.sessionId, updated);
  return updated;
}

export function runQualityGate(input: z.input<typeof QualityGateInputSchema>): QualityGateResult {
  const parsed = QualityGateInputSchema.parse(input);
  const usableFindings = parsed.findings.filter((finding) => {
    const hasEvidence = !parsed.requireEvidence || finding.evidence.length > 0;
    return hasEvidence && finding.confidence >= parsed.minConfidence;
  });
  const discardedFindings = parsed.findings.filter((finding) => !usableFindings.includes(finding));
  const severeEvents = parsed.events.filter((event) => event.needsBoss || event.severity === 'high' || event.severity === 'critical');
  const reasons = [
    ...discardedFindings.map((finding) => `discarded:${finding.claim}`),
    ...severeEvents.map((event) => `event:${event.type}:${event.summary}`),
  ];
  const needsBoss = severeEvents.length > 0 || discardedFindings.some((finding) => finding.risk === 'high' || finding.risk === 'critical');
  const verdict = needsBoss ? 'escalate' : discardedFindings.length ? 'revise' : 'pass';
  return QualityGateResultSchema.parse({ verdict, usableFindings, discardedFindings, reasons, needsBoss });
}

export function buildEscalationPacket(sessionId: string, hostAssessment = 'Host requests Boss review.'): EscalationPacket {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const triggeringEvents = session.events.filter((event) => event.needsBoss || event.severity === 'high' || event.severity === 'critical' || event.type === 'conflict' || event.type === 'risk');
  const conflicts = session.events.filter((event) => event.type === 'conflict').map((event) => event.summary);
  const unknowns = session.events.filter((event) => event.confidence < 0.6).map((event) => event.summary);
  return EscalationPacketSchema.parse({
    sessionId,
    userGoal: session.userGoal,
    hostAssessment,
    decisionNeeded: triggeringEvents.length ? 'approve' : 'revise',
    workerFindings: [],
    conflicts,
    unknowns,
    triggeringEvents,
    budget: session.budget,
  });
}

export function applyBossDecision(sessionId: string, decisionInput: z.input<typeof BossDecisionSchema>): RuntimeSessionState {
  const decision = BossDecisionSchema.parse(decisionInput);
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Runtime session not found');
  const status = decision.verdict === 'block' ? 'failed' : decision.verdict === 'ask_user' ? 'paused' : 'working';
  const event: WorkerEvent = WorkerEventSchema.parse({
    sessionId,
    workerId: 'boss',
    type: decision.verdict === 'block' ? 'risk' : 'progress',
    summary: `Boss decision: ${decision.verdict}. ${decision.reasoningSummary}`,
    evidence: decision.requiredChanges,
    severity: decision.verdict === 'block' ? 'critical' : 'medium',
    confidence: decision.confidence,
    needsBoss: false,
    createdAt: now(),
  });
  const updated = RuntimeSessionStateSchema.parse({
    ...session,
    status,
    events: [...session.events, event],
    budget: {
      ...session.budget,
      premiumTokensUsed: session.budget.premiumTokensUsed + estimateTokens(JSON.stringify(decision)),
    },
    updatedAt: now(),
  });
  sessions.set(sessionId, updated);
  return updated;
}

export function getRuntimeModels() {
  return {
    roles: [
      { role: 'host', tier: 'standard', purpose: 'middleman, user-facing routing, supervision, synthesis' },
      { role: 'boss', tier: 'premium', purpose: 'rare high-risk judgment on escalation packets' },
      { role: 'worker', tier: 'cheap|standard', purpose: 'high-volume bounded context/tool work' },
    ],
    workerTemplates,
  };
}
