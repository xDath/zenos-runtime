import * as crypto from 'node:crypto';
import { z } from 'zod';
import { LatencyObservationSchema, latencySummary } from './latency-budget';
import { incrementMetric } from './metrics';
import { RouteDecisionSchema } from './zenos-runtime';
import type { RuntimeModelResult } from './zenos-runtime-executor';
import { getRuntimeStore } from './zenos-runtime-store';

export const OUTCOME_LEDGER_VERSION = 'etla-outcome-passport-v2';

const RoleUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  invalidSamples: z.number().int().nonnegative().default(0),
});

const ShadowRouteSchema = z.object({
  recommendation: z.enum(['retain', 'cheaper_candidate', 'stronger_candidate']),
  pipelineMode: z.enum(['direct_fast_path', 'grounded_path', 'worker_compression_path', 'verified_path', 'escalated_deep_path']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(12),
  eligibleForAutomaticUse: z.literal(false),
});

export const OutcomePassportSchema = z.object({
  ledgerVersion: z.literal(OUTCOME_LEDGER_VERSION),
  outcomeId: z.string(),
  runId: z.string(),
  sessionId: z.string().optional(),
  routeFingerprint: z.string(),
  requestFingerprint: z.string(),
  decision: RouteDecisionSchema,
  verdict: z.enum(['success', 'revised', 'blocked', 'failed']),
  transformed: z.boolean(),
  roleUsage: z.record(z.string(), RoleUsageSchema),
  latency: z.object({
    observations: z.array(LatencyObservationSchema),
    withinBudget: z.boolean(),
    hardBreaches: z.array(z.string()),
    softBreaches: z.array(z.string()),
  }),
  quality: z.object({
    verifierVerdict: z.string().optional(),
    verifierConfidence: z.number().min(0).max(1).optional(),
    bossVerdict: z.string().optional(),
    bossConfidence: z.number().min(0).max(1).optional(),
    evidenceCoverage: z.number().min(0).max(1).optional(),
    memorySource: z.string().optional(),
    modelFingerprint: z.string().min(1),
    models: z.array(z.string()).default([]),
  }),
  shadowRoute: ShadowRouteSchema,
  userFeedback: z.object({
    score: z.number().min(0).max(1).optional(),
    accepted: z.boolean().optional(),
    note: z.string().max(4_000).optional(),
  }).optional(),
  createdAt: z.string().datetime(),
});
export type OutcomePassport = z.infer<typeof OutcomePassportSchema>;

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function usageFromCalls(calls: RuntimeModelResult[], hostUsage?: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
  valid?: boolean;
}) {
  const empty = () => ({
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    invalidSamples: 0,
  });
  const usage: Record<string, ReturnType<typeof empty>> = {
    hermes_host: empty(),
    runtime_host: empty(),
    worker: empty(),
    verifier: empty(),
    boss: empty(),
  };
  if (hostUsage) {
    usage.hermes_host = {
      calls: hostUsage.calls,
      inputTokens: hostUsage.inputTokens,
      cacheReadTokens: hostUsage.cacheReadTokens,
      cacheWriteTokens: hostUsage.cacheWriteTokens,
      outputTokens: hostUsage.outputTokens,
      reasoningTokens: hostUsage.reasoningTokens,
      totalTokens: hostUsage.inputTokens + hostUsage.cacheReadTokens + hostUsage.cacheWriteTokens + hostUsage.outputTokens,
      invalidSamples: hostUsage.valid === false ? 1 : 0,
    };
  }
  for (const call of calls) {
    const key = call.role === 'host' ? 'runtime_host' : call.role;
    const target = usage[key] || (usage[key] = empty());
    const modelUsage = call.usage;
    target.calls += 1;
    target.inputTokens += modelUsage?.inputTokens || 0;
    target.cacheReadTokens += modelUsage?.cacheReadTokens || 0;
    target.cacheWriteTokens += modelUsage?.cacheWriteTokens || 0;
    target.outputTokens += modelUsage?.outputTokens || 0;
    target.reasoningTokens += modelUsage?.reasoningTokens || 0;
    target.totalTokens += modelUsage?.totalTokens
      || (modelUsage?.inputTokens || 0) + (modelUsage?.cacheReadTokens || 0) + (modelUsage?.cacheWriteTokens || 0) + (modelUsage?.outputTokens || 0);
    if (modelUsage?.valid === false) target.invalidSamples += 1;
  }
  return usage;
}

function shadowRoute(input: {
  decision: z.infer<typeof RouteDecisionSchema>;
  verdict: OutcomePassport['verdict'];
  transformed: boolean;
  verifierVerdict?: string;
  hardLatencyBreaches: string[];
}): z.infer<typeof ShadowRouteSchema> {
  const reasons: string[] = [];
  if (input.verdict === 'success'
    && !input.transformed
    && !input.verifierVerdict
    && input.decision.risk === 'low'
    && input.decision.pipelineMode !== 'direct_fast_path') {
    reasons.push('Successful unchanged answer did not need a postflight correction.');
    if (input.hardLatencyBreaches.length) reasons.push(`Latency pressure observed in: ${input.hardLatencyBreaches.join(', ')}.`);
    return {
      recommendation: 'cheaper_candidate',
      pipelineMode: input.decision.useMemory || input.decision.useTools ? 'grounded_path' : 'direct_fast_path',
      confidence: input.hardLatencyBreaches.length ? 0.82 : 0.68,
      reasons,
      eligibleForAutomaticUse: false,
    };
  }
  if (input.verdict === 'failed' || input.verdict === 'blocked' || input.verifierVerdict === 'revise') {
    reasons.push('The observed outcome required correction, failed, or was blocked.');
    return {
      recommendation: 'stronger_candidate',
      pipelineMode: input.decision.useBoss ? 'escalated_deep_path' : 'verified_path',
      confidence: input.verdict === 'failed' ? 0.85 : 0.72,
      reasons,
      eligibleForAutomaticUse: false,
    };
  }
  return {
    recommendation: 'retain',
    pipelineMode: input.decision.pipelineMode,
    confidence: 0.75,
    reasons: ['Observed outcome does not justify a deterministic routing change.'],
    eligibleForAutomaticUse: false,
  };
}

export function recordOutcomePassport(input: {
  runId: string;
  sessionId?: string;
  request: string;
  decision: z.input<typeof RouteDecisionSchema>;
  verdict: OutcomePassport['verdict'];
  transformed: boolean;
  calls: RuntimeModelResult[];
  hostUsage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    calls: number;
    valid?: boolean;
  };
  latencyObservations?: z.input<typeof LatencyObservationSchema>[];
  verifierVerdict?: string;
  verifierConfidence?: number;
  bossVerdict?: string;
  bossConfidence?: number;
  evidenceCoverage?: number;
  memorySource?: string;
  hostModel?: string;
  hostProvider?: string;
}): OutcomePassport {
  const decision = RouteDecisionSchema.parse(input.decision);
  const observations = (input.latencyObservations || []).map((item) => LatencyObservationSchema.parse(item));
  const latency = latencySummary(observations);
  const createdAt = new Date().toISOString();
  const outcomeId = `outcome_${crypto.randomUUID()}`;
  const models = [...new Set([
    input.hostModel && `hermes:${input.hostProvider || 'default'}:${input.hostModel}`,
    ...input.calls.map((call) => `${call.role}:${call.provider}:${call.model}`),
  ].filter((value): value is string => Boolean(value)))].sort();
  const modelFingerprint = hash(models).slice(0, 24);
  const passport = OutcomePassportSchema.parse({
    ledgerVersion: OUTCOME_LEDGER_VERSION,
    outcomeId,
    runId: input.runId,
    sessionId: input.sessionId,
    routeFingerprint: hash({
      policyVersion: decision.policyVersion,
      taskType: decision.taskType,
      pipelineMode: decision.pipelineMode,
      risk: decision.risk,
      roles: { worker: decision.useWorker, verifier: decision.useVerifier, boss: decision.useBoss },
    }).slice(0, 32),
    requestFingerprint: hash(input.request).slice(0, 32),
    decision,
    verdict: input.verdict,
    transformed: input.transformed,
    roleUsage: usageFromCalls(input.calls, input.hostUsage),
    latency: { observations, ...latency },
    quality: {
      verifierVerdict: input.verifierVerdict,
      verifierConfidence: input.verifierConfidence,
      bossVerdict: input.bossVerdict,
      bossConfidence: input.bossConfidence,
      evidenceCoverage: input.evidenceCoverage,
      memorySource: input.memorySource,
      modelFingerprint,
      models,
    },
    shadowRoute: shadowRoute({
      decision,
      verdict: input.verdict,
      transformed: input.transformed,
      verifierVerdict: input.verifierVerdict,
      hardLatencyBreaches: latency.hardBreaches,
    }),
    createdAt,
  });
  getRuntimeStore().appendOutcome({
    outcomeId,
    runId: input.runId,
    sessionId: input.sessionId,
    ledgerVersion: OUTCOME_LEDGER_VERSION,
    verdict: passport.verdict,
    taskType: decision.taskType,
    pipelineMode: decision.pipelineMode,
    record: passport,
    createdAt,
  });
  incrementMetric('runtime_outcomes_total', {
    verdict: passport.verdict,
    task: decision.taskType,
    shadow: passport.shadowRoute.recommendation,
  });
  return passport;
}

export function buildOutcomeAnalytics(records = getRuntimeStore().listOutcomes(500)) {
  const latestByRun = new Map<string, OutcomePassport>();
  for (const record of [...records].reverse()) {
    const parsed = OutcomePassportSchema.safeParse(record.record);
    if (parsed.success) latestByRun.set(parsed.data.runId, parsed.data);
  }
  const passports = [...latestByRun.values()];
  const groups = new Map<string, OutcomePassport[]>();
  for (const passport of passports) {
    const key = `${passport.decision.taskType}:${passport.decision.pipelineMode}:${passport.quality.modelFingerprint}`;
    groups.set(key, [...(groups.get(key) || []), passport]);
  }
  const routes = [...groups.entries()].map(([key, items]) => {
    const successes = items.filter((item) => item.verdict === 'success' || item.verdict === 'revised').length;
    const blockedOrFailed = items.filter((item) => item.verdict === 'blocked' || item.verdict === 'failed').length;
    const accepted = items.filter((item) => item.userFeedback?.accepted === true).length;
    const feedbackCount = items.filter((item) => item.userFeedback?.accepted !== undefined).length;
    const totalTokens = items.reduce((sum, item) => sum + Object.values(item.roleUsage).reduce((roleSum, usage) => roleSum + usage.totalTokens, 0), 0);
    const totalLatency = items.reduce((sum, item) => sum + (item.latency.observations.find((entry) => entry.component === 'total')?.durationMs || 0), 0);
    const invalidUsageSamples = items.reduce(
      (sum, item) => sum + Object.values(item.roleUsage).reduce((roleSum, usage) => roleSum + usage.invalidSamples, 0),
      0,
    );
    const cheaperVotes = items.filter((item) => item.shadowRoute.recommendation === 'cheaper_candidate').length;
    const strongerVotes = items.filter((item) => item.shadowRoute.recommendation === 'stronger_candidate').length;
    const sampleSize = items.length;
    const successRate = sampleSize ? successes / sampleSize : 0;
    const failureRate = sampleSize ? blockedOrFailed / sampleSize : 0;
    const feedbackAcceptanceRate = feedbackCount ? accepted / feedbackCount : undefined;
    const candidate = cheaperVotes > strongerVotes
      ? 'cheaper_candidate'
      : strongerVotes > cheaperVotes
        ? 'stronger_candidate'
        : 'retain';
    const evidenceReady = sampleSize >= 100
      && invalidUsageSamples === 0
      && successRate >= 0.9
      && failureRate <= 0.03
      && feedbackCount >= 10
      && feedbackAcceptanceRate !== undefined
      && feedbackAcceptanceRate >= 0.85;
    return {
      key,
      taskType: items[0].decision.taskType,
      pipelineMode: items[0].decision.pipelineMode,
      modelFingerprint: items[0].quality.modelFingerprint,
      models: items[0].quality.models,
      sampleSize,
      successRate,
      failureRate,
      feedbackAcceptanceRate,
      averageTokens: sampleSize ? Math.round(totalTokens / sampleSize) : 0,
      averageLatencyMs: sampleSize ? Math.round(totalLatency / sampleSize) : 0,
      invalidUsageSamples,
      feedbackCount,
      shadowVotes: { cheaper: cheaperVotes, stronger: strongerVotes, retain: sampleSize - cheaperVotes - strongerVotes },
      recommendation: candidate,
      evidenceReady,
      automaticPromotionAllowed: false,
      promotionRequirements: [
        'minimum 100 clean outcomes for the same task, route, and model fingerprint',
        'success rate at least 90%',
        'blocked/failed rate at most 3%',
        'zero invalid token-usage samples',
        'at least 10 explicit feedback samples with acceptance at least 85%',
        'explicit human promotion approval',
      ],
    };
  }).sort((left, right) => right.sampleSize - left.sampleSize);
  return {
    version: 'etla-no-regret-board-v1',
    mode: 'shadow-only',
    runCount: passports.length,
    routes,
    automaticPromotionAllowed: false,
  } as const;
}

export function appendOutcomeFeedback(input: {
  runId: string;
  score?: number;
  accepted?: boolean;
  note?: string;
}): OutcomePassport {
  const latest = getRuntimeStore().listOutcomes(1, { runId: input.runId })[0];
  if (!latest) throw new Error('No outcome passport exists for this run');
  const current = OutcomePassportSchema.parse(latest.record);
  const revised = OutcomePassportSchema.parse({
    ...current,
    outcomeId: `outcome_${crypto.randomUUID()}`,
    userFeedback: {
      score: input.score,
      accepted: input.accepted,
      note: input.note,
    },
    createdAt: new Date().toISOString(),
  });
  getRuntimeStore().appendOutcome({
    outcomeId: revised.outcomeId,
    runId: revised.runId,
    sessionId: revised.sessionId,
    ledgerVersion: OUTCOME_LEDGER_VERSION,
    verdict: revised.verdict,
    taskType: revised.decision.taskType,
    pipelineMode: revised.decision.pipelineMode,
    record: revised,
    createdAt: revised.createdAt,
  });
  incrementMetric('runtime_outcome_feedback_total', {
    accepted: input.accepted === undefined ? 'unknown' : String(input.accepted),
  });
  return revised;
}
