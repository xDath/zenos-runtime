import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as healthGet } from '../app/api/health/route';
import { POST as abortPost } from '../app/api/runtime/gateway/abort/route';
import {
  GET as continuationGet,
  POST as continuationPost,
} from '../app/api/runtime/gateway/continuation/route';
import { POST as routePost } from '../app/api/runtime/route/route';
import { GET as sessionGet, POST as sessionPost } from '../app/api/runtime/session/route';
import { POST as runPost } from '../app/api/runtime/run/route';
import { createCodingTask } from '../app/lib/codex-execution-core';
import { resetRateLimitsForTests } from '../app/lib/rate-limit';
import { choosePipeline } from '../app/lib/zenos-runtime';
import { createRuntimeSession } from '../app/lib/zenos-runtime-three-agent';
import { RuntimeRunRequestSchema } from '../app/lib/zenos-runtime-executor';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';
import { RuntimeSessionStateSchema } from '../app/lib/zenos-runtime-state';

const apiKey = 'runtime-route-contract-key';

function seedActiveContinuationParents(input: {
  sessionId: string;
  taskId: string;
  runId: string;
  timestamp: string;
}): void {
  const store = getRuntimeStore();
  store.saveSession(RuntimeSessionStateSchema.parse({
    sessionId: input.sessionId,
    userGoal: 'Continue the active root task.',
    status: 'working',
    hostModel: 'test-host',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }));
  store.saveCognitiveTask({
    taskId: input.taskId,
    rootRunId: input.runId,
    activeRunId: input.runId,
    sessionId: input.sessionId,
    status: 'active',
    phase: 'execute',
    capsule: { status: 'active', updatedAt: input.timestamp },
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

function request(
  pathname: string,
  options: { method?: string; body?: string | Record<string, unknown>; authenticated?: boolean; headers?: Record<string, string> } = {},
): Request {
  const body = typeof options.body === 'string'
    ? options.body
    : options.body === undefined
      ? undefined
      : JSON.stringify(options.body);
  return new Request(`http://runtime.test${pathname}`, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.authenticated ? { authorization: `Bearer ${apiKey}` } : {}),
      'x-forwarded-for': '203.0.113.20',
      ...(options.headers || {}),
    },
    body,
  });
}

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  resetRateLimitsForTests();
  Reflect.set(process.env, 'NODE_ENV', 'production');
  process.env.ZENOS_RUNTIME_API_KEY = apiKey;
  process.env.ETLA_MASTER_SECRET = 'runtime-route-contract-master-secret';
  process.env.ZENOS_ALLOW_LEGACY_HMAC = 'false';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY = 'true';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = 'true';
  process.env.ZENOS_ORCHESTRATION_MODE = 'host-led';
});

test('public health is live while routing fails closed and validates real HTTP contracts', async () => {
  const health = await healthGet();
  const healthBody = await health.json() as {
    ok: boolean;
    version: string;
    architecture: string;
    orchestrationMode: string;
  };
  assert.equal(health.status, 200);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.version, '0.7.0');
  assert.equal(healthBody.architecture, 'host-led-cognitive-runtime-v1');
  assert.equal(healthBody.orchestrationMode, 'host-led');
  assert.equal(health.headers.get('cache-control'), 'no-store');

  const missingAuth = await routePost(request('/api/runtime/route', {
    body: { request: 'explain this architecture', intent: 'explain' },
  }));
  assert.equal(missingAuth.status, 401);

  const malformed = await routePost(request('/api/runtime/route', {
    body: '{',
    authenticated: true,
  }));
  assert.equal(malformed.status, 400);

  const valid = await routePost(request('/api/runtime/route', {
    body: { request: 'deploy ke production sekarang', intent: 'execute' },
    authenticated: true,
  }));
  const validBody = await valid.json() as { ok: boolean; decision: { risk: string; useBoss: boolean; requiresApproval: boolean } };
  assert.equal(valid.status, 200);
  assert.equal(validBody.ok, true);
  assert.equal(validBody.decision.risk, 'critical');
  assert.equal(validBody.decision.useBoss, true);
  assert.equal(validBody.decision.requiresApproval, true);
  assert.equal(valid.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(valid.headers.get('x-request-id'));

  const coding = await routePost(request('/api/runtime/route', {
    body: {
      request: 'inspect this repository, patch the parser bug, and run targeted tests',
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      estimatedContextTokens: 12_000,
    },
    authenticated: true,
  }));
  const codingBody = await coding.json() as {
    decision: { useWorker: boolean; useVerifier: boolean; workerTier: string; pipelineMode: string; reasons: string[] };
  };
  assert.equal(coding.status, 200);
  assert.equal(codingBody.decision.useWorker, false);
  assert.equal(codingBody.decision.workerTier, 'none');
  assert.equal(codingBody.decision.useVerifier, false);
  assert.equal(codingBody.decision.pipelineMode, 'grounded_path');
  assert.match(codingBody.decision.reasons.join(' '), /Host is the sole orchestrator/i);

  const verified = await routePost(request('/api/runtime/route', {
    body: {
      request: 'verify this implementation independently before answering',
      hasFiles: true,
      intent: 'analyze',
      userRequestedVerification: true,
    },
    authenticated: true,
  }));
  const verifiedBody = await verified.json() as { decision: { useWorker: boolean; useVerifier: boolean; pipelineMode: string } };
  assert.equal(verified.status, 200);
  assert.equal(verifiedBody.decision.useWorker, false);
  assert.equal(verifiedBody.decision.useVerifier, true);
  assert.equal(verifiedBody.decision.pipelineMode, 'verified_path');
});

test('session route persists through the HTTP boundary', async () => {
  const created = await sessionPost(request('/api/runtime/session', {
    authenticated: true,
    body: {
      request: 'analyze repository architecture',
      intent: 'analyze',
      hasFiles: true,
      sessionId: 'route-contract-session',
    },
  }));
  const createdBody = await created.json() as { ok: boolean; session: { sessionId: string; status: string } };
  assert.equal(created.status, 201);
  assert.equal(createdBody.session.sessionId, 'route-contract-session');

  const listed = await sessionGet(request('/api/runtime/session?limit=10', { authenticated: true }));
  const listedBody = await listed.json() as { sessions: Array<{ sessionId: string }> };
  assert.equal(listed.status, 200);
  assert.equal(listedBody.sessions.some(item => item.sessionId === 'route-contract-session'), true);
});

test('continuation recovery endpoint reclaims only pre-start leased work', async () => {
  const store = getRuntimeStore();
  const createdAt = new Date(Date.now() - 5_000).toISOString();
  seedActiveContinuationParents({
    sessionId: 'session-route-recovery',
    taskId: 'cognitive-route-recovery',
    runId: 'run-route-recovery',
    timestamp: createdAt,
  });
  store.enqueueContinuation({
    continuationId: 'continuation-route-recovery',
    taskId: 'cognitive-route-recovery',
    runId: 'run-route-recovery',
    sessionId: 'session-route-recovery',
    status: 'queued',
    prompt: 'Continue the same root task.',
    reason: 'gateway restart recovery route test',
    attempt: 1,
    maxAttempts: 6,
    createdAt,
    updatedAt: createdAt,
  });
  const leased = store.claimContinuationForSession('session-route-recovery');
  assert.equal(leased?.status, 'leased');

  const cutoff = new Date(Date.parse(leased?.updatedAt || createdAt) + 1_000).toISOString();
  const response = await continuationGet(request(
    `/api/runtime/gateway/continuation?sessionId=session-route-recovery&recoverLeasedBefore=${encodeURIComponent(cutoff)}`,
    { authenticated: true },
  ));
  const body = await response.json() as {
    ok: boolean;
    continuation?: { continuationId: string; status: string; leaseToken: string };
  };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.continuation?.continuationId, 'continuation-route-recovery');
  assert.equal(body.continuation?.status, 'leased');
  assert.ok(body.continuation?.leaseToken);

  const rejectedAck = await continuationPost(request('/api/runtime/gateway/continuation', {
    authenticated: true,
    body: {
      continuationId: 'continuation-route-recovery',
      leaseToken: 'wrong-token-that-is-long-enough',
      action: 'complete',
    },
  }));
  assert.equal(rejectedAck.status, 409);

  const heartbeat = await continuationPost(request('/api/runtime/gateway/continuation', {
    authenticated: true,
    body: {
      continuationId: 'continuation-route-recovery',
      leaseToken: body.continuation?.leaseToken,
      action: 'heartbeat',
    },
  }));
  assert.equal(heartbeat.status, 200);

  const completed = await continuationPost(request('/api/runtime/gateway/continuation', {
    authenticated: true,
    body: {
      continuationId: 'continuation-route-recovery',
      leaseToken: body.continuation?.leaseToken,
      action: 'complete',
    },
  }));
  const completedBody = await completed.json() as { continuation?: { status: string } };
  assert.equal(completed.status, 200);
  assert.equal(completedBody.continuation?.status, 'completed');

  const invalid = await continuationGet(request(
    '/api/runtime/gateway/continuation?sessionId=session-route-recovery&recoverLeasedBefore=not-a-date',
    { authenticated: true },
  ));
  assert.equal(invalid.status, 400);
});

test('gateway abort terminalizes both the Runtime run and its active coding task', async () => {
  const store = getRuntimeStore();
  const sessionId = 'route-contract-abort-session';
  const runId = 'route-contract-abort-run';
  createRuntimeSession({
    request: 'repair the interrupted coding change',
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
  }, { sessionId });
  const task = createCodingTask({
    taskId: 'route-contract-abort-task',
    runId,
    sessionId,
    request: 'repair the interrupted coding change',
    workspaceRoot: '/tmp/route-contract-abort-workspace',
    workspaceRevision: 'revision-abort-test',
  }, store);
  const input = RuntimeRunRequestSchema.parse({
    request: 'repair the interrupted coding change',
    sessionId,
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
  });
  store.saveRun({
    runId,
    sessionId,
    requestHash: 'abort-contract-hash',
    status: 'running',
    decision: choosePipeline({
      request: 'repair the interrupted coding change',
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
    }),
    result: {
      kind: 'gateway_preflight_v2',
      input,
      turnId: 'route-contract-abort-turn',
      platform: 'test',
      host: { model: 'host-test', provider: 'test-router' },
      preflightLatency: [],
      holdFinalDelivery: true,
      codingTaskId: task.taskId,
      codingPhase: task.currentPhase,
    },
    errors: [],
    startedAt: new Date().toISOString(),
  });

  const response = await abortPost(request('/api/runtime/gateway/abort', {
    authenticated: true,
    body: {
      sessionId,
      runId,
      turnId: 'route-contract-abort-turn',
      reason: 'test interruption',
    },
  }));
  const body = await response.json() as {
    ok: boolean;
    run: { status: string };
    codingTask: { status: string; unresolvedRisks: string[] };
  };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.run.status, 'abandoned');
  assert.equal(body.codingTask.status, 'cancelled');
  assert.match(body.codingTask.unresolvedRisks.join(' '), /test interruption/i);
  assert.equal(store.getCodingTask(task.taskId)?.status, 'cancelled');
});

test('gateway abort closes an orphan coding task even when its run record is missing', async () => {
  const store = getRuntimeStore();
  const sessionId = 'route-contract-orphan-session';
  const runId = 'route-contract-missing-run';
  createRuntimeSession({
    request: 'recover an orphan coding task',
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
  }, { sessionId });
  const task = createCodingTask({
    taskId: 'route-contract-orphan-task',
    runId,
    sessionId,
    request: 'recover an orphan coding task',
    workspaceRoot: '/tmp/route-contract-orphan-workspace',
    workspaceRevision: 'revision-orphan-test',
  }, store);

  const response = await abortPost(request('/api/runtime/gateway/abort', {
    authenticated: true,
    body: {
      sessionId,
      runId,
      reason: 'orphan cleanup test',
    },
  }));
  const body = await response.json() as {
    ok: boolean;
    codingTask: { status: string; unresolvedRisks: string[] };
  };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.codingTask.status, 'cancelled');
  assert.match(body.codingTask.unresolvedRisks.join(' '), /orphan cleanup test/i);
  assert.equal(store.getCodingTask(task.taskId)?.status, 'cancelled');
});

test('run route executes a real dry-run pipeline and persistently replays idempotent HTTP requests', async () => {
  const payload = {
    request: 'summarize this large architecture document',
    intent: 'analyze',
    estimatedContextTokens: 8_000,
    dryRun: true,
    persistSession: false,
    persistRouteEvent: false,
    autoRecallMemory: false,
    modelOverrides: {
      baseUrl: 'http://router.test/v1',
      apiKey: 'model-key',
      hostModel: 'host-test',
      workerModel: 'worker-test',
      verifierModel: 'verifier-test',
      bossModel: 'boss-test',
    },
  };
  const headers = { 'idempotency-key': 'route-contract-run-0001' };
  const first = await runPost(request('/api/runtime/run', { authenticated: true, body: payload, headers }));
  const firstBody = await first.json() as { ok: boolean; result: { status: string; decision: { useWorker: boolean } } };
  assert.equal(first.status, 200);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.result.status, 'dry_run');
  assert.equal(firstBody.result.decision.useWorker, false);

  const replay = await runPost(request('/api/runtime/run', { authenticated: true, body: payload, headers }));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');

  const conflict = await runPost(request('/api/runtime/run', {
    authenticated: true,
    body: { ...payload, request: 'a different request' },
    headers,
  }));
  assert.equal(conflict.status, 409);
});
