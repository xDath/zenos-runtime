import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  createCodingCheckpoint,
  beginCodingRevision,
  createCodingTask,
  evaluateMinimalPatchPolicy,
  loadCodingTask,
  prepareCodexExecution,
  recordCodexPatch,
  recordRemoteValidationResult,
  rollbackCodingCheckpoint,
  runCodexValidationStage,
  transitionCodingTask,
} from '../app/lib/codex-execution-core';
import { runZenosPipeline } from '../app/lib/zenos-runtime-executor';
import { ToolBroker, ToolEvidenceSchema } from '../app/lib/tool-broker';
import { resetRuntimeStoreForTests, RuntimeStore } from '../app/lib/zenos-runtime-store';

function modelResponse(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function validationBroker(statuses: Partial<Record<'test.run' | 'typecheck.run' | 'build.run', 'success' | 'failed' | 'remote_required'>>): ToolBroker {
  const broker = new ToolBroker();
  for (const name of ['test.run', 'typecheck.run', 'build.run'] as const) {
    broker.register({
      name,
      description: `test double for ${name}`,
      risk: 'read_only',
      inputSchema: z.record(z.string(), z.unknown()),
      cacheable: false,
      producesEvidence: true,
      async execute() {
        const status = statuses[name] || 'success';
        return ToolEvidenceSchema.parse({
          tool: name,
          status,
          summary: `${name} ${status}`,
          details: status === 'failed' ? { stderr: `${name} deterministic failure` } : {},
          durationMs: 1,
          cacheable: false,
          evidence: true,
        });
      },
    });
  }
  return broker;
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-codex-core-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: { test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'next build' },
  }));
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'value.test.ts'), "import { value } from '../src/value';\nvoid value;\n");
  return root;
}

test('coding task state persists and rejects invalid phase transitions', (context) => {
  const root = createFixture();
  const store = new RuntimeStore(':memory:');
  context.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = createCodingTask({
    taskId: 'task-state-test',
    request: 'fix src/value.ts',
    workspaceRoot: root,
    workspaceRevision: 'revision-1',
  }, store);
  assert.equal(state.currentPhase, 'understand');
  const planned = transitionCodingTask(state.taskId, 'plan', { summary: 'Plan smallest patch.' }, store);
  assert.equal(planned.currentPhase, 'plan');
  assert.throws(() => transitionCodingTask(state.taskId, 'targeted_validation', { summary: 'skip inspect' }, store), /Invalid coding phase transition/);
  const loaded = loadCodingTask(state.taskId, store);
  assert.equal(loaded?.version, planned.version);
  assert.ok(store.health().schemaVersion >= 4);
  assert.deepEqual(store.listOutcomes(10), []);
});

test('Codex preparation creates repository-aware inspect state and checkpoint', async (context) => {
  const root = createFixture();
  const store = new RuntimeStore(':memory:');
  context.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const prepared = await prepareCodexExecution({
    taskId: 'prepared-task',
    request: 'fix src/value.ts and run the related test',
    workspaceRoot: root,
    acceptanceCriteria: ['value behavior is corrected', 'related tests pass'],
  }, store);

  assert.equal(prepared.state.currentPhase, 'inspect');
  assert.ok(prepared.state.filesInspected.includes('src/value.ts'));
  assert.ok(prepared.state.checkpoints.length === 1);
  assert.ok(prepared.impact.relatedTests.includes('tests/value.test.ts'));
  assert.match(prepared.context, /Repository revision:/);
  assert.match(prepared.context, /Validation plan:/);
});

test('checkpoint rollback restores file content only with approval', async (context) => {
  const root = createFixture();
  const store = new RuntimeStore(':memory:');
  context.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'src', 'value.ts');
  const state = createCodingTask({
    taskId: 'rollback-task',
    request: 'change value',
    workspaceRoot: root,
    workspaceRevision: 'revision-1',
  }, store);
  const checkpointed = await createCodingCheckpoint(state.taskId, ['src/value.ts'], {}, store);
  const checkpointId = checkpointed.checkpoints[0].checkpointId;
  fs.writeFileSync(target, 'export const value = 999;\n');

  assert.throws(
    () => rollbackCodingCheckpoint(state.taskId, checkpointId, { approvalGranted: false }, store),
    /Explicit approval/,
  );
  const rollback = rollbackCodingCheckpoint(state.taskId, checkpointId, { approvalGranted: true }, store);
  assert.deepEqual(rollback.restored, ['src/value.ts']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'export const value = 1;\n');
});

test('Codex validation ladder persists targeted, remote-required, and completed states', async (context) => {
  const root = createFixture();
  const store = new RuntimeStore(':memory:');
  context.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = await prepareCodexExecution({
    taskId: 'validation-ladder-task',
    request: 'fix src/value.ts',
    workspaceRoot: root,
  }, store);
  const patch = await recordCodexPatch({
    taskId: prepared.state.taskId,
    changedFiles: ['src/value.ts'],
    allowedFiles: ['src/value.ts', 'tests/value.test.ts'],
    diff: 'diff --git a/src/value.ts b/src/value.ts\n-export const value = 1;\n+export const value = 2;',
  }, store);
  assert.equal(patch.policy.verdict, 'pass');
  assert.equal(patch.state.currentPhase, 'patch');

  const targeted = await runCodexValidationStage({
    taskId: prepared.state.taskId,
    stage: 'targeted',
    tools: [{ name: 'test.run', input: {} }, { name: 'typecheck.run', input: {} }],
  }, store, validationBroker({}));
  assert.equal(targeted.status, 'passed');
  assert.equal(targeted.state.currentPhase, 'full_validation');

  const full = await runCodexValidationStage({
    taskId: prepared.state.taskId,
    stage: 'full',
    tools: [{ name: 'build.run', input: {} }],
  }, store, validationBroker({ 'build.run': 'remote_required' }));
  assert.equal(full.status, 'remote_required');
  assert.equal(full.state.currentPhase, 'full_validation');
  assert.ok(full.state.validations.some((validation) => validation.status === 'remote_required'));

  const completed = recordRemoteValidationResult({
    taskId: prepared.state.taskId,
    passed: true,
    summary: 'GitHub Actions quality gate passed.',
    artifactId: 'gha-run-123',
  }, store);
  assert.equal(completed.currentPhase, 'summarize');
  assert.equal(completed.status, 'completed');
});

test('failed targeted validation produces a delta revision packet', async (context) => {
  const root = createFixture();
  const store = new RuntimeStore(':memory:');
  context.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = await prepareCodexExecution({
    taskId: 'revision-packet-task',
    request: 'fix src/value.ts',
    workspaceRoot: root,
  }, store);
  await recordCodexPatch({
    taskId: prepared.state.taskId,
    changedFiles: ['src/value.ts'],
    allowedFiles: ['src/value.ts'],
    diff: 'diff --git a/src/value.ts b/src/value.ts\n-export const value = 1;\n+export const value = 2;',
  }, store);
  const failed = await runCodexValidationStage({
    taskId: prepared.state.taskId,
    stage: 'targeted',
    tools: [{ name: 'test.run', input: {} }],
  }, store, validationBroker({ 'test.run': 'failed' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.state.currentPhase, 'analyze_failure');
  assert.match(failed.revisionPacket || '', /failedChecks/);
  assert.match(failed.revisionPacket || '', /test\.run deterministic failure/);

  const revision = beginCodingRevision(prepared.state.taskId, store);
  assert.equal(revision.state.currentPhase, 'revise');
  assert.match(revision.revisionPacket, /smallest affected-file delta/);
});

test('runtime pipeline compiles repository intelligence into a persistent Codex task packet', async (context) => {
  const root = createFixture();
  resetRuntimeStoreForTests(':memory:');
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string; messages?: Array<{ content?: string }> };
    prompts.push((body.messages || []).map((message) => message.content || '').join('\n'));
    if (body.model === 'worker-repo') return modelResponse({
      task: 'inspect repository evidence',
      summary: ['Repository evidence identifies src/value.ts and its related test.'],
      findings: [{ claim: 'src/value.ts is the bounded target', evidence: ['src/value.ts:1'], confidence: 0.95, risk: 'low' }],
      contradictions: [],
      unknowns: [],
      suggestedNextStep: 'Apply the smallest patch and run the related test.',
      needsHostAttention: [],
      rawContextNeeded: [],
      sourceCoverage: 1,
    });
    if (body.model === 'host-repo') return modelResponse('Use the repository impact set, patch src/value.ts minimally, and run the related validation.');
    if (body.model === 'verifier-repo') return modelResponse({
      verdict: 'pass',
      confidence: 0.98,
      issues: [],
      checks: { followsUserRequest: 'pass', sourceGrounded: 'pass', secretSafe: 'pass', actionSafe: 'pass', testsOrValidation: 'pass' },
      nextAction: 'answer',
    });
    throw new Error(`Unexpected model ${body.model}`);
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runZenosPipeline({
    request: 'fix src/value.ts and run its related test',
    hasFiles: true,
    hasCodeChangeIntent: true,
    intent: 'mutate',
    workspaceRoot: root,
    autonomousCoding: false,
    autoRecallMemory: false,
    persistSession: false,
    modelOverrides: {
      baseUrl: 'http://router.test/v1',
      apiKey: 'test-key',
      workerModel: 'worker-repo',
      hostModel: 'host-repo',
      verifierModel: 'verifier-repo',
      bossModel: 'boss-repo',
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.repositoryIntelligence?.root, root);
  assert.ok(result.repositoryIntelligence?.impact.relatedTests.includes('tests/value.test.ts'));
  assert.equal(result.codingTask?.currentPhase, 'inspect');
  assert.ok(result.codingTask?.checkpoints.length);
  assert.ok(prompts.some((prompt) => /Repository revision:/.test(prompt)));
  assert.ok(prompts.some((prompt) => /Validation plan:/.test(prompt)));
});

test('minimal patch policy blocks disabled checks, deleted tests, and unrelated files', () => {
  const result = evaluateMinimalPatchPolicy({
    changedFiles: ['src/value.ts', 'tests/value.test.ts', 'README.md'],
    allowedFiles: ['src/value.ts', 'tests/value.test.ts'],
    diff: [
      'diff --git a/tests/value.test.ts b/tests/value.test.ts',
      'deleted file mode 100644',
      '--- a/tests/value.test.ts',
      '+++ /dev/null',
      'diff --git a/src/value.ts b/src/value.ts',
      '+// eslint-disable-next-line',
      '+export const value = 2 as any;',
    ].join('\n'),
  });
  assert.equal(result.verdict, 'block');
  assert.ok(result.violations.some((violation) => violation.code === 'deleted_test'));
  assert.ok(result.violations.some((violation) => violation.code === 'disabled_check'));
  assert.ok(result.violations.some((violation) => violation.code === 'unrelated_file'));
});
