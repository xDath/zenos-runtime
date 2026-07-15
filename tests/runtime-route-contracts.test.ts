import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as healthGet } from '../app/api/health/route';
import { POST as abortPost } from '../app/api/runtime/gateway/abort/route';
import { POST as routePost } from '../app/api/runtime/route/route';
import { GET as sessionGet, POST as sessionPost } from '../app/api/runtime/session/route';
import { POST as runPost } from '../app/api/runtime/run/route';
import { createCodingTask } from '../app/lib/codex-execution-core';
import { resetRateLimitsForTests } from '../app/lib/rate-limit';
import { choosePipeline } from '../app/lib/zenos-runtime';
import { createRuntimeSession } from '../app/lib/zenos-runtime-three-agent';
import { RuntimeRunRequestSchema } from '../app/lib/zenos-runtime-executor';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

const apiKey = 'runtime-route-contract-key';

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
});

test('public health is live while routing fails closed and validates real HTTP contracts', async () => {
  const health = await healthGet();
  const healthBody = await health.json() as { ok: boolean; version: string };
  assert.equal(health.status, 200);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.version, '0.7.0');
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
  assert.equal(firstBody.result.decision.useWorker, true);

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
