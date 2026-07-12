import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateExecutionBoundary,
  executionBoundaryStatus,
} from '../app/lib/execution-boundary';
import {
  createLatencyBudgetPlan,
  observeLatency,
} from '../app/lib/latency-budget';
import {
  appendOutcomeFeedback,
  buildOutcomeAnalytics,
  recordOutcomePassport,
} from '../app/lib/outcome-ledger';
import { choosePipeline } from '../app/lib/zenos-runtime';
import { RuntimeModelResult } from '../app/lib/zenos-runtime-executor';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

const ENV_KEYS = [
  'NODE_ENV',
  'ZENOS_RUNTIME_EXECUTION_MODE',
  'ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED',
  'ZENOS_RUNTIME_MUTATION_ROOTS',
  'ZENOS_RUNTIME_VALIDATION_ROOTS',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  restoreEnv();
});

test.after(() => restoreEnv());

test('production control plane blocks local mutation but permits approved isolated remote validation', () => {
  Reflect.set(process.env, 'NODE_ENV', 'production');
  process.env.ZENOS_RUNTIME_EXECUTION_MODE = 'control-plane';
  process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED = 'true';
  process.env.ZENOS_RUNTIME_VALIDATION_ROOTS = path.join(os.tmpdir(), 'zenos-validation');
  process.env.ZENOS_RUNTIME_MUTATION_ROOTS = path.join(os.tmpdir(), 'zenos-mutation');

  const local = evaluateExecutionBoundary({
    action: 'local_mutation',
    workspaceRoot: path.join(os.tmpdir(), 'zenos-mutation', 'repo'),
    approvalGranted: true,
  });
  const remote = evaluateExecutionBoundary({
    action: 'remote_validation',
    workspaceRoot: path.join(os.tmpdir(), 'zenos-validation', 'repo'),
    approvalGranted: true,
  });
  const outside = evaluateExecutionBoundary({
    action: 'remote_validation',
    workspaceRoot: path.join(os.tmpdir(), 'outside', 'repo'),
    approvalGranted: true,
  });

  assert.equal(executionBoundaryStatus().mode, 'control-plane');
  assert.equal(local.allowed, false);
  assert.match(local.reason, /control plane/i);
  assert.equal(remote.allowed, true);
  assert.equal(outside.allowed, false);
});

test('latency budget is task-aware and reports soft and hard breaches', () => {
  const decision = choosePipeline({
    request: 'fix TypeScript bug and run targeted tests',
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
  });
  const plan = createLatencyBudgetPlan(decision);
  const within = observeLatency('worker', Math.floor(plan.workerMs * 0.8), plan.workerMs);
  const soft = observeLatency('verifier', Math.floor(plan.verifierMs * 1.2), plan.verifierMs);
  const hard = observeLatency('host', Math.floor(plan.hostMs * 1.7), plan.hostMs);

  assert.equal(plan.taskType, 'debugging');
  assert.ok(plan.totalMs >= 100_000);
  assert.equal(within.status, 'within_budget');
  assert.equal(soft.status, 'soft_breach');
  assert.equal(hard.status, 'hard_breach');
});

test('four-role latency budgets follow the actual pipeline instead of a simple-chat label', () => {
  const decision = choosePipeline({
    request: 'Analyze this synthetic, non-mutating production-readiness evidence and return a concise verdict.',
    intent: 'analyze',
    estimatedContextTokens: 8_000,
    userRequestedVerification: true,
    userRequestedBoss: true,
  });
  const plan = createLatencyBudgetPlan(decision);

  assert.equal(decision.taskType, 'simple_chat');
  assert.equal(decision.pipelineMode, 'escalated_deep_path');
  assert.ok(plan.totalMs >= 100_000);
  assert.ok(plan.hostMs >= 25_000);
  assert.ok(plan.workerMs >= 25_000);
  assert.ok(plan.verifierMs >= 20_000);
  assert.ok(plan.bossMs >= 20_000);
});

test('Outcome Passport is immutable, revisioned, and keeps shadow routing observation-only', () => {
  const decision = choosePipeline({
    request: 'jelaskan repo ini berdasarkan file yang ada',
    hasFiles: true,
    intent: 'analyze',
  });
  const call: RuntimeModelResult = {
    ok: true,
    role: 'worker',
    model: 'build',
    provider: 'test',
    content: 'bounded evidence',
    usage: {
      inputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 80,
      reasoningTokens: 0,
      totalTokens: 280,
      estimated: false,
    },
    inputTokensEstimate: 200,
    outputTokensEstimate: 80,
    latencyMs: 1_200,
    attempts: 1,
    requestId: 'call-1',
  };

  const passport = recordOutcomePassport({
    runId: 'run-outcome-1',
    sessionId: 'session-outcome-1',
    request: 'jelaskan repo ini berdasarkan file yang ada',
    decision,
    verdict: 'success',
    transformed: false,
    calls: [call],
    hostUsage: {
      inputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 90,
      reasoningTokens: 20,
      calls: 2,
    },
    latencyObservations: [observeLatency('total', 5_000, 20_000)],
  });
  const feedback = appendOutcomeFeedback({
    runId: 'run-outcome-1',
    score: 0.95,
    accepted: true,
    note: 'Accurate and focused.',
  });
  const records = getRuntimeStore().listOutcomes(10, { runId: 'run-outcome-1' });

  assert.equal(passport.shadowRoute.eligibleForAutomaticUse, false);
  assert.equal(feedback.userFeedback?.accepted, true);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((item) => item.revision).sort(), [1, 2]);
  assert.notEqual(records[0].outcomeId, records[1].outcomeId);
  const analytics = buildOutcomeAnalytics(records);
  assert.equal(getRuntimeStore().health().schemaVersion, 4);
  assert.equal(analytics.mode, 'shadow-only');
  assert.equal(analytics.automaticPromotionAllowed, false);
  assert.equal(analytics.routes[0]?.sampleSize, 1);
  assert.equal(analytics.routes[0]?.evidenceReady, false);
});
