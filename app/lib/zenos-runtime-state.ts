import { z } from 'zod';
import { ModelTierSchema, RiskLevelSchema, RouteDecisionSchema, WorkerFindingSchema } from './zenos-runtime';
import { RuntimeModelSlotsSchema } from './zenos-runtime-model-config';

export const AgentRoleSchema = z.enum(['host', 'boss', 'worker', 'verifier']);
export const WorkerEventTypeSchema = z.enum(['progress', 'finding', 'risk', 'conflict', 'tool_result', 'done', 'error']);
export const RuntimeSessionStatusSchema = z.enum([
  'routing',
  'working',
  'paused',
  'boss_review',
  'revising',
  'finalizing',
  'done',
  'failed',
  'cancelled',
]);
export const WorkerLeaseStatusSchema = z.enum(['queued', 'running', 'paused', 'done', 'failed', 'cancelled']);
export const BossVerdictSchema = z.enum(['approve', 'revise', 'block', 'ask_user', 'delegate']);
export const RuntimeRunStatusSchema = z.enum(['queued', 'running', 'revising', 'escalated', 'done', 'failed', 'blocked', 'abandoned']);

export const RuntimeBudgetStateSchema = z.object({
  maxPremiumTokens: z.number().int().nonnegative().default(6_000),
  maxHostTokens: z.number().int().nonnegative().default(12_000),
  maxWorkerTokens: z.number().int().nonnegative().default(40_000),
  maxModelCalls: z.number().int().positive().default(8),
  premiumTokensUsed: z.number().int().nonnegative().default(0),
  hostTokensUsed: z.number().int().nonnegative().default(0),
  workerTokensUsed: z.number().int().nonnegative().default(0),
  verifierTokensUsed: z.number().int().nonnegative().default(0),
  modelCallsUsed: z.number().int().nonnegative().default(0),
  estimatedPremiumTokensAvoided: z.number().int().nonnegative().default(0),
});

export const WorkerLeaseSchema = z.object({
  workerId: z.string().min(1),
  template: z.string().min(1),
  modelTier: ModelTierSchema.extract(['cheap', 'standard']),
  task: z.string().min(1).max(20_000),
  status: WorkerLeaseStatusSchema.default('queued'),
  maxTokens: z.number().int().positive().max(50_000).default(6_000),
  attempts: z.number().int().nonnegative().default(0),
  result: z.unknown().optional(),
  error: z.string().max(4_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const WorkerEventSchema = z.object({
  eventId: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  type: WorkerEventTypeSchema,
  summary: z.string().min(1).max(20_000),
  evidence: z.array(z.string().max(4_000)).max(20).default([]),
  severity: RiskLevelSchema.default('low'),
  confidence: z.number().min(0).max(1).default(0.75),
  needsBoss: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime().optional(),
});

export const RuntimeSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  userGoal: z.string().min(1).max(100_000),
  status: RuntimeSessionStatusSchema.default('routing'),
  hostModel: z.string().default('standard'),
  bossModel: z.string().optional(),
  modelOverrides: RuntimeModelSlotsSchema.default({}),
  routeDecision: RouteDecisionSchema.optional(),
  workers: z.array(WorkerLeaseSchema).default([]),
  events: z.array(WorkerEventSchema).default([]),
  budget: RuntimeBudgetStateSchema.default({}),
  finalAnswer: z.string().max(200_000).optional(),
  lastError: z.string().max(8_000).optional(),
  activeRunId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  version: z.number().int().nonnegative().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const EscalationPacketSchema = z.object({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  userGoal: z.string().min(1),
  hostAssessment: z.string().min(1),
  currentDraft: z.string().default(''),
  decisionNeeded: BossVerdictSchema,
  workerFindings: z.array(WorkerFindingSchema).default([]),
  verifierIssues: z.array(z.object({
    severity: RiskLevelSchema,
    issue: z.string(),
    evidence: z.string().default(''),
    requiredFix: z.string().default(''),
  })).default([]),
  conflicts: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  triggeringEvents: z.array(WorkerEventSchema).default([]),
  budget: RuntimeBudgetStateSchema,
});

export const BossDecisionSchema = z.object({
  verdict: BossVerdictSchema,
  confidence: z.number().min(0).max(1),
  reasoningSummary: z.string().min(1).max(12_000),
  requiredChanges: z.array(z.string().max(4_000)).max(20).default([]),
  allowedActions: z.array(z.string().max(4_000)).max(20).default([]),
  forbiddenActions: z.array(z.string().max(4_000)).max(20).default([]),
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

export const RuntimeRunRecordSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().optional(),
  requestHash: z.string().min(1),
  status: RuntimeRunStatusSchema,
  decision: RouteDecisionSchema.optional(),
  result: z.unknown().optional(),
  errors: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime().optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});

export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type EscalationPacket = z.infer<typeof EscalationPacketSchema>;
export type BossDecision = z.infer<typeof BossDecisionSchema>;
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;
export type RuntimeRunRecord = z.infer<typeof RuntimeRunRecordSchema>;

export const workerTemplates = {
  extractor: {
    modelTier: 'cheap',
    maxTokens: 5_000,
    description: 'Extract explicit facts, entities, constraints, and evidence without interpretation.',
  },
  summarizer: {
    modelTier: 'cheap',
    maxTokens: 7_000,
    description: 'Compress long context into decision-grade, evidence-backed bullets.',
  },
  classifier: {
    modelTier: 'cheap',
    maxTokens: 2_500,
    description: 'Classify task, risk, source dependency, and unresolved ambiguity.',
  },
  comparator: {
    modelTier: 'cheap',
    maxTokens: 6_000,
    description: 'Compare sources, contracts, or outputs and identify material differences.',
  },
  coding_brief: {
    modelTier: 'standard',
    maxTokens: 8_000,
    description: 'Map affected files, symbols, risks, dependencies, and validation commands for code work.',
  },
  research_brief: {
    modelTier: 'cheap',
    maxTokens: 8_000,
    description: 'Summarize research sources with evidence references, contradictions, and unknowns.',
  },
  checklist: {
    modelTier: 'cheap',
    maxTokens: 3_000,
    description: 'Create a bounded operational checklist from verified facts.',
  },
  verifier_preflight: {
    modelTier: 'cheap',
    maxTokens: 3_000,
    description: 'Check a proposed answer or action against evidence, safety, and validation requirements.',
  },
} as const;

export type WorkerTemplateName = keyof typeof workerTemplates;
