import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GatewayTurnPostflightRequestSchema,
  GatewayTurnPreflightRequestSchema,
} from '../app/lib/gateway-contracts';
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

test('Hermes postflight contract accepts a null workspace state without losing strict validation', () => {
  const parsed = GatewayTurnPostflightRequestSchema.parse({
    sessionId: 'hermes-null-workspace',
    runId: 'gateway-null-workspace',
    turnId: 'turn-null-workspace',
    draft: 'done',
    host: { model: 'grok', provider: 'etla-router' },
    workspaceState: null,
  });
  assert.equal(parsed.workspaceState, undefined);
});

test('gateway canonicalizes legacy root workspace aliases before Host tool execution', () => {
  const parsed = GatewayTurnPreflightRequestSchema.parse({
    request: 'inspect the repository only',
    sessionId: 'hermes-canonical-workspace',
    turnId: 'turn-canonical-workspace',
    platform: 'telegram',
    host: { model: 'grok', provider: 'etla-router' },
    workspaceRoot: '/root/openclaw-projects/zenos-runtime',
  });
  assert.equal(parsed.workspaceRoot, '/srv/etla/workspaces/zenos-runtime');
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
    assert.equal(preflight.hostAuthority, 'runtime');
    assert.deepEqual(preflight.hostOverride, { model: 'runtime-host', provider: 'test-router' });
    assert.equal(preflight.receipt.host.model, 'runtime-host');
    assert.equal(preflight.receipt.host.provider, 'test-router');
    assert.match(preflight.hostContext, /Worker skipped/i);
    assert.match(preflight.hostContext, /gateway_reported_model: grok/i);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_direct_test',
      runId: preflight.runId,
      turnId: 'turn-direct-1',
      draft: 'Halo juga.',
      host: preflight.hostOverride,
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

test('large simple chat stays direct and never burns an auxiliary planner or Worker call', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('large simple chat must stay deterministic and Host-only');
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'mana kok masih utuh',
      sessionId: 'hermes_large_direct_test',
      turnId: 'turn-large-direct-1',
      platform: 'telegram',
      host: { model: 'deepseek', provider: 'etla-router' },
      context: 'historical compacted context '.repeat(2_000),
      estimatedContextTokens: 31_000,
      intent: 'analyze',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.taskType, 'simple_chat');
    assert.equal(preflight.decision.pipelineMode, 'direct_fast_path');
    assert.equal(preflight.decision.useWorker, false);
    assert.equal(preflight.receipt.host.plannerInvoked, false);
    assert.equal(preflight.receipt.worker.invoked, false);
    assert.equal(fetchCalls, 0);
    assert.match(preflight.decision.reasons.join(' '), /deterministic context compaction is cheaper/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.skip('legacy Runtime Worker compression path is superseded by native Hermes delegation', async () => {
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

test.skip('legacy preflight Worker delegation is superseded by Host-led native Hermes delegation', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-gateway-coding-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gateway-coding-fixture', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'src', 'parser.ts'), 'export const parse = (value: string) => value.trim();\n');
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
      workspaceRoot: root,
      hasFiles: true,
      hasCodeChangeIntent: true,
      estimatedContextTokens: 2_500,
      intent: 'mutate',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.taskType, 'coding_change');
    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.decision.useVerifier, true);
    assert.equal(preflight.receipt.host.plannerInvoked, true);
    assert.match(preflight.decision.reasons.join(' '), /deterministic policy requires independent Verifier review/i);
    assert.ok(preflight.codingTaskId);
    assert.equal(preflight.codingPhase, 'inspect');
    assert.match(preflight.hostContext, new RegExp(preflight.codingTaskId || 'missing-task'));
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy Host Planner path is disabled by default in the cognitive runtime', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-gateway-verifier-optout-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gateway-verifier-optout', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'src', 'fix.ts'), 'export const value = 1;\n');
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: true,
        useVerifier: true,
        workerTask: 'Inspect the bounded change and return evidence.',
        rationale: 'The planner would normally request independent verification.',
      }));
    }
    if (body.model !== 'runtime-worker') throw new Error(`Unexpected model ${body.model}`);
    return modelResponse({
      task: 'inspect bounded code change',
      summary: ['The requested change is bounded and ready for Host execution.'],
      findings: [{ claim: 'One source file is involved.', evidence: ['src/fix.ts'], confidence: 0.9, risk: 'medium' }],
      contradictions: [],
      unknowns: [],
      suggestedNextStep: 'Host should implement and self-review the change.',
      needsHostAttention: [],
      rawContextNeeded: [],
      sourceCoverage: 0.9,
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'Jangan pake verifier di runtimenya. Host review sendiri lalu lanjutkan perbaikan file ini.',
      sessionId: 'hermes_verifier_optout',
      turnId: 'turn-verifier-optout',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      workspaceRoot: root,
      hasFiles: true,
      hasCodeChangeIntent: true,
      estimatedContextTokens: 2_500,
      intent: 'mutate',
      userRequestedVerification: true,
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.decision.useVerifier, false);
    assert.equal(preflight.decision.verifierTier, 'none');
    assert.equal(preflight.receipt.verifier.invoked, false);
    assert.match(preflight.decision.reasons.join(' '), /Host owns final self-review/i);
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy Worker-assisted continuity path is covered by cognitive capsules instead', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync('/srv/etla/workspaces/etla-continuity-test-');
  const projectName = path.basename(root);
  const legacyRoot = `/root/openclaw-projects/${projectName}`;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: projectName }));
  fs.writeFileSync(path.join(root, 'bot.py'), 'print("unfinished")\n');
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: false,
        useVerifier: false,
        rationale: 'The current sentence looks small in isolation.',
      }));
    }
    if (body.model === 'runtime-worker') {
      return modelResponse({
        task: 'inspect unfinished sell-card implementation',
        summary: ['The previous patch is incomplete and must be repaired before finalization.'],
        findings: [{
          claim: 'bot.py was left mid-patch with an IndentationError.',
          evidence: [`${legacyRoot}/bot.py`],
          confidence: 0.99,
          risk: 'high',
        }],
        contradictions: [],
        unknowns: [],
        suggestedNextStep: 'Repair or rollback, then run deterministic validation.',
        needsHostAttention: ['Do not finish while bot.py is broken.'],
        rawContextNeeded: [],
        sourceCoverage: 0.95,
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'tolong fix dong',
      sessionId: 'hermes_coding_continuity_test',
      turnId: 'turn-coding-continuity-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      context: [
        `Reading ${legacyRoot}/bot.py`,
        `Editing ${legacyRoot}/bot.py`,
        'Status jujur: file sempat rusak mid-patch dan belum selesai.',
        'Blocker sekarang: bot.py IndentationError. Next turn repair lalu jalankan test.',
      ].join('\n'),
      intent: 'analyze',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.taskType, 'coding_change');
    assert.equal(preflight.decision.pipelineMode, 'verified_path');
    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.decision.useVerifier, true);
    assert.equal(preflight.holdFinalDelivery, true);
    assert.equal(preflight.receipt.host.plannerInvoked, false);
    assert.equal(preflight.receipt.worker.invoked, true);
    assert.equal(preflight.codingPhase, 'inspect');
    assert.match(preflight.hostContext, new RegExp(`Canonical workspace root: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    assert.match(preflight.hostContext, /do not ask the user to reply "gas"/i);
    assert.match(preflight.decision.reasons.join(' '), /unfinished coding context recovered from compacted session evidence/i);
    assert.deepEqual(calledModels, ['runtime-worker']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy role-call continuation expectations are superseded by durable cognitive continuation', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-gateway-no-confirm-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'no-confirm-fixture' }));
  fs.writeFileSync(path.join(root, 'src', 'bot.py'), 'print("ok")\n');
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: false,
        useVerifier: true,
        rationale: 'Host can execute the bounded implementation without preliminary Worker delegation.',
      }));
    }
    if (body.model === 'runtime-worker') {
      return modelResponse({
        task: 'inspect the bounded coding task before Host execution',
        summary: ['The coding task remains bounded and requires implementation plus validation.'],
        findings: [{
          claim: 'The requested repair belongs to the active repository task.',
          evidence: ['repository-context'],
          confidence: 0.95,
          risk: 'medium',
        }],
        contradictions: [],
        unknowns: [],
        suggestedNextStep: 'Hermes Host should finish the repair and validate it.',
        needsHostAttention: [],
        rawContextNeeded: [],
        sourceCoverage: 0.9,
      });
    }
    if (body.model === 'runtime-verifier') {
      return modelResponse({
        verdict: 'pass',
        confidence: 0.9,
        issues: [],
        checks: {
          followsUserRequest: 'pass',
          sourceGrounded: 'pass',
          secretSafe: 'pass',
          actionSafe: 'pass',
          testsOrValidation: 'not_applicable',
        },
        nextAction: 'answer',
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'perbaiki bot ini sampai selesai',
      sessionId: 'hermes_no_confirmation_test',
      turnId: 'turn-no-confirmation-1',
      platform: 'telegram',
      host: { model: 'deepseek', provider: 'etla-router' },
      workspaceRoot: root,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      modelOverrides: modelOverrides(),
    });
    assert.ok(preflight.codingTaskId);
    assert.equal(preflight.decision.useWorker, true);
    assert.equal(preflight.receipt.worker.invoked, true);
    assert.match(preflight.decision.reasons.join(' '), /deterministic task policy requires bounded Worker support/i);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_no_confirmation_test',
      runId: preflight.runId,
      turnId: 'turn-no-confirmation-1',
      draft: 'Patch 2/6 selesai. Gas lanjut?',
      host: { model: 'deepseek', provider: 'etla-router' },
      toolSummary: 'read_file: inspected src/bot.py; more implementation remains',
      hostUsage: { inputTokens: 400, outputTokens: 70, calls: 2 },
    });

    assert.equal(postflight.ok, true);
    assert.equal(postflight.failed, false);
    assert.equal(postflight.continuation?.required, true);
    assert.equal(postflight.continuation?.reason, 'host_interrupted');
    assert.equal(postflight.continuation?.attempt, 1);
    assert.match(postflight.continuation?.prompt || '', /do not ask the user to reply “gas”/i);
    assert.equal(getRuntimeSession('hermes_no_confirmation_test')?.status, 'working');
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker', 'runtime-verifier']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy coding-task-only continuation contract is superseded by root cognitive task continuity', async () => {
  const originalFetch = globalThis.fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-gateway-continuation-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'continuation-fixture', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'src', 'parser.ts'), 'export const parse = (value: string) => value.trim();\n');
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model === 'runtime-host') {
      return modelResponse(hostPlan({
        useWorker: false,
        useVerifier: true,
        rationale: 'Host owns the bounded coding change and requires final validation.',
      }));
    }
    if (body.model === 'runtime-worker') {
      return modelResponse({
        task: 'continue the same durable coding task',
        summary: ['The existing task remains active and needs deterministic validation.'],
        findings: [{
          claim: 'The continuation belongs to the existing coding task.',
          evidence: ['active-coding-task'],
          confidence: 0.99,
          risk: 'high',
        }],
        contradictions: [],
        unknowns: [],
        suggestedNextStep: 'Repair the bounded defect and rerun targeted validation.',
        needsHostAttention: ['Do not reclassify the internal continuation as deployment.'],
        rawContextNeeded: [],
        sourceCoverage: 0.95,
      });
    }
    if (body.model === 'runtime-verifier') {
      return modelResponse({
        verdict: 'pass',
        confidence: 0.9,
        issues: [],
        checks: {
          followsUserRequest: 'pass',
          sourceGrounded: 'pass',
          secretSafe: 'pass',
          actionSafe: 'pass',
          testsOrValidation: 'fail',
        },
        nextAction: 'answer',
      });
    }
    throw new Error(`Unexpected model ${body.model}`);
  };

  const beforeState = {
    workspaceRoot: root,
    gitHead: '',
    dirtyDiffSha256: 'a'.repeat(64),
    changedFiles: [],
    clean: true,
    capturedAt: new Date().toISOString(),
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'fix parser ini sampai targeted test lulus',
      sessionId: 'hermes_internal_continuation_test',
      turnId: 'turn-internal-continuation-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      workspaceRoot: root,
      workspaceState: beforeState,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
      modelOverrides: modelOverrides(),
    });
    assert.ok(preflight.codingTaskId);

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_internal_continuation_test',
      runId: preflight.runId,
      turnId: 'turn-internal-continuation-1',
      draft: 'Patch applied but test still fails; continue next turn.',
      host: { model: 'grok', provider: 'etla-router' },
      toolSummary: [
        'edit_file: completed — Updated src/parser.ts',
        'test.run: failed — targeted parser test exited code 1',
      ].join('\n'),
      workspaceState: {
        ...beforeState,
        dirtyDiffSha256: 'b'.repeat(64),
        clean: false,
        capturedAt: new Date().toISOString(),
      },
      hostUsage: { inputTokens: 600, outputTokens: 100, calls: 2 },
    });

    assert.equal(postflight.ok, true);
    assert.equal(postflight.failed, false);
    assert.equal(postflight.continuation?.required, true);
    assert.equal(postflight.continuation?.taskId, preflight.codingTaskId);
    assert.equal(postflight.continuation?.attempt, 1);
    assert.match(postflight.continuation?.prompt || '', /same Zenos Runtime coding task/i);
    assert.match(postflight.continuation?.prompt || '', /Do not ask the user to reply/i);
    const session = getRuntimeSession('hermes_internal_continuation_test');
    assert.equal(session?.status, 'working');

    const continuedPreflight = await preflightGatewayTurn({
      request: postflight.continuation?.prompt || '',
      sessionId: 'hermes_internal_continuation_test',
      turnId: 'turn-internal-continuation-2',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      workspaceRoot: root,
      workspaceState: {
        ...beforeState,
        dirtyDiffSha256: 'b'.repeat(64),
        clean: false,
        capturedAt: new Date().toISOString(),
      },
      modelOverrides: modelOverrides(),
    });
    assert.notEqual(continuedPreflight.runId, preflight.runId);
    assert.equal(continuedPreflight.codingTaskId, preflight.codingTaskId);
    assert.equal(continuedPreflight.decision.taskType, 'coding_change');
    assert.notEqual(continuedPreflight.decision.taskType, 'deploy_or_destructive_action');
    assert.match(
      continuedPreflight.decision.reasons.join(' '),
      /active durable coding task overrides lexical classification/i,
    );
    assert.deepEqual(calledModels, ['runtime-host', 'runtime-worker', 'runtime-verifier', 'runtime-worker']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy mandatory Verifier mutation policy is superseded by deterministic validation and cognitive repair', async () => {
  const originalFetch = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    calledModels.push(body.model);
    if (body.model !== 'runtime-verifier') throw new Error(`Unexpected model ${body.model}`);
    return modelResponse({
      verdict: 'pass',
      confidence: 0.9,
      issues: [],
      checks: {
        followsUserRequest: 'pass',
        sourceGrounded: 'pass',
        secretSafe: 'pass',
        actionSafe: 'pass',
        testsOrValidation: 'fail',
      },
      nextAction: 'answer',
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'cek sell card ini',
      sessionId: 'hermes_broken_patch_test',
      turnId: 'turn-broken-patch-1',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      intent: 'analyze',
      modelOverrides: modelOverrides(),
    });
    assert.equal(preflight.decision.pipelineMode, 'direct_fast_path');

    const postflight = await postflightGatewayTurn({
      sessionId: 'hermes_broken_patch_test',
      runId: preflight.runId,
      turnId: 'turn-broken-patch-1',
      draft: 'Status jujur: file sempat rusak mid-patch, lanjut next turn.',
      host: { model: 'grok', provider: 'etla-router' },
      toolSummary: [
        'edit_file: completed — Updated /root/openclaw-projects/rh-copybot/bot.py',
        'terminal: failed — python -m py_compile bot.py exited code 1: IndentationError',
      ].join('\n'),
      hostUsage: { inputTokens: 500, outputTokens: 90, calls: 2 },
    });

    assert.equal(postflight.ok, false);
    assert.equal(postflight.failed, true);
    assert.equal(postflight.receipt.pipeline, 'verified_path');
    assert.equal(postflight.receipt.verifier.invoked, true);
    assert.match(postflight.finalAnswer, /Runtime memblokirnya/i);
    assert.match(postflight.finalAnswer, /repair|rollback/i);
    assert.deepEqual(calledModels, ['runtime-verifier']);
    const session = getRuntimeSession('hermes_broken_patch_test');
    assert.equal(session?.status, 'failed');
    assert.match(session?.lastError || '', /deterministic validation/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.skip('legacy planner retention call is unnecessary in Host-led mode', async () => {
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
      request: 'rancang arsitektur migrasi ini, tapi fokus hanya pada keputusan utamanya',
      sessionId: 'hermes_host_retains_test',
      turnId: 'turn-host-retains-1',
      platform: 'discord',
      host: { model: 'grok', provider: 'etla-router' },
      context: 'bounded context',
      estimatedContextTokens: 10_000,
      intent: 'plan',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.decision.taskType, 'planning_or_architecture');
    assert.equal(preflight.decision.useWorker, false);
    assert.equal(preflight.receipt.worker.invoked, false);
    assert.deepEqual(calledModels, ['runtime-host']);
    assert.match(preflight.decision.reasons.join(' '), /Host retained the task/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.skip('legacy planner token reservation is unnecessary in Host-led mode', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    assert.equal(body.model, 'runtime-host');
    return Response.json({
      choices: [{ message: { content: JSON.stringify(hostPlan({
        useWorker: false,
        rationale: 'Host retains the task after a deliberately expensive planning call.',
      })) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2_100, completion_tokens: 180, total_tokens: 2_280 },
    });
  };

  try {
    const preflight = await preflightGatewayTurn({
      request: 'rancang arsitektur perubahan ini dan tentukan keputusan yang paling aman',
      sessionId: 'hermes_planner_budget_isolation',
      turnId: 'turn-planner-budget-isolation',
      platform: 'telegram',
      host: { model: 'grok', provider: 'etla-router' },
      context: 'bounded context '.repeat(300),
      estimatedContextTokens: 12_000,
      intent: 'plan',
      modelOverrides: modelOverrides(),
    });

    assert.equal(preflight.receipt.host.plannerInvoked, true);
    assert.ok(preflight.hostBudget.reservedTokens > 0);
    assert.equal(preflight.hostBudget.budgetId.startsWith('gateway_'), true);
    assert.equal(preflight.hostBudget.budgetId.endsWith(':planning'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.skip('legacy role-specific Boss model test is replaced by same-model explicit review coverage', async () => {
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

test.skip('legacy role-specific critical path is replaced by same-model review coverage', async () => {
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
