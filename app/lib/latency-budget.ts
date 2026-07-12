import { z } from 'zod';
import { incrementMetric, setGauge } from './metrics';
import { RouteDecision, TaskTypeSchema } from './zenos-runtime';
import { RuntimeRoleSchema } from './token-economy';

export const LatencyBudgetPlanSchema = z.object({
  version: z.literal('etla-latency-budget-v1'),
  taskType: TaskTypeSchema,
  totalMs: z.number().int().positive(),
  memoryMs: z.number().int().positive(),
  repositoryMs: z.number().int().positive(),
  hostMs: z.number().int().positive(),
  workerMs: z.number().int().positive(),
  verifierMs: z.number().int().positive(),
  bossMs: z.number().int().positive(),
  reserveMs: z.number().int().nonnegative(),
});
export type LatencyBudgetPlan = z.infer<typeof LatencyBudgetPlanSchema>;

export const LatencyObservationSchema = z.object({
  component: z.enum(['memory', 'repository', 'host', 'worker', 'verifier', 'boss', 'total']),
  durationMs: z.number().int().nonnegative(),
  budgetMs: z.number().int().positive(),
  status: z.enum(['within_budget', 'soft_breach', 'hard_breach']),
});
export type LatencyObservation = z.infer<typeof LatencyObservationSchema>;

const TOTALS: Record<z.infer<typeof TaskTypeSchema>, number> = {
  simple_chat: 15_000,
  memory_question: 24_000,
  repo_question: 38_000,
  coding_change: 120_000,
  debugging: 120_000,
  summarization: 55_000,
  planning_or_architecture: 70_000,
  security_or_secret: 90_000,
  deploy_or_destructive_action: 100_000,
  eval_or_benchmark: 90_000,
};

const PIPELINE_MINIMUMS: Record<RouteDecision['pipelineMode'], number> = {
  direct_fast_path: 15_000,
  grounded_path: 30_000,
  worker_compression_path: 55_000,
  verified_path: 75_000,
  escalated_deep_path: 100_000,
};

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function createLatencyBudgetPlan(decision: RouteDecision): LatencyBudgetPlan {
  const riskMultiplier = decision.risk === 'critical' ? 1.3 : decision.risk === 'high' ? 1.18 : 1;
  const totalMs = Math.max(TOTALS[decision.taskType], PIPELINE_MINIMUMS[decision.pipelineMode]) * riskMultiplier;
  const memoryShare = decision.useMemory ? 0.12 : 0.03;
  const repositoryShare = decision.useTools ? 0.16 : 0.03;
  const workerShare = decision.useWorker ? 0.28 : 0.03;
  const verifierShare = decision.useVerifier ? 0.18 : 0.02;
  const bossActive = decision.useBoss || decision.allowEscalation;
  const bossShare = bossActive ? 0.12 : 0.02;
  const reserveShare = 0.12;
  const hostShare = Math.max(0.22, 1 - memoryShare - repositoryShare - workerShare - verifierShare - bossShare - reserveShare);
  const plan = LatencyBudgetPlanSchema.parse({
    version: 'etla-latency-budget-v1',
    taskType: decision.taskType,
    totalMs: bounded(totalMs, 10_000, 180_000),
    memoryMs: bounded(totalMs * memoryShare, decision.useMemory ? 8_000 : 2_000, 25_000),
    repositoryMs: bounded(totalMs * repositoryShare, decision.useTools ? 10_000 : 2_000, 30_000),
    hostMs: bounded(totalMs * hostShare, decision.pipelineMode === 'escalated_deep_path' ? 25_000 : 8_000, 90_000),
    workerMs: bounded(totalMs * workerShare, decision.useWorker ? 25_000 : 5_000, 90_000),
    verifierMs: bounded(totalMs * verifierShare, decision.useVerifier ? 20_000 : 5_000, 60_000),
    bossMs: bounded(totalMs * bossShare, bossActive ? 20_000 : 5_000, 60_000),
    reserveMs: bounded(totalMs * reserveShare, 0, 30_000),
  });
  setGauge('runtime_latency_budget_ms', plan.totalMs, { task: plan.taskType });
  return plan;
}

export function roleLatencyTimeout(plan: LatencyBudgetPlan, role: z.infer<typeof RuntimeRoleSchema>): number {
  return plan[`${role}Ms` as const];
}

export function remainingLatencyMs(plan: LatencyBudgetPlan, startedAtMs: number, componentBudgetMs: number): number {
  const totalRemaining = Math.max(0, plan.totalMs - (Date.now() - startedAtMs));
  return Math.max(1_000, Math.min(componentBudgetMs, totalRemaining || 1_000));
}

export function observeLatency(
  component: LatencyObservation['component'],
  durationMs: number,
  budgetMs: number,
): LatencyObservation {
  const ratio = budgetMs > 0 ? durationMs / budgetMs : 1;
  const status: LatencyObservation['status'] = ratio > 1.5
    ? 'hard_breach'
    : ratio > 1
      ? 'soft_breach'
      : 'within_budget';
  incrementMetric('runtime_latency_observations_total', { component, status });
  setGauge('runtime_latency_last_ms', durationMs, { component });
  return LatencyObservationSchema.parse({ component, durationMs, budgetMs, status });
}

export function latencySummary(observations: LatencyObservation[]): {
  withinBudget: boolean;
  hardBreaches: string[];
  softBreaches: string[];
} {
  return {
    withinBudget: observations.every((item) => item.status === 'within_budget'),
    hardBreaches: observations.filter((item) => item.status === 'hard_breach').map((item) => item.component),
    softBreaches: observations.filter((item) => item.status === 'soft_breach').map((item) => item.component),
  };
}
