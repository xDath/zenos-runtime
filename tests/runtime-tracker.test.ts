import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeTracker } from '../app/lib/runtime-tracker';
import { createRuntimeSession, updateRuntimeSession } from '../app/lib/zenos-runtime-three-agent';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
});

test('Runtime tracker collapses lifecycle events into real calls with tokens, latency, and session identity', () => {
  createRuntimeSession({ request: 'Analisis bug validasi input', intent: 'analyze' }, {
    sessionId: 'hermes_tracker_test',
    metadata: { platform: 'discord', createdBy: 'test' },
  });
  updateRuntimeSession('hermes_tracker_test', { status: 'working', activeRunId: 'gateway_tracker_1' });
  const store = getRuntimeStore();
  const startedAt = new Date(Date.now() - 1_200).toISOString();
  const completedAt = new Date().toISOString();
  store.insertEvent({
    sessionId: 'hermes_tracker_test',
    workerId: 'model-worker-call-1',
    type: 'progress',
    summary: 'worker model build started.',
    evidence: [],
    severity: 'low',
    confidence: 1,
    needsBoss: false,
    metadata: {
      lifecycle: 'model_call',
      role: 'worker',
      callId: 'gateway_tracker_1:worker:1',
      runId: 'gateway_tracker_1',
      status: 'calling',
      model: 'build',
      provider: 'etla-router',
      trigger: 'large_context',
      inputTokensEstimate: 900,
    },
    createdAt: startedAt,
  });
  store.insertEvent({
    sessionId: 'hermes_tracker_test',
    workerId: 'model-worker-call-1',
    type: 'done',
    summary: 'worker model build completed.',
    evidence: [],
    severity: 'low',
    confidence: 1,
    needsBoss: false,
    metadata: {
      lifecycle: 'model_call',
      role: 'worker',
      callId: 'gateway_tracker_1:worker:1',
      runId: 'gateway_tracker_1',
      status: 'completed',
      model: 'build',
      provider: 'etla-router',
      trigger: 'large_context',
      latencyMs: 1200,
      attempts: 1,
      modelUsage: {
        inputTokens: 880,
        outputTokens: 120,
        totalTokens: 1000,
        estimated: false,
      },
    },
    createdAt: completedAt,
  });

  const tracker = buildRuntimeTracker({ range: '24h' });

  assert.equal(tracker.stats.activeSessions, 1);
  assert.equal(tracker.stats.modelCalls, 1);
  assert.equal(tracker.stats.totalTokens, 1000);
  assert.equal(tracker.stats.byRole.worker.calls, 1);
  assert.equal(tracker.calls.length, 1);
  assert.equal(tracker.calls[0].status, 'completed');
  assert.equal(tracker.calls[0].latencyMs, 1200);
  assert.equal(tracker.calls[0].inputTokens, 880);
  assert.equal(tracker.calls[0].outputTokens, 120);
  assert.equal(tracker.sessions[0].platform, 'discord');
  assert.match(tracker.sessions[0].label, /^#[A-F0-9]{6} · Analisis bug validasi input$/);
  assert.equal(tracker.sessions[0].roles.worker.observed, true);
  assert.equal(tracker.sessions[0].roles.worker.model, 'build');
});

test('Runtime tracker keeps an unfinished lifecycle call live until completion evidence arrives', () => {
  createRuntimeSession({ request: 'Tanya Boss soal private RPC', userRequestedBoss: true }, {
    sessionId: 'hermes_tracker_live',
    metadata: { platform: 'slack' },
  });
  updateRuntimeSession('hermes_tracker_live', { status: 'boss_review', activeRunId: 'gateway_live_1' });
  getRuntimeStore().insertEvent({
    sessionId: 'hermes_tracker_live',
    workerId: 'model-boss-live',
    type: 'progress',
    summary: 'boss model codex started.',
    evidence: [],
    severity: 'low',
    confidence: 1,
    needsBoss: false,
    metadata: {
      lifecycle: 'model_call',
      role: 'boss',
      callId: 'gateway_live_1:boss',
      runId: 'gateway_live_1',
      status: 'calling',
      model: 'codex',
      provider: 'etla-router',
      trigger: 'user_requested_boss',
    },
    createdAt: new Date().toISOString(),
  });

  const tracker = buildRuntimeTracker({ range: 'today' });

  assert.equal(tracker.stats.activeCalls, 1);
  assert.equal(tracker.calls[0].status, 'calling');
  assert.equal(tracker.sessions[0].roles.boss.status, 'calling');
  assert.equal(tracker.sessions[0].roles.boss.trigger, 'user_requested_boss');
  assert.equal(tracker.stats.modelCalls, 0);
});
