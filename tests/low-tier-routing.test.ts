import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLowTierRouting } from '../app/lib/low-tier-routing';
import { RouteDecisionSchema } from '../app/lib/zenos-runtime';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

const codingDecision = RouteDecisionSchema.parse({
  policyVersion: 'low-tier-test',
  taskType: 'coding_change',
  pipelineMode: 'grounded_path',
  risk: 'medium',
  hostTier: 'standard',
  workerTier: 'cheap',
  verifierTier: 'none',
  useMemory: true,
  useTools: true,
  useWorker: false,
  useVerifier: false,
  useBoss: false,
  allowEscalation: true,
  requiresApproval: false,
  requiresSourceContext: true,
  maxMemoryItems: 8,
  maxWorkerCalls: 2,
  maxContextTokens: 128_000,
  maxRevisionAttempts: 1,
  reasons: ['test'],
});

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
});

test('low-tier routing stays shadow-only without sufficient task-class evidence', () => {
  const previous = process.env.ZENOS_LOW_TIER_FIRST_MODE;
  process.env.ZENOS_LOW_TIER_FIRST_MODE = 'shadow';
  try {
    const decision = decideLowTierRouting({
      decision: codingDecision,
      sessionId: 'shadow-session',
      workspaceAvailable: true,
      store: getRuntimeStore(),
    });
    assert.equal(decision.eligible, true);
    assert.equal(decision.activate, false);
    assert.equal(decision.shadowCandidate, false);
    assert.equal(decision.evidence.sampleSize, 0);
    assert.match(decision.reason, /collecting/i);
  } finally {
    if (previous === undefined) delete process.env.ZENOS_LOW_TIER_FIRST_MODE;
    else process.env.ZENOS_LOW_TIER_FIRST_MODE = previous;
  }
});

test('explicitly approved low-tier mode activates only bounded tool tasks', () => {
  const previousMode = process.env.ZENOS_LOW_TIER_FIRST_MODE;
  const previousTasks = process.env.ZENOS_LOW_TIER_FIRST_APPROVED_TASKS;
  process.env.ZENOS_LOW_TIER_FIRST_MODE = 'enabled';
  process.env.ZENOS_LOW_TIER_FIRST_APPROVED_TASKS = 'coding_change,debugging,repo_question';
  try {
    const approved = decideLowTierRouting({
      decision: codingDecision,
      sessionId: 'enabled-session',
      workspaceAvailable: true,
      store: getRuntimeStore(),
    });
    assert.equal(approved.activate, true);
    assert.match(approved.reason, /explicit enabled/i);

    const noWorkspace = decideLowTierRouting({
      decision: codingDecision,
      sessionId: 'no-workspace',
      workspaceAvailable: false,
      store: getRuntimeStore(),
    });
    assert.equal(noWorkspace.activate, false);
    assert.equal(noWorkspace.eligible, false);

    const critical = decideLowTierRouting({
      decision: RouteDecisionSchema.parse({ ...codingDecision, risk: 'critical' }),
      sessionId: 'critical-session',
      workspaceAvailable: true,
      store: getRuntimeStore(),
    });
    assert.equal(critical.activate, false);
    assert.equal(critical.eligible, false);
  } finally {
    if (previousMode === undefined) delete process.env.ZENOS_LOW_TIER_FIRST_MODE;
    else process.env.ZENOS_LOW_TIER_FIRST_MODE = previousMode;
    if (previousTasks === undefined) delete process.env.ZENOS_LOW_TIER_FIRST_APPROVED_TASKS;
    else process.env.ZENOS_LOW_TIER_FIRST_APPROVED_TASKS = previousTasks;
  }
});
