import { z } from 'zod';
import { normalizeWorkspacePath } from './execution-boundary';
import { LatencyBudgetPlanSchema, LatencyObservationSchema } from './latency-budget';
import { RouteDecision, RuntimeContextSchema, WorkerResultSchema } from './zenos-runtime';
import { RuntimeRunRequestSchema } from './zenos-runtime-executor';
import { BossDecisionSchema } from './zenos-runtime-state';
import { MemoryCoverage } from './zenos-memory-client';

export const GatewayModelIdentitySchema = z.object({
  model: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(200),
});

export const GatewayContextMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().max(24_000),
  name: z.string().trim().max(200).optional(),
  tool_call_id: z.string().trim().max(500).optional(),
});

const GatewayWorkspaceRootSchema = z.string().trim().min(1).max(4_096).transform(normalizeWorkspacePath);

export const GatewayWorkspaceFileSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exists: z.boolean(),
});

export const GatewayWorkspaceStateSchema = z.object({
  workspaceRoot: GatewayWorkspaceRootSchema,
  gitHead: z.string().trim().max(200).default(''),
  dirtyDiffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  changedFiles: z.array(GatewayWorkspaceFileSchema).max(200).default([]),
  clean: z.boolean(),
  capturedAt: z.string().datetime(),
});

export const GatewayTurnPreflightRequestSchema = RuntimeContextSchema.extend({
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  platform: z.string().trim().min(1).max(80).default('gateway'),
  host: GatewayModelIdentitySchema,
  context: z.string().max(120_000).optional().default(''),
  handoffMessages: z.array(GatewayContextMessageSchema).max(400).optional().default([]),
  workspaceRoot: GatewayWorkspaceRootSchema.optional(),
  workspaceState: GatewayWorkspaceStateSchema.nullish().transform((value) => value ?? undefined),
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
  workspaceState: GatewayWorkspaceStateSchema.nullish().transform((value) => value ?? undefined),
  failed: z.boolean().optional().default(false),
  hostUsage: z.object({
    inputTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().default(0),
    calls: z.number().int().nonnegative().max(500).default(1),
    source: z.enum(['provider', 'estimate', 'hermes-session-delta']).default('hermes-session-delta'),
    valid: z.boolean().default(true),
    invalidReason: z.string().max(2_000).optional(),
    providerRequestId: z.string().max(500).optional(),
  }).optional().default({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 1,
    source: 'hermes-session-delta',
    valid: true,
  }),
  hostDurationMs: z.number().int().nonnegative().max(86_400_000).optional().default(0),
});

export const GatewayHostPlanSchema = z.object({
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

export type GatewayHostPlan = z.infer<typeof GatewayHostPlanSchema>;
export type GatewayMemoryBrief = {
  context: string;
  source: 'none' | 'handoff' | 'recall' | 'bootstrap';
  coverage?: MemoryCoverage;
  degraded?: boolean;
  cacheHit?: boolean;
  latencyMs?: number;
};

export const StoredGatewayPreflightSchema = z.object({
  kind: z.enum(['gateway_preflight_v1', 'gateway_preflight_v2']),
  input: RuntimeRunRequestSchema,
  turnId: z.string(),
  platform: z.string(),
  host: GatewayModelIdentitySchema,
  hostPlan: GatewayHostPlanSchema.optional(),
  cognitivePacket: z.unknown().optional(),
  cognitiveTaskId: z.string().optional(),
  continuationCapsule: z.unknown().optional(),
  hostPlanCall: z.unknown().optional(),
  workerResult: WorkerResultSchema.optional(),
  workerCall: z.unknown().optional(),
  bossPreflight: BossDecisionSchema.optional(),
  bossCall: z.unknown().optional(),
  repositoryContext: z.string().optional(),
  memorySource: z.string().optional(),
  memoryCoverage: z.number().min(0).max(1).optional(),
  latencyPlan: LatencyBudgetPlanSchema.optional(),
  preflightLatency: z.array(LatencyObservationSchema).default([]),
  turnStartedAtMs: z.number().int().nonnegative().optional(),
  holdFinalDelivery: z.boolean(),
  codingTaskId: z.string().optional(),
  codingPhase: z.string().optional(),
  workspaceState: GatewayWorkspaceStateSchema.nullish().transform((value) => value ?? undefined),
});

export type GatewayTurnPreflightRequest = z.output<typeof GatewayTurnPreflightRequestSchema>;
export type GatewayTurnPreflightInput = z.input<typeof GatewayTurnPreflightRequestSchema>;
export type GatewayTurnPostflightInput = z.input<typeof GatewayTurnPostflightRequestSchema>;
export type StoredGatewayPreflight = z.infer<typeof StoredGatewayPreflightSchema>;

export type GatewayTurnReceipt = {
  pipeline: RouteDecision['pipelineMode'];
  host: { model: string; provider: string; invoked: boolean; plannerInvoked?: boolean; calls?: number };
  worker: { model?: string; provider?: string; invoked: boolean; ok?: boolean };
  verifier: { model?: string; provider?: string; invoked: boolean; verdict?: string; ok?: boolean };
  boss: { model?: string; provider?: string; invoked: boolean; verdict?: string; ok?: boolean };
  transformed: boolean;
};

export const GatewayHostBudgetSchema = z.object({
  budgetId: z.string(),
  reservationId: z.string(),
  reservedTokens: z.number().int().nonnegative(),
  maxCalls: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  accounting: z.literal('uncached-input-plus-cache-write-plus-output'),
});
