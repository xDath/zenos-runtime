import test from 'node:test';
import assert from 'node:assert/strict';
import {
  postflightGatewayTurn,
  preflightGatewayTurn,
} from '../app/lib/gateway-orchestration';
import { getRuntimeSession } from '../app/lib/zenos-runtime-three-agent';
import { resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

function modelResponse(content: unknown): Response {
  return Response.json({
    choices: [{
      message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
  });
}

function hostPlan(overrides: Partial<{
  useWorker: boolean;
  workerTask: string;
  useVerifier: boolean;
  useBoss: boolean;
  confidence: number;
  rationale: string;
}> = {}) {
  return {
    intentSummary: 'Understand the request and keep Host responsible for the final decision.',
    useWorker: false,
    workerTask: '',
    useVerifier: false,
    useBoss: false,
    confidence: 0.92,
    rationale: 'Host can coordinate the minimum sufficient roles.',
    acceptanceCriteria: ['Answer the actual user goal.'],
    constraints: ['Worker may not make the final user-facing decision.'],
    ...overrides,
  };
}

function modelOverrides() {
  return {
    baseUrl: 'http://router.test/v1',
    apiKey: 'test-model-key',
    hostModel: 'runtime-host',
    hostProvider: 'test-router',
    workerModel: 'runtime-worker',
    workerProvider: 'test-router',
    verifierModel: 'runtime-verifier',
    verifierProvider: 'test-router',
    bossModel: 'runtime-boss',
    bossProvider: 'test-router',
  };
}

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY = 'true';
  process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = 'true';
});

test('native gateway direct path persists a real Runtime turn while skipping unnecessary roles', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('direct path must not call a Runtime model');
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'halo, jawab singkat ya',
      sessionId: 'hermes_direct_test',
      turnId: 'turn-direct-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      intent: 'explain',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.pipelineMode, 'direct_fast_path');
    assert.equal(preflight.receipt.worker.invoked, false);
    assert.equal(preflight.receipt.verifier.invoked, false);
    assert.equal(preflight.receipt.boss.invoked, false);
    assert.equal(preflight.holdFinalDelivery, false);
    assert.match(preflight.hostContext, /Worker skipped/i);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_direct_test',
      runId: preflight.runId,
      turnId: 'turn-direct-1',
      draft: 'Halo juga.',
      host: { model: 'grok', provider: 'etla-router' },
      hostUsage: { inputTokens: 20, cacheReadTokens: 100, outputTokens: 4, calls: 3 },
    });

    assert.equal(postflight.finalAnswer, 'Halo juga.');
    assert.equal(postflight.transformed, false);
    assert.equal(fetchCalls, 0);
    const session = getRuntimeSession('hermes_direct_test');
    assert.equal(session?.status, 'done');
    assert.equal(session?.finalAnswer, 'Halo juga.');
    assert.equal(session?.budget.hostTokensUsed, 124);
    assert.equal(session?.budget.modelCallsUsed, 3);
    assert.ok(session?.events.some((event) => event.metadata.role === 'host'));
    assert.ok(session?.events.some((event) => event.metadata.role === 'worker' && event.metadata.outcome === 'skipped'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native gateway worker path calls the configured Worker and injects its bounded brief into Hermes Host context', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: true,
        workerTask: 'Extract the three operational constraints without losing evidence.',
        rationale: 'The long source context should be compressed by Worker before Host synthesis.',
      }));
    }
    if (body.model === 'runtime-worker') {
      return modelResponse({
        task: 'summarize long context',
        summary: ['The request requires a concise evidence-preserving summary.'],
        findings: [{ claim: 'The source contains three operational constraints.', evidence: ['provided-context'], confidence: 0.94, risk: 'low' }],
        contradictions: [],
        unknowns: [],
        suggestedNextStep: 'Host should synthesize the bounded brief.',
        needsHostAttention: ['retain all three constraints'],
        rawContextNeeded: [],
        sourceCoverage: 0.92,
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'ringkas dokumen panjang ini tanpa menghilangkan batasannya',
      sessionId: 'hermes_worker_test',
      turnId: 'turn-worker-1',
      platform: 'whatsapp',
      host: { model: 'grok', provider: 'etla-router' },
      context: 'constraint A\nconstraint B\nconstraint C',
      estimatedContextTokens: 10_000,
      intent: 'analyze',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.receipt.worker.invoked, true);
    assert.equal(preflight.receipt.worker.model, 'runtime-worker');
    assert.match(preflight.hostContext, /three operational constraints/i);
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker']);
    assert.match(preflight.hostContext, /Host orchestration: worker=true/i);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_worker_test',
      runId: preflight.runId,
      turnId: 'turn-worker-1',
      draft: 'Ringkasan Host yang mempertahankan constraint A, B, dan C.',
      host: { model: 'grok', provider: 'etla-router' },
      hostUsage: { inputTokens: 500, outputTokens: 80 },
    });

    assert.equal(postflight.receipt.worker.invoked, true);
    assert.equal(postflight.receipt.verifier.invoked, false);
    assert.equal(postflight.finalAnswer, 'Ringkasan Host yang mempertahankan constraint A, B, dan C.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clear coding work keeps Host as orchestrator before bounded Worker delegation', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: true,
        workerTask: 'Inspect the bounded parser change and return evidence only.',
        rationale: 'Host delegates repository inspection while retaining the final decision.',
      }));
    }
    if (body.model !== 'runtime-worker') throw new Error(`Unexpected model ${body.model}`);
    return modelResponse({
      task: 'inspect and bound the requested code change',
      summary: ['Host delegated source inspection while retaining final orchestration.'],
      findings: [{ claim: 'The change is scoped to one implementation path.', evidence: ['repository-context'], confidence: 0.9, risk: 'medium' }],
      contradictions: [],
      unknowns: [],
      suggestedNextStep: 'Hermes Host should implement and validate the bounded change.',
      needsHostAttention: [],
      rawContextNeeded: [],
      sourceCoverage: 0.9,
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'perbaiki fungsi parser ini lalu jalankan test terkait',
      sessionId: 'hermes_clear_coding_test',
      turnId: 'turn-clear-coding-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      hasFiles: true,
      hasCodeChangeIntent: true,
      estimatedContextTokens: 2_500,
      intent: 'mutate',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.taskType, 'coding_change');
    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.receipt.host.plannerInvoked, true);
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Host planner can retain a serious task and prevent Worker from becoming the lead agent', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model !== 'runtime-host') throw new Error(`Unexpected model ${body.model}`);
    return modelResponse(hostPlan({
      useWorker: false,
      rationale: 'The Host can reason over the bounded request without delegating it.',
    }));
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'ringkas konteks panjang ini, tapi fokus hanya pada keputusan utamanya',
      sessionId: 'hermes_host_retains_test',
      turnId: 'turn-host-retains-1',
      platform: 'discord',
      host: { model: 'grok', provider: 'etla-router' },
      context: 'bounded context',
      estimatedContextTokens: 10_000,
      intent: 'analyze',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.useWorker, false);
    assert.equal(preflight.receipt.worker.invoked, false);
    assert.deepEqual(calledModels, ['runtime-host']);
    assert.match(preflight.decision.reasons.join(' '), /Host retained the task/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit Boss request invokes Boss exactly once and records user-requested escalation', async () => {
  const originalFetch = globalThis.fetch;
  let bossCalls = 0;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useBoss: true,
        rationale: 'The user explicitly requested the highest-authority review.',
      }));
    }
    if (body.model !== 'runtime-boss') throw new Error(`Unexpected model ${body.model}`);
    bossCalls += 1;
    return modelResponse({
      verdict: 'approve',
      confidence: 0.96,
      reasoningSummary: 'Use a private authenticated RPC endpoint close to the target chain.',
      requiredChanges: [],
      allowedActions: ['explain provider options'],
      forbiddenActions: ['claim free unlimited infrastructure exists'],
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'coba tanya agent boss ada ga caranya supaya private RPC lebih dekat dengan chain',
      sessionId: 'hermes_explicit_boss_test',
      turnId: 'turn-boss-1',
      platform: 'matrix',
      host: { model: 'grok', provider: 'etla-router' },
      intent: 'analyze',
      userRequestedBoss: true,
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.useBoss, true);
    assert.equal(preflight.decision.pipelineMode, 'escalated_deep_path');
    assert.equal(preflight.decision.useVerifier, false);
    assert.match(preflight.decision.reasons.join(' '), /explicitly requested Boss/i);
    assert.equal(preflight.receipt.boss.invoked, true);
    assert.equal(bossCalls, 1);
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-boss']);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_explicit_boss_test',
      runId: preflight.runId,
      turnId: 'turn-boss-1',
      draft: 'Gunakan private authenticated RPC dan pilih region terdekat dengan validator atau sequencer chain.',
      host: { model: 'grok', provider: 'etla-router' },
      hostUsage: { inputTokens: 420, outputTokens: 75 },
      hostDurationMs: 1850,
    });

    assert.equal(bossCalls, 1, 'explicit Boss request should not double-call Boss in postflight');
    assert.equal(postflight.receipt.boss.invoked, true);
    assert.equal(postflight.receipt.boss.model, 'runtime-boss');
    const session = getRuntimeSession('hermes_explicit_boss_test');
    assert.ok(session?.events.some((event) => event.metadata.lifecycle === 'model_call'
      && event.metadata.role === 'boss'
      && event.metadata.status === 'completed'));
    assert.ok(session?.events.some((event) => event.metadata.lifecycle === 'model_call'
      && event.metadata.role === 'host'
      && event.metadata.latencyMs === 1850));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native gateway verified critical path executes Verifier and Boss before releasing the Hermes draft', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  let bossCalls = 0;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string; messages: Array<{ role: string; content: string }> };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useVerifier: true,
        useBoss: true,
        confidence: 0.82,
        rationale: 'Critical production execution requires Verifier and Boss authority.',
      }));
    }
    if (body.model === 'runtime-verifier') {
      return modelResponse({
        verdict: 'pass',
        confidence: 0.97,
        issues: [],
        checks: {
          followsUserRequest: 'pass',
          sourceGrounded: 'not_applicable',
          secretSafe: 'pass',
          actionSafe: 'pass',
          testsOrValidation: 'not_applicable',
        },
        nextAction: 'answer',
      });
    }
    if (body.model === 'runtime-boss') {
      bossCalls += 1;
      return modelResponse({
        verdict: 'approve',
        confidence: 0.95,
        reasoningSummary: bossCalls === 1
          ? 'Preflight permits only an advisory deployment plan.'
          : 'Postflight draft is advisory and does not claim execution.',
        requiredChanges: [],
        allowedActions: ['provide an advisory plan'],
        forbiddenActions: ['claim production deployment occurred'],
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'deploy ke production sekarang',
      sessionId: 'hermes_critical_test',
      turnId: 'turn-critical-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      intent: 'execute',
      approvalGranted: false,
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.useBoss, true);
    assert.equal(preflight.decision.useVerifier, true);
    assert.equal(preflight.holdFinalDelivery, true);
    assert.equal(preflight.receipt.boss.invoked, true);
    assert.match(preflight.hostContext, /forbidden actions/i);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_critical_test',
      runId: preflight.runId,
      turnId: 'turn-critical-1',
      draft: 'Ini rencana advisory; deployment belum dijalankan dan tetap memerlukan approval eksplisit.',
      host: { model: 'grok', provider: 'etla-router' },
      hostUsage: { inputTokens: 600, outputTokens: 90 },
    });

    assert.equal(postflight.receipt.verifier.invoked, true);
    assert.equal(postflight.receipt.verifier.verdict, 'pass');
    assert.equal(postflight.receipt.boss.invoked, true);
    assert.equal(postflight.receipt.boss.verdict, 'approve');
    assert.equal(bossCalls, 2);
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-boss', 'runtime-verifier', 'runtime-boss']);
    assert.equal(postflight.finalAnswer, 'Ini rencana advisory; deployment belum dijalankan dan tetap memerlukan approval eksplisit.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
