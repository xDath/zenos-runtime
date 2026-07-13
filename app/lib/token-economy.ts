import * as crypto from 'node:crypto';
import { z } from 'zod';
import { incrementMetric, setGauge } from './metrics';
import { getRuntimeStore } from './zenos-runtime-store';
import { RiskLevelSchema, RouteDecision, RuntimeContextSchema, TaskTypeSchema } from './zenos-runtime';

export const RuntimeRoleSchema = z.enum(['worker', 'host', 'verifier', 'boss']);
export type RuntimeRole = z.infer<typeof RuntimeRoleSchema>;

export const RoleTokenBudgetSchema = z.object({
  inputTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  maxCalls: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
});

export const TokenBudgetPlanSchema = z.object({
  version: z.literal('etla-token-budget-v1'),
  budgetId: z.string().min(8).max(200),
  taskType: TaskTypeSchema,
  risk: RiskLevelSchema,
  totalTokens: z.number().int().positive(),
  worker: RoleTokenBudgetSchema,
  host: RoleTokenBudgetSchema,
  verifier: RoleTokenBudgetSchema,
  boss: RoleTokenBudgetSchema,
  reserveTokens: z.number().int().nonnegative(),
  reasons: z.array(z.string()).max(24),
});

export type RoleTokenBudget = z.infer<typeof RoleTokenBudgetSchema>;
export type TokenBudgetPlan = z.infer<typeof TokenBudgetPlanSchema>;

export type TokenUsageByRole = Record<RuntimeRole, { input: number; output: number; calls: number }>;

type EstimatorState = { scale: number; samples: number; meanAbsoluteError: number };
const DEFAULT_ESTIMATOR_KEY = 'default';
const estimatorStates = new Map<string, EstimatorState>();
let estimatorsLoaded = false;

function defaultEstimator(): EstimatorState {
  return {
    scale: Math.max(0.65, Math.min(1.8, Number(process.env.ZENOS_TOKEN_ESTIMATOR_SCALE || '1'))),
    samples: 0,
    meanAbsoluteError: 0,
  };
}

function loadEstimators(): void {
  if (estimatorsLoaded) return;
  estimatorsLoaded = true;
  try {
    const raw = getRuntimeStore().getMetaValue('token_estimator_v2');
    const parsed = raw ? JSON.parse(raw) as Record<string, EstimatorState> : {};
    for (const [model, state] of Object.entries(parsed)) {
      if (!state || !Number.isFinite(state.scale) || !Number.isFinite(state.samples)) continue;
      estimatorStates.set(model, {
        scale: Math.max(0.65, Math.min(1.8, state.scale)),
        samples: Math.max(0, Math.round(state.samples)),
        meanAbsoluteError: Math.max(0, Number(state.meanAbsoluteError || 0)),
      });
    }
  } catch {
    // Start with a conservative estimator if a previous calibration is unreadable.
  }
}

function estimatorFor(model = DEFAULT_ESTIMATOR_KEY): EstimatorState {
  loadEstimators();
  const key = model.trim() || DEFAULT_ESTIMATOR_KEY;
  const current = estimatorStates.get(key);
  if (current) return current;
  const created = defaultEstimator();
  estimatorStates.set(key, created);
  return created;
}

function persistEstimators(): void {
  getRuntimeStore().setMetaValue('token_estimator_v2', JSON.stringify(Object.fromEntries(estimatorStates)));
}

function baseTokenEstimate(text: string): number {
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7F]/g) || []).length;
  const nonAscii = Math.max(0, text.length - ascii);
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 2.2));
}

export function estimateTokenCount(text: string, model = DEFAULT_ESTIMATOR_KEY): number {
  const base = baseTokenEstimate(text);
  return base ? Math.max(1, Math.ceil(base * estimatorFor(model).scale)) : 0;
}

export function recordTokenEstimateCalibration(estimatedTokens: number, actualTokens: number, model = DEFAULT_ESTIMATOR_KEY): void {
  const state = estimatorFor(model);
  const estimated = Math.max(0, estimatedTokens);
  const actual = Math.max(0, actualTokens);
  if (estimated < 128 || actual < 128) return;
  const ratio = Math.max(0.5, Math.min(2, actual / estimated));
  const alpha = state.samples < 8 ? 0.16 : 0.06;
  state.scale = Math.max(0.65, Math.min(1.8, state.scale * (1 - alpha + alpha * ratio)));
  const absoluteError = Math.abs(actual - estimated) / actual;
  state.samples += 1;
  state.meanAbsoluteError += (absoluteError - state.meanAbsoluteError) / state.samples;
  persistEstimators();
  setGauge('runtime_token_estimator_scale', state.scale, { model });
  setGauge('runtime_token_estimator_mean_absolute_error', state.meanAbsoluteError, { model });
  incrementMetric('runtime_token_estimator_samples_total', { model });
}

export function tokenEstimatorSnapshot(model = DEFAULT_ESTIMATOR_KEY): EstimatorState {
  return { ...estimatorFor(model) };
}

export function resetTokenEstimatorForTests(): void {
  estimatorsLoaded = true;
  estimatorStates.clear();
  estimatorStates.set(DEFAULT_ESTIMATOR_KEY, { scale: 1, samples: 0, meanAbsoluteError: 0 });
}

function riskMultiplier(risk: z.infer<typeof RiskLevelSchema>): number {
  if (risk === 'critical') return 1.55;
  if (risk === 'high') return 1.3;
  if (risk === 'medium') return 1.1;
  return 0.9;
}

function taskBase(taskType: z.infer<typeof TaskTypeSchema>): number {
  const map: Record<z.infer<typeof TaskTypeSchema>, number> = {
    simple_chat: 3_500,
    memory_question: 5_000,
    repo_question: 8_000,
    coding_change: 14_000,
    debugging: 13_000,
    summarization: 9_000,
    planning_or_architecture: 11_000,
    security_or_secret: 12_000,
    deploy_or_destructive_action: 10_000,
    eval_or_benchmark: 11_000,
  };
  return map[taskType];
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function createTokenBudgetPlan(
  decision: RouteDecision,
  input: z.input<typeof RuntimeContextSchema>,
  options: {
    priorFailures?: number;
    userPriority?: 'economy' | 'balanced' | 'quality';
    budgetId?: string;
  } = {},
): TokenBudgetPlan {
  const context = RuntimeContextSchema.parse(input);
  const priority = options.userPriority || 'economy';
  const priorityMultiplier = priority === 'economy' ? 0.72 : priority === 'quality' ? 1.2 : 1;
  // Large context should trigger compaction, not automatically purchase a
  // proportionally larger orchestration budget.
  const sourcePressure = context.estimatedContextTokens > 20_000
    ? 1.1
    : context.estimatedContextTokens > 6_000
      ? 1.05
      : 1;
  const retryPressure = 1 + Math.min(Math.max(options.priorFailures || 0, 0), 3) * 0.08;
  const highAssurance = decision.risk === 'high' || decision.risk === 'critical';
  const orchestrationFloor = decision.useWorker && decision.useVerifier && decision.useBoss
    ? highAssurance ? 12_000 : 10_500
    : decision.useWorker && decision.useVerifier
      ? highAssurance ? 9_000 : 8_000
      : decision.useBoss
        ? highAssurance ? 7_000 : 6_000
      : 2_500;
  const totalTokens = bounded(
    Math.max(
      taskBase(decision.taskType) * riskMultiplier(decision.risk) * priorityMultiplier * sourcePressure * retryPressure,
      orchestrationFloor,
    ),
    2_500,
    48_000,
  );

  const bossEnabled = decision.useBoss || decision.allowEscalation;
  const workerShare = decision.useWorker ? (decision.taskType === 'summarization' ? 0.42 : 0.34) : 0.05;
  const verifierShare = decision.useVerifier ? 0.16 : 0.03;
  const bossShare = bossEnabled ? (decision.risk === 'critical' ? 0.09 : 0.055) : 0.015;
  const reserveShare = decision.risk === 'critical' ? 0.2 : 0.16;
  const hostShare = Math.max(0.18, 1 - workerShare - verifierShare - bossShare - reserveShare);

  const roleBudget = (
    share: number,
    outputRatio: number,
    maxCalls: number,
    maxRetries: number,
    timeoutMs: number,
    inputCap: number,
    outputCap: number,
    outputFloor = 64,
  ): RoleTokenBudget => {
    const allocation = totalTokens * share;
    return RoleTokenBudgetSchema.parse({
      inputTokens: bounded(allocation * (1 - outputRatio), 128, inputCap),
      outputTokens: bounded(allocation * outputRatio, outputFloor, outputCap),
      maxCalls,
      maxRetries,
      timeoutMs,
    });
  };

  const plan = TokenBudgetPlanSchema.parse({
    version: 'etla-token-budget-v1',
    budgetId: options.budgetId || `budget_${crypto.randomUUID()}`,
    taskType: decision.taskType,
    risk: decision.risk,
    totalTokens,
    worker: roleBudget(
      workerShare,
      0.28,
      decision.useWorker
        ? ['coding_change', 'debugging'].includes(decision.taskType)
          ? Math.min(2, Math.max(1, decision.maxWorkerCalls))
          : 1
        : 0,
      0,
      90_000,
      12_000,
      2_400,
      decision.useWorker ? 1_600 : 64,
    ),
    host: roleBudget(hostShare, 0.35, 1 + Math.min(1, decision.maxRevisionAttempts), 0, 120_000, 10_000, 3_200, 1_600),
    verifier: roleBudget(verifierShare, 0.35, decision.useVerifier ? 1 + Math.min(1, decision.maxRevisionAttempts) : 0, 0, 90_000, 5_000, 1_400, decision.useVerifier ? 1_200 : 64),
    boss: roleBudget(bossShare, 0.3, bossEnabled ? 1 : 0, 0, 120_000, 1_500, 500, bossEnabled ? 500 : 64),
    reserveTokens: bounded(totalTokens * reserveShare, 0, 12_000),
    reasons: [
      `task:${decision.taskType}`,
      `risk:${decision.risk}`,
      `priority:${priority}`,
      `context:${context.estimatedContextTokens}`,
      `worker:${decision.useWorker}`,
      `verifier:${decision.useVerifier}`,
      `boss:${decision.useBoss}`,
    ],
  });

  setGauge('runtime_budget_total_tokens', plan.totalTokens, { task: plan.taskType, risk: plan.risk });
  setGauge('runtime_budget_boss_tokens', plan.boss.inputTokens + plan.boss.outputTokens, { task: plan.taskType });
  return plan;
}

export function roleBudget(plan: TokenBudgetPlan, role: RuntimeRole): RoleTokenBudget {
  return plan[role];
}

const HIGH_SIGNAL_CONTEXT = /\b(must|must not|do not|don't|jangan|harus|error|failed|failure|bug|regression|blocker|unknown|decision|constraint|acceptance|test|verify|security|credential|deadline|pending|todo)\b/i;

function contextSegments(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return lines.length > 1 ? lines : [text];
}

function segmentPriority(segment: string, index: number, total: number): number {
  const recentness = total <= 1 ? 0 : index / (total - 1);
  const heading = /^(?:#{1,6}\s|[A-Z][A-Za-z ]{2,40}:$)/.test(segment) ? 0.7 : 0;
  const highSignal = HIGH_SIGNAL_CONTEXT.test(segment) ? 1.6 : 0;
  const firstContext = index === 0 ? 0.8 : 0;
  const lastContext = index === total - 1 ? 1.2 : 0;
  return highSignal + heading + firstContext + lastContext + recentness;
}

export function truncateToTokenBudget(text: string, maxTokens: number, marker = '\n[CONTEXT TRUNCATED]'): string {
  const budget = Math.max(16, Math.floor(maxTokens));
  if (estimateTokenCount(text) <= budget) return text;

  const segments = contextSegments(text);
  if (segments.length === 1) {
    const maxChars = Math.max(64, Math.floor((budget / Math.max(0.65, estimatorFor().scale)) * 3.1));
    const available = Math.max(32, maxChars - marker.length);
    const headChars = Math.max(16, Math.floor(available * 0.5));
    const tailChars = Math.max(16, available - headChars);
    return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}`;
  }

  const selected = new Set<number>();
  const ranked = segments
    .map((segment, index) => ({ index, score: segmentPriority(segment, index, segments.length) }))
    .sort((left, right) => right.score - left.score || right.index - left.index);
  for (const candidate of ranked) {
    selected.add(candidate.index);
    const rendered = [...selected]
      .sort((left, right) => left - right)
      .map((index) => segments[index])
      .join('\n\n');
    if (estimateTokenCount(`${rendered}${marker}`) > budget) selected.delete(candidate.index);
  }

  if (selected.size === 0) {
    const maxChars = Math.max(64, Math.floor((budget / Math.max(0.65, estimatorFor().scale)) * 3.1));
    const available = Math.max(32, maxChars - marker.length);
    const headChars = Math.max(16, Math.floor(available * 0.5));
    const tailChars = Math.max(16, available - headChars);
    return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}`;
  }

  const ordered = [...selected].sort((left, right) => left - right);
  const output: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (previous >= 0 && index > previous + 1) output.push(marker.trim());
    output.push(segments[index]);
    previous = index;
  }
  let rendered = output.join('\n\n');
  while (estimateTokenCount(rendered) > budget && ordered.length > 2) {
    const removable = ordered
      .slice(1, -1)
      .sort((left, right) => segmentPriority(segments[left], left, segments.length) - segmentPriority(segments[right], right, segments.length))[0];
    selected.delete(removable);
    ordered.splice(ordered.indexOf(removable), 1);
    rendered = ordered.map((index, position) => {
      const previousIndex = ordered[position - 1];
      return `${position > 0 && index > previousIndex + 1 ? `${marker.trim()}\n\n` : ''}${segments[index]}`;
    }).join('\n\n');
  }
  if (estimateTokenCount(rendered) <= budget) return rendered;

  const maxChars = Math.max(64, Math.floor((budget / Math.max(0.65, estimatorFor().scale)) * 3.1));
  const available = Math.max(32, maxChars - marker.length);
  const headChars = Math.max(16, Math.floor(available * 0.5));
  const tailChars = Math.max(16, available - headChars);
  return `${rendered.slice(0, headChars).trimEnd()}${marker}${rendered.slice(-tailChars).trimStart()}`;
}

export function buildDeltaRevisionContext(input: {
  request: string;
  previousCandidate: string;
  failedChecks: string[];
  relevantEvidence?: string[];
  requiredChanges: string[];
  maxTokens: number;
}): string {
  const sections = [
    `Original goal:\n${input.request}`,
    `Previous candidate:\n${input.previousCandidate}`,
    input.failedChecks.length ? `Failed checks:\n${input.failedChecks.map((item) => `- ${item}`).join('\n')}` : '',
    input.relevantEvidence?.length ? `Relevant evidence only:\n${input.relevantEvidence.map((item) => `- ${item}`).join('\n')}` : '',
    `Required correction:\n${input.requiredChanges.map((item) => `- ${item}`).join('\n') || '- Correct the failed checks without expanding scope.'}`,
  ].filter(Boolean);
  return truncateToTokenBudget(sections.join('\n\n'), input.maxTokens);
}

export function checkBudget(
  plan: TokenBudgetPlan,
  usage: TokenUsageByRole,
  role: RuntimeRole,
  proposedInputTokens = 0,
  proposedOutputTokens = 0,
): { allowed: boolean; reason?: string; remainingInput: number; remainingOutput: number; remainingCalls: number } {
  const budget = roleBudget(plan, role);
  const current = usage[role];
  const remainingInput = Math.max(0, budget.inputTokens - current.input);
  const remainingOutput = Math.max(0, budget.outputTokens - current.output);
  const remainingCalls = Math.max(0, budget.maxCalls - current.calls);
  if (remainingCalls <= 0) return { allowed: false, reason: `${role} call budget exhausted`, remainingInput, remainingOutput, remainingCalls };
  if (proposedInputTokens > remainingInput) return { allowed: false, reason: `${role} input token budget exceeded`, remainingInput, remainingOutput, remainingCalls };
  if (proposedOutputTokens > remainingOutput) return { allowed: false, reason: `${role} output token budget exceeded`, remainingInput, remainingOutput, remainingCalls };
  return { allowed: true, remainingInput, remainingOutput, remainingCalls };
}

export function recordBudgetUsage(
  usage: TokenUsageByRole,
  role: RuntimeRole,
  inputTokens: number,
  outputTokens: number,
): TokenUsageByRole {
  const next: TokenUsageByRole = {
    worker: { ...usage.worker },
    host: { ...usage.host },
    verifier: { ...usage.verifier },
    boss: { ...usage.boss },
  };
  next[role].input += Math.max(0, Math.round(inputTokens));
  next[role].output += Math.max(0, Math.round(outputTokens));
  next[role].calls += 1;
  incrementMetric('runtime_budget_tokens_consumed', { role, direction: 'input' }, inputTokens);
  incrementMetric('runtime_budget_tokens_consumed', { role, direction: 'output' }, outputTokens);
  return next;
}

export function emptyTokenUsage(): TokenUsageByRole {
  return {
    worker: { input: 0, output: 0, calls: 0 },
    host: { input: 0, output: 0, calls: 0 },
    verifier: { input: 0, output: 0, calls: 0 },
    boss: { input: 0, output: 0, calls: 0 },
  };
}
