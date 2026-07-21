import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContinuityPacketV2,
  computeContinuityPacketHash,
  continuityPacketToCompactMessages,
  parseContinuityPacketV2,
} from '../app/lib/continuity-packet';
import {
  continuitySignalHash,
  decideContinuityCheckpoint,
  evaluateContinuityPressure,
  recordContinuityCheckpoint,
} from '../app/lib/continuity-coordinator';
import {
  ensureCommandJob,
  synchronizeCommandJobPostflight,
  synchronizeCommandJobPreflight,
  transitionCommandStep,
} from '../app/lib/command-job';
import { prepareCognitiveTask } from '../app/lib/cognitive-task';
import { CognitivePacketSchema } from '../app/lib/cognitive-kernel';
import { RouteDecisionSchema } from '../app/lib/zenos-runtime';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

function packet(overrides: Partial<Omit<ContinuityPacketV2, 'contentHash'>> = {}): ContinuityPacketV2 {
  const base: Omit<ContinuityPacketV2, 'contentHash'> = {
    version: 'continuity-v2',
    sessionId: 'continuity-session',
    turnId: 'turn-1',
    sourceCursor: 'msg:320:abcdef0123456789abcdef01',
    estimatedTokens: 190_000,
    head: [{
      role: 'user',
      content: 'Goal: preserve the original acceptance criteria through compaction.',
      message_id: 'm0',
    }],
    milestones: [{
      kind: 'decision',
      text: 'Decision: Runtime is the only checkpoint authority.',
      sourceMessageIds: ['m170'],
      sourceHash: 'a'.repeat(64),
      occurredAt: '2026-07-21T00:00:00.000Z',
    }],
    recentTail: [{
      role: 'user',
      content: 'Continue from the verified checkpoint.',
      message_id: 'm319',
    }],
    activeToolState: [{
      id: 'tool-1',
      tool: 'test',
      status: 'passed',
      summary: 'npm test passed with 111 tests.',
      changedFiles: ['app/lib/gateway-continuity.ts'],
      artifactIds: ['test-report-1'],
      sourceMessageIds: ['m250'],
      sourceHash: 'b'.repeat(64),
      occurredAt: '2026-07-21T00:01:00.000Z',
    }],
    openWork: [{
      id: 'work-1',
      kind: 'validate',
      text: 'Run cross-language packet hash validation.',
      status: 'queued',
      acceptanceCriteria: ['Python and TypeScript compute the same content hash.'],
      blockers: [],
      sourceMessageIds: ['m300'],
      sourceHash: 'c'.repeat(64),
    }],
    ...overrides,
  };
  return { ...base, contentHash: computeContinuityPacketHash(base) };
}

const codingDecision = RouteDecisionSchema.parse({
  policyVersion: 'test',
  taskType: 'coding_change',
  pipelineMode: 'verified_path',
  risk: 'medium',
  hostTier: 'standard',
  workerTier: 'cheap',
  verifierTier: 'cheap',
  useMemory: true,
  useTools: true,
  useWorker: true,
  useVerifier: true,
  useBoss: false,
  allowEscalation: true,
  requiresApproval: false,
  requiresSourceContext: true,
  maxMemoryItems: 8,
  maxWorkerCalls: 2,
  maxContextTokens: 192_000,
  maxRevisionAttempts: 2,
  reasons: ['test'],
});

const cognitivePacket = CognitivePacketSchema.parse({
  version: 'zenos-cognitive-packet-v1',
  rootObjective: 'Implement durable CommandJob continuity.',
  taskType: 'coding_change',
  phase: 'execute',
  acceptanceCriteria: ['Requested behavior is implemented.', 'Relevant deterministic validation passes.'],
  constraints: ['Do not duplicate mutations.'],
  fields: [{ name: 'root_objective', status: 'known', value: 'Implement durable CommandJob continuity.' }],
  capabilities: [{
    profile: 'coding-worker',
    goal: 'Implement the bounded change.',
    parallelSafe: false,
    mutating: true,
    evidenceRequired: ['diff', 'test'],
  }],
  maxParallelWorkers: 1,
  workerModelPolicy: 'inherit-host',
  verifierPolicy: 'explicit-only',
  bossPolicy: 'off',
  memorySource: 'handoff',
  repositoryContextAvailable: true,
  nextAction: {
    owner: 'worker',
    profile: 'coding-worker',
    instruction: 'Apply the approved patch.',
    stopCondition: 'Targeted deterministic validation passes.',
  },
  continuation: {
    enabled: true,
    maxCycles: 6,
    compactAtTokens: 160_000,
    preserveRecentMessages: 12,
    askUserOnlyForBlockingFields: true,
    terminalConditions: ['acceptance criteria pass'],
  },
});

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
});

test('ContinuityPacket v2 preserves section budgets and rejects tampering', () => {
  const original = packet();
  assert.deepEqual(parseContinuityPacketV2(original), original);
  const messages = continuityPacketToCompactMessages(original, 40_000);
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /original acceptance criteria/i);
  assert.match(serialized, /only checkpoint authority/i);
  assert.match(serialized, /npm test passed/i);
  assert.match(serialized, /cross-language packet hash validation/i);
  assert.match(serialized, /Continue from the verified checkpoint/i);
  assert.throws(() => parseContinuityPacketV2({ ...original, sourceCursor: 'tampered' }));
});

test('ContinuityCoordinator checkpoints once, reuses non-material cursors, and checkpoints new evidence', () => {
  const store = getRuntimeStore();
  const first = packet();
  const pressure = evaluateContinuityPressure(first.estimatedTokens, 160_000);
  assert.equal(pressure.level, 'compression');
  assert.equal(pressure.shouldCheckpoint, true);

  const initial = decideContinuityCheckpoint({
    sessionId: first.sessionId,
    packet: first,
    estimatedTokens: first.estimatedTokens,
    checkpointSoftLimitTokens: 160_000,
    store,
  });
  assert.equal(initial.action, 'checkpoint');
  recordContinuityCheckpoint({
    sessionId: first.sessionId,
    packet: first,
    checkpointId: 'checkpoint-1',
    pressure: initial.pressure,
    strategy: 'deterministic-dag-v3',
    coverage: { complete: true },
    context: 'verified compact context',
    signalHash: initial.signalHash,
    store,
  });

  const identical = decideContinuityCheckpoint({
    sessionId: first.sessionId,
    packet: first,
    estimatedTokens: first.estimatedTokens,
    checkpointSoftLimitTokens: 160_000,
    store,
  });
  assert.equal(identical.action, 'reuse');
  assert.equal(identical.latest?.checkpointId, 'checkpoint-1');

  const cursorOnly = packet({
    sourceCursor: 'msg:321:abcdef0123456789abcdef02',
    estimatedTokens: first.estimatedTokens + 400,
  });
  assert.equal(continuitySignalHash(cursorOnly), continuitySignalHash(first));
  const routine = decideContinuityCheckpoint({
    sessionId: first.sessionId,
    packet: cursorOnly,
    estimatedTokens: cursorOnly.estimatedTokens,
    checkpointSoftLimitTokens: 160_000,
    store,
  });
  assert.equal(routine.action, 'reuse');

  const changed = packet({
    sourceCursor: 'msg:322:abcdef0123456789abcdef03',
    milestones: [...first.milestones, {
      kind: 'validation',
      text: 'Validation: the three-compact replay passed.',
      sourceMessageIds: ['m321'],
      sourceHash: 'd'.repeat(64),
      occurredAt: '2026-07-21T00:02:00.000Z',
    }],
  });
  const material = decideContinuityCheckpoint({
    sessionId: first.sessionId,
    packet: changed,
    estimatedTokens: changed.estimatedTokens,
    checkpointSoftLimitTokens: 160_000,
    store,
  });
  assert.equal(material.action, 'checkpoint');
});

test('CommandJob is idempotent, predecessor-ordered, resumable, and evidence-gated', () => {
  const store = getRuntimeStore();
  const capsule = prepareCognitiveTask({
    sessionId: 'command-session',
    runId: 'run-root',
    packet: cognitivePacket,
    workspaceRevision: 'revision-1',
    store,
  });
  const first = ensureCommandJob({
    sessionId: 'command-session',
    userTurnId: 'turn-root',
    requestHash: 'f'.repeat(64),
    capsule,
    decision: codingDecision,
    workspaceRoot: '/srv/etla/workspaces/zenos-runtime',
    budget: { maxCycles: 6, maxModelCalls: 8, maxTokens: 120_000 },
    checkpointId: 'checkpoint-1',
    store,
  });
  const replay = ensureCommandJob({
    sessionId: 'command-session',
    userTurnId: 'turn-retry',
    requestHash: 'e'.repeat(64),
    capsule,
    decision: codingDecision,
    workspaceRoot: '/srv/etla/workspaces/zenos-runtime',
    budget: { maxCycles: 6, maxModelCalls: 8, maxTokens: 120_000 },
    checkpointId: 'checkpoint-1',
    store,
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.job.jobId, first.job.jobId);
  assert.throws(() => transitionCommandStep({
    jobId: first.job.jobId,
    kind: 'patch',
    status: 'running',
    store,
  }), /predecessors/i);

  synchronizeCommandJobPreflight({
    jobId: first.job.jobId,
    routeRef: 'runtime-run:run-root',
    repositoryContext: 'app/lib/command-job.ts inspected',
    planRef: 'host-plan:run-root',
    mutationExpected: true,
    approvalRequired: false,
    store,
  });
  const paused = synchronizeCommandJobPostflight({
    jobId: first.job.jobId,
    mutationObserved: true,
    deterministicValidation: 'failed',
    continuationReason: 'coding_validation_pending',
    checkpointId: 'checkpoint-2',
    resultRef: 'workspace:diff-1',
    store,
  });
  assert.equal(paused.status, 'retry_pending');
  assert.equal(paused.checkpointId, 'checkpoint-2');
  assert.equal(store.listCommandSteps(first.job.jobId).find((step) => step.kind === 'patch')?.status, 'done');
  assert.equal(store.listCommandSteps(first.job.jobId).find((step) => step.kind === 'validate')?.status, 'retry_pending');

  transitionCommandStep({
    jobId: first.job.jobId,
    kind: 'validate',
    status: 'done',
    resultRef: 'test:passed',
    metadata: { deterministicValidation: 'passed' },
    store,
  });
  transitionCommandStep({
    jobId: first.job.jobId,
    kind: 'verify',
    status: 'done',
    resultRef: 'verifier:pass',
    store,
  });
  const completed = synchronizeCommandJobPostflight({
    jobId: first.job.jobId,
    mutationObserved: true,
    deterministicValidation: 'passed',
    verifierVerdict: 'pass',
    resultRef: 'runtime-run:run-final',
    store,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.activeStepId, undefined);
  assert.ok(store.listCommandSteps(first.job.jobId).every((step) => step.status === 'done'));
});
