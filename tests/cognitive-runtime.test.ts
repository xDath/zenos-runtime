import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { modelForSlot, providerForSlot } from '../app/lib/zenos-runtime-model-config';
import { resolveRuntimeModelSlots } from '../app/lib/zenos-runtime-executor';
import { postflightGatewayTurn, preflightGatewayTurn } from '../app/lib/gateway-orchestration';
import { getRuntimeSession } from '../app/lib/zenos-runtime-three-agent';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

function modelResponse(content: unknown): Response {
  return Response.json({
    choices: [{
      message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 180, completion_tokens: 80, total_tokens: 260 },
  });
}

function legacyOverrides() {
  return {
    baseUrl: 'http://router.test/v1',
    apiKey: 'test-model-key',
    hostModel: 'runtime-host',
    hostProvider: 'test-router',
    workerModel: 'legacy-worker',
    workerProvider: 'legacy-worker-provider',
    verifierModel: 'legacy-verifier',
    verifierProvider: 'legacy-verifier-provider',
    bossModel: 'legacy-boss',
    bossProvider: 'legacy-boss-provider',
  };
}

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  process.env.ZENOS_ORCHESTRATION_MODE = 'host-led';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY = 'true';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = 'true';
});

test('host-led coding preflight uses no Runtime planner or Worker and compiles a native delegation task graph', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenos-cognitive-host-led-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cognitive-host-led', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('Host-led preflight must not call an auxiliary Runtime model');
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'perbaiki source ini sampai targeted test lulus',
      sessionId: 'cognitive-host-led-session',
      turnId: 'cognitive-host-led-turn',
      platform: 'telegram',
      host: { model: 'runtime-host', provider: 'test-router' },
      workspaceRoot: root,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      modelOverrides: legacyOverrides(),
    });

    assert.equal(calls, 0);
    assert.equal(preflight.decision.taskType, 'coding_change');
    assert.equal(preflight.decision.pipelineMode, 'grounded_path');
    assert.equal(preflight.decision.useWorker, false);
    assert.equal(preflight.decision.useVerifier, false);
    assert.equal(preflight.decision.useBoss, false);
    assert.equal(preflight.receipt.host.plannerInvoked, false);
    assert.equal(preflight.receipt.worker.invoked, false);
    assert.equal(preflight.holdFinalDelivery, false);
    assert.ok(preflight.cognitiveTaskId);
    assert.match(preflight.hostContext, /ZENOS COGNITIVE EXECUTION PACKET/);
    assert.match(preflight.hostContext, /ZENOS ACTIVE TASK CAPSULE/);
    assert.match(preflight.hostContext, /repo-inspector/);
    assert.match(preflight.hostContext, /coding-worker/);
    assert.match(preflight.hostContext, /validation-worker/);
    assert.match(preflight.hostContext, /Worker model policy: inherit the current Host model/i);
    assert.match(preflight.hostContext, /Task graph/i);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy role overrides collapse to one authoritative Host identity', () => {
  const slots = resolveRuntimeModelSlots('single-model-contract', legacyOverrides());
  for (const role of ['host', 'worker', 'verifier', 'boss'] as const) {
    assert.equal(modelForSlot(slots, role), 'runtime-host');
    assert.equal(providerForSlot(slots, role), 'test-router');
  }
  assert.equal(slots.workerModel, undefined);
  assert.equal(slots.verifierModel, undefined);
  assert.equal(slots.bossModel, undefined);
});

test('explicit verification uses the same Host model and remains off otherwise', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    return modelResponse({
      verdict: 'pass',
      confidence: 0.96,
      issues: [],
      checks: {
        followsUserRequest: 'pass',
        sourceGrounded: 'pass',
        secretSafe: 'pass',
        actionSafe: 'pass',
        testsOrValidation: 'pass',
      },
      nextAction: 'answer',
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'cek hasil analisis ini dan verifikasi secara independen',
      sessionId: 'cognitive-explicit-verifier',
      turnId: 'cognitive-explicit-verifier-turn',
      platform: 'telegram',
      host: { model: 'runtime-host', provider: 'test-router' },
      intent: 'analyze',
      userRequestedVerification: true,
      modelOverrides: legacyOverrides(),
    });
    assert.equal(preflight.decision.useVerifier, true);
    assert.equal(preflight.receipt.verifier.invoked, false);
    assert.equal(preflight.holdFinalDelivery, true);
    assert.deepEqual(calledModels, []);

    const postflight = await postflightGatewayTurn({
      sessionId: 'cognitive-explicit-verifier',
      runId: preflight.runId,
      turnId: 'cognitive-explicit-verifier-turn',
      draft: 'Analisis telah diperiksa dan didukung bukti.',
      host: { model: 'runtime-host', provider: 'test-router' },
      hostUsage: { inputTokens: 300, outputTokens: 60, calls: 1 },
    });

    assert.equal(postflight.receipt.verifier.invoked, true);
    assert.equal(postflight.receipt.verifier.model, 'runtime-host');
    assert.equal(postflight.receipt.verifier.verdict, 'pass');
    assert.deepEqual(calledModels, ['runtime-host']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unfinished work creates a leased durable continuation and keeps one root cognitive task', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenos-cognitive-continuation-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cognitive-continuation' }));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  globalThis.fetch = async () => {
    throw new Error('No independent model call is expected');
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'selesaikan patch ini sampai validasi lulus',
      sessionId: 'cognitive-continuation-session',
      turnId: 'cognitive-continuation-turn-1',
      platform: 'telegram',
      host: { model: 'runtime-host', provider: 'test-router' },
      workspaceRoot: root,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      modelOverrides: legacyOverrides(),
    });

    const postflight = await postflightGatewayTurn({
      sessionId: 'cognitive-continuation-session',
      runId: preflight.runId,
      turnId: 'cognitive-continuation-turn-1',
      draft: 'Patch belum selesai. Gas lanjut?',
      host: { model: 'runtime-host', provider: 'test-router' },
      toolSummary: 'read_file: inspected src/main.ts; ordinary implementation remains pending',
      hostUsage: { inputTokens: 400, outputTokens: 70, calls: 2 },
    });

    assert.equal(postflight.ok, true);
    assert.equal(postflight.continuation?.required, true);
    assert.equal(postflight.continuation?.reason, 'host_interrupted');
    assert.equal(postflight.continuation?.taskId, preflight.cognitiveTaskId);
    assert.ok(postflight.continuation?.continuationId);
    assert.match(postflight.continuation?.prompt || '', /ZENOS ACTIVE TASK CAPSULE/);
    assert.match(postflight.continuation?.prompt || '', /not a new user request/i);
    assert.equal(getRuntimeSession('cognitive-continuation-session')?.status, 'working');

    const record = getRuntimeStore().completeContinuation(postflight.continuation?.continuationId || '');
    assert.equal(record?.status, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a genuine user-owned blocker pauses the task instead of silently skipping the field', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No auxiliary model call is expected');
  };
  try {
    const preflight = await preflightGatewayTurn({
      request: 'kirim laporan final lewat email',
      sessionId: 'cognitive-user-blocker',
      turnId: 'cognitive-user-blocker-turn',
      platform: 'telegram',
      host: { model: 'runtime-host', provider: 'test-router' },
      intent: 'execute',
      modelOverrides: legacyOverrides(),
    });
    const postflight = await postflightGatewayTurn({
      sessionId: 'cognitive-user-blocker',
      runId: preflight.runId,
      turnId: 'cognitive-user-blocker-turn',
      draft: 'Need an email address from the user before sending the report.',
      host: { model: 'runtime-host', provider: 'test-router' },
      hostUsage: { inputTokens: 180, outputTokens: 35, calls: 1 },
    });
    assert.equal(postflight.continuation, undefined);
    assert.equal(postflight.cognitivePhase, 'waiting_for_user');
    assert.equal(getRuntimeSession('cognitive-user-blocker')?.status, 'paused');
    assert.equal(getRuntimeSession('cognitive-user-blocker')?.metadata.waitingForUser, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
