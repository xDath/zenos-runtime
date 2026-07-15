import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  choosePipeline,
  runRuntimeEval,
  RuntimeContextSchema,
} from '../app/lib/zenos-runtime';
import {
  createRuntimeSession,
  dispatchWorker,
  getRuntimeSession,
  recordWorkerEvent,
  runQualityGate,
} from '../app/lib/zenos-runtime-three-agent';
import { authorizeRequest, issueScopedToken } from '../app/lib/auth';
import { createCodingTask } from '../app/lib/codex-execution-core';
import { getRuntimeStore, resetRuntimeStoreForTests, RuntimeStore } from '../app/lib/zenos-runtime-store';
import {
  RuntimeRunRequestSchema,
  runVerifier,
  runZenosPipeline,
} from '../app/lib/zenos-runtime-executor';
import { OutcomePassportSchema } from '../app/lib/outcome-ledger';

function signedRequest(options: {
  body: string;
  path: string;
  scope: string;
  nonce: string;
  clientId?: string;
}): Request {
  const timestamp = Date.now();
  const clientId = options.clientId || 'runtime-test-client';
  const bodyHash = crypto.createHash('sha256').update(options.body).digest('hex');
  const payload = [
    'v2',
    String(timestamp),
    options.nonce,
    'POST',
    options.path,
    bodyHash,
    options.scope,
    clientId,
  ].join('\n');
  const signature = crypto.createHmac('sha256', process.env.ETLA_MASTER_SECRET || '').update(payload).digest('hex');
  return new Request(`http://localhost${options.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-etla-timestamp': String(timestamp),
      'x-etla-nonce': options.nonce,
      'x-etla-body-sha256': bodyHash,
      'x-etla-signature': signature,
      'x-etla-scope': options.scope,
      'x-etla-client': clientId,
    },
    body: options.body,
  });
}

function modelResponse(content: unknown, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }): Response {
  return Response.json({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage,
  });
}

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  process.env.ETLA_MASTER_SECRET = 'test-etla-secret-which-is-long-enough';
  process.env.ZENOS_RUNTIME_API_KEY = 'test-runtime-key';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY = 'true';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = 'true';
  process.env.ZENOS_ALLOW_LEGACY_HMAC = 'false';
});

test('mandatory verifier failures escalate deterministically instead of silently releasing a draft', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => modelResponse('not valid verifier json');
  try {
    const input = RuntimeRunRequestSchema.parse({
      request: 'verify this high-risk answer',
      sessionId: 'mandatory-verifier-fallback',
      userRequestedVerification: true,
      modelOverrides: {
        baseUrl: 'http://models.test/v1',
        apiKey: 'test-key',
        verifierModel: 'runtime-verifier',
        verifierProvider: 'etla-router',
      },
    });
    const verifier = await runVerifier(input, 'candidate answer', undefined, { mandatory: true });
    assert.equal(verifier.call.ok, false);
    assert.equal(verifier.result?.verdict, 'escalate');
    assert.equal(verifier.result?.nextAction, 'escalate');
    assert.match(verifier.result?.issues[0]?.requiredFix || '', /fail closed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('routing policy passes its full regression suite and avoids deploy false positives', () => {
  const report = runRuntimeEval();
  assert.equal(report.status, 'pass', JSON.stringify(report.results.filter((item) => !item.passed), null, 2));
  assert.ok(report.total >= 20);

  const explanation = choosePipeline(RuntimeContextSchema.parse({
    request: 'jelaskan arsitektur deployment production',
    intent: 'explain',
  }));
  assert.equal(explanation.taskType, 'planning_or_architecture');
  assert.notEqual(explanation.risk, 'critical');
  assert.equal(explanation.requiresApproval, false);

  const action = choosePipeline(RuntimeContextSchema.parse({
    request: 'deploy ke production sekarang',
    intent: 'execute',
  }));
  assert.equal(action.risk, 'critical');
  assert.equal(action.useBoss, true);
  assert.equal(action.requiresApproval, true);
});

test('SQLite store persists session, workers, events, and quality-gate state transactionally', () => {
  const session = createRuntimeSession({
    request: 'fix bug besar di repo',
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
  });
  const queued = dispatchWorker(session.sessionId, 'coding_brief', 'Inspect affected files with evidence.');
  assert.equal(queued.workers.length, 1);
  assert.equal(queued.workers[0].status, 'queued');

  const updated = recordWorkerEvent({
    sessionId: session.sessionId,
    workerId: queued.workers[0].workerId,
    type: 'risk',
    summary: 'Destructive reset command was found.',
    evidence: ['scripts/deploy.sh:31'],
    severity: 'high',
    confidence: 0.96,
    needsBoss: true,
  });
  assert.equal(updated.status, 'paused');
  assert.equal(updated.workers[0].status, 'paused');
  assert.equal(updated.events.length, 2);

  const reloaded = getRuntimeSession(session.sessionId);
  assert.ok(reloaded);
  assert.equal(reloaded?.events.at(-1)?.summary, 'Destructive reset command was found.');

  const gate = runQualityGate({
    findings: [
      { claim: 'Supported', evidence: ['file.ts:1'], confidence: 0.9, risk: 'low' },
      { claim: 'Unsupported risky', evidence: [], confidence: 0.4, risk: 'high' },
    ],
    events: reloaded?.events || [],
  });
  assert.equal(gate.needsBoss, true);
  assert.equal(gate.verdict, 'escalate');
});

test('Runtime store marks runs abandoned by a process restart as abandoned', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zenos-runtime-recovery-'));
  const databasePath = path.join(directory, 'runtime.db');
  try {
    const firstProcess = new RuntimeStore(databasePath);
    firstProcess.saveRun({
      runId: 'run_abandoned_test',
      requestHash: 'request-hash',
      status: 'running',
      errors: [],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    createCodingTask({
      taskId: 'task_abandoned_test',
      runId: 'run_abandoned_test',
      request: 'recover the interrupted coding task',
      workspaceRoot: directory,
      workspaceRevision: 'revision-before-restart',
    }, firstProcess);
    firstProcess.close();

    const restartedProcess = new RuntimeStore(databasePath);
    const recovered = restartedProcess.getRun('run_abandoned_test');
    assert.equal(recovered?.status, 'abandoned');
    assert.ok(recovered?.completedAt);
    assert.match(recovered?.errors.join(' ') || '', /process exited/i);
    const recoveredTask = restartedProcess.getCodingTask('task_abandoned_test');
    assert.equal(recoveredTask?.status, 'cancelled');
    assert.match(JSON.stringify(recoveredTask?.state), /missing or terminated unsuccessfully/i);
    restartedProcess.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Runtime store quarantines legacy overspent token governors while preserving raw evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zenos-runtime-governor-migration-'));
  const databasePath = path.join(directory, 'runtime.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE runtime_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO runtime_meta(key, value) VALUES('schema_version', '7');
    CREATE TABLE token_governors (
      budget_id TEXT PRIMARY KEY,
      limit_tokens INTEGER NOT NULL,
      reserve_tokens INTEGER NOT NULL,
      spent_tokens INTEGER NOT NULL,
      calls INTEGER NOT NULL,
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      invalid_samples INTEGER NOT NULL DEFAULT 0,
      reservations_json TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO token_governors VALUES(
      'legacy-overspent', 2500, 0, 2212480, 4, 0, 0, '{}', 'completed',
      '2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z', '2026-07-15T00:01:00.000Z'
    );
  `);
  legacy.close();

  try {
    const store = new RuntimeStore(databasePath);
    store.close();
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    const row = verified.prepare('SELECT * FROM token_governors WHERE budget_id = ?').get('legacy-overspent');
    const version = verified.prepare("SELECT value FROM runtime_meta WHERE key = 'schema_version'").get();
    assert.equal(Number(row?.spent_tokens), 2500);
    assert.equal(Number(row?.reported_spent_tokens), 2212480);
    assert.equal(Number(row?.anomaly_count), 1);
    assert.equal(Number(row?.invalid_samples), 1);
    assert.equal(String(row?.status), 'expired');
    assert.equal(String(version?.value), '8');
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Runtime store abandons expired leases without waiting for a process restart', () => {
  const store = new RuntimeStore(':memory:');
  const expired = new Date(Date.now() - 60_000).toISOString();
  store.saveRun({
    runId: 'run_expired_lease',
    requestHash: 'request-hash-expired',
    status: 'running',
    errors: [],
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: expired,
    leaseExpiresAt: expired,
  });

  assert.equal(store.reconcileExpiredRuns(), 1);
  const reconciled = store.getRun('run_expired_lease');
  assert.equal(reconciled?.status, 'abandoned');
  assert.match(reconciled?.errors.join(' ') || '', /lease expired/i);
  store.close();
});

test('idempotency claims replay exact responses and reject conflicting bodies', () => {
  const store = resetRuntimeStoreForTests(':memory:');
  const first = store.claimIdempotency('runtime-test-key', 'runtime.run', 'hash-a', 60);
  assert.equal(first.state, 'claimed');
  store.completeIdempotency('runtime-test-key', 'runtime.run', { ok: true, runId: 'run-stable' });

  const replay = store.claimIdempotency('runtime-test-key', 'runtime.run', 'hash-a', 60);
  assert.equal(replay.state, 'replay');
  assert.deepEqual(replay.record?.response, { ok: true, runId: 'run-stable' });

  const conflict = store.claimIdempotency('runtime-test-key', 'runtime.run', 'hash-b', 60);
  assert.equal(conflict.state, 'conflict');
});

test('body-bound HMAC rejects replay and scoped tokens enforce permissions', async () => {
  const body = JSON.stringify({ request: 'route this' });
  const first = signedRequest({ body, path: '/api/runtime/route', scope: 'runtime:route', nonce: `nonce-${crypto.randomUUID()}` });
  const firstAuth = await authorizeRequest(first, 'runtime:route');
  assert.equal(firstAuth.ok, true);
  const replay = await authorizeRequest(first.clone(), 'runtime:route');
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.error, /nonce/i);

  const token = issueScopedToken(process.env.ETLA_MASTER_SECRET || '', {
    subject: 'test-client',
    scopes: ['runtime:read'],
    ttlMs: 60_000,
  });
  const readRequest = new Request('http://localhost/api/runtime/readiness', { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await authorizeRequest(readRequest, 'runtime:read')).ok, true);
  const runRequest = new Request('http://localhost/api/runtime/run', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
  const denied = await authorizeRequest(runRequest, 'runtime:run');
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
});

test('pipeline uses the Host slot, executes Worker, revises on verifier feedback, and persists the result', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ model: string; system: string }> = [];
  let verifierCalls = 0;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string; messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((message) => message.role === 'system')?.content || '';
    calls.push({ model: body.model, system });
    if (body.model === 'worker-test') {
      return modelResponse({
        task: 'inspect code',
        summary: ['The source indicates validation is missing.'],
        findings: [{ claim: 'Validation is missing', evidence: ['app/example.ts:10'], confidence: 0.92, risk: 'medium' }],
        contradictions: [],
        unknowns: [],
        suggestedNextStep: 'Add validation and run tests.',
        needsHostAttention: ['validation behavior'],
        rawContextNeeded: [],
        sourceCoverage: 0.9,
      });
    }
    if (body.model === 'verifier-test') {
      verifierCalls += 1;
      return modelResponse(verifierCalls === 1 ? {
        verdict: 'revise',
        confidence: 0.94,
        issues: [{ severity: 'medium', issue: 'Draft omits validation evidence.', evidence: 'worker brief', requiredFix: 'Mention the validation and test requirement.' }],
        checks: { followsUserRequest: 'pass', sourceGrounded: 'fail', secretSafe: 'pass', actionSafe: 'pass', testsOrValidation: 'fail' },
        nextAction: 'revise',
      } : {
        verdict: 'pass',
        confidence: 0.97,
        issues: [],
        checks: { followsUserRequest: 'pass', sourceGrounded: 'pass', secretSafe: 'pass', actionSafe: 'pass', testsOrValidation: 'pass' },
        nextAction: 'answer',
      });
    }
    if (body.model === 'host-test') {
      const revision = /revising a draft/i.test(system);
      return modelResponse(revision
        ? 'Revised answer: add input validation and run the targeted tests before release.'
        : 'Initial answer: patch the function.');
    }
    if (body.model === 'boss-test') {
      return modelResponse({ verdict: 'approve', confidence: 0.95, reasoningSummary: 'Evidence is sufficient.', requiredChanges: [], allowedActions: ['answer'], forbiddenActions: [] });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const result = await runZenosPipeline({
      request: 'fix bug di file ini dan pastikan tervalidasi',
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      toolContext: 'app/example.ts:10 accepts unvalidated input.',
      persistSession: true,
      persistRouteEvent: false,
      autoRecallMemory: false,
      modelOverrides: {
        baseUrl: 'http://router.test/v1',
        apiKey: 'test-model-key',
        hostModel: 'host-test',
        workerModel: 'worker-test',
        verifierModel: 'verifier-test',
        bossModel: 'boss-test',
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.status, 'done');
    assert.equal(result.revisions, 1);
    assert.match(result.finalAnswer, /validation/i);
    assert.match(result.finalAnswer, /Runtime execution receipt/);
    assert.equal(result.executionReceipt?.host.calls, 2);
    assert.equal(result.executionReceipt?.worker.calls, 1);
    assert.equal(result.executionReceipt?.verifier.verdict, 'pass');
    assert.equal(result.executionReceipt?.boss.skipped, true);
    assert.ok(calls.some((call) => call.model === 'worker-test'));
    assert.ok(calls.some((call) => call.model === 'host-test'));
    assert.equal(calls.some((call) => call.model === 'boss-test'), false);
    assert.equal(result.modelCalls.filter((call) => call.role === 'host').length, 2);
    assert.equal(result.verifierResults.at(-1)?.verdict, 'pass');
    assert.ok(result.sessionId);
    const persisted = getRuntimeSession(result.sessionId || '');
    assert.equal(persisted?.status, 'done');
    assert.equal(persisted?.finalAnswer, result.finalAnswer);
    assert.equal(persisted?.budget.modelCallsUsed, result.modelCalls.length);
    assert.equal(
      persisted?.budget.hostTokensUsed,
      result.modelCalls.filter((call) => call.role === 'host').reduce((sum, call) => sum + call.usage.totalTokens, 0),
    );
    assert.equal(
      persisted?.budget.workerTokensUsed,
      result.modelCalls.filter((call) => call.role === 'worker').reduce((sum, call) => sum + call.usage.totalTokens, 0),
    );
    assert.equal(
      persisted?.budget.verifierTokensUsed,
      result.modelCalls.filter((call) => call.role === 'verifier').reduce((sum, call) => sum + call.usage.totalTokens, 0),
    );
    const outcome = getRuntimeStore().listOutcomes(1, { runId: result.runId })[0];
    assert.ok(outcome, 'native pipeline must write an Outcome Passport');
    assert.equal(outcome.verdict, 'revised');
    const passport = OutcomePassportSchema.parse(outcome.record);
    assert.equal(passport.roleUsage.worker.calls, 1);
    assert.equal(passport.roleUsage.runtime_host.calls, 2);
    assert.equal(passport.roleUsage.verifier.calls, 2);
    assert.ok(passport.latency.observations.some((item) => item.component === 'total'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('critical execution route invokes Boss and remains approval-aware', async () => {
  const originalFetch = globalThis.fetch;
  const modelNames: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    modelNames.push(body.model);
    if (body.model === 'host-critical') return modelResponse('A guarded deployment plan with rollback steps.');
    if (body.model === 'verifier-critical') return modelResponse({
      verdict: 'pass',
      confidence: 0.95,
      issues: [],
      checks: { followsUserRequest: 'pass', sourceGrounded: 'not_applicable', secretSafe: 'pass', actionSafe: 'pass', testsOrValidation: 'not_applicable' },
      nextAction: 'answer',
    });
    if (body.model === 'boss-critical') return modelResponse({
      verdict: 'approve',
      confidence: 0.9,
      reasoningSummary: 'Approve the advisory plan, not execution.',
      requiredChanges: [],
      allowedActions: ['provide plan'],
      forbiddenActions: ['claim deployment occurred'],
    });
    if (body.model === 'worker-critical') return modelResponse({
      task: 'none', summary: ['none'], findings: [], contradictions: [], unknowns: [], suggestedNextStep: 'none', needsHostAttention: [], rawContextNeeded: [], sourceCoverage: 0,
    });
    throw new Error(`Unexpected model ${body.model}`);
  };
  try {
    const result = await runZenosPipeline({
      request: 'deploy ke production sekarang',
      intent: 'execute',
      approvalGranted: false,
      persistSession: true,
      persistRouteEvent: false,
      autoRecallMemory: false,
      modelOverrides: {
        baseUrl: 'http://router.test/v1',
        apiKey: 'test-model-key',
        hostModel: 'host-critical',
        workerModel: 'worker-critical',
        verifierModel: 'verifier-critical',
        bossModel: 'boss-critical',
      },
    });
    assert.equal(result.ok, true);
    assert.ok(modelNames.includes('boss-critical'));
    assert.equal(result.executionReceipt?.boss.skipped, false);
    assert.equal(result.executionReceipt?.boss.verdict, 'approve');
    assert.match(result.finalAnswer, /Runtime execution receipt/);
    assert.equal(result.decision.requiresApproval, true);
    assert.ok(result.warnings.some((warning) => /approval/i.test(warning)));
    assert.ok(result.sessionId);
    const persisted = getRuntimeSession(result.sessionId || '');
    assert.equal(persisted?.budget.modelCallsUsed, result.modelCalls.length);
    assert.equal(
      persisted?.budget.premiumTokensUsed,
      result.modelCalls.filter((call) => call.role === 'boss').reduce((sum, call) => sum + call.usage.totalTokens, 0),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unresolved verifier revisions fail closed after the policy retry budget', async () => {
  const originalFetch = globalThis.fetch;
  let hostCalls = 0;
  let verifierCalls = 0;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    if (body.model === 'host-unresolved') {
      hostCalls += 1;
      return modelResponse(hostCalls === 1 ? 'Initial benchmark claim.' : 'Revised benchmark claim.');
    }
    if (body.model === 'verifier-unresolved') {
      verifierCalls += 1;
      return modelResponse({
        verdict: 'revise',
        confidence: 0.9,
        issues: [{ severity: 'medium', issue: 'Evidence is still insufficient.', evidence: '', requiredFix: 'Add independently verified evidence.' }],
        checks: { followsUserRequest: 'pass', sourceGrounded: 'fail', secretSafe: 'pass', actionSafe: 'not_applicable', testsOrValidation: 'fail' },
        nextAction: 'revise',
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const result = await runZenosPipeline({
      request: 'benchmark routing ini dan kasih score',
      intent: 'analyze',
      persistSession: false,
      persistRouteEvent: false,
      autoRecallMemory: false,
      modelOverrides: {
        baseUrl: 'http://router.test/v1',
        apiKey: 'test-model-key',
        hostModel: 'host-unresolved',
        workerModel: 'worker-unresolved',
        verifierModel: 'verifier-unresolved',
        bossModel: 'boss-unresolved',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(hostCalls, 2);
    assert.equal(verifierCalls, 2);
    assert.match(result.errors.join(' '), /unresolved/i);
    assert.equal(result.modelCalls.some((call) => call.role === 'boss'), false);
    const outcome = getRuntimeStore().listOutcomes(1, { runId: result.runId })[0];
    assert.ok(outcome, 'failed native pipeline must write an Outcome Passport');
    assert.equal(outcome.verdict, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
