import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { prepareCodexExecution } from '../app/lib/codex-execution-core';
import {
  AutonomousModelInvoker,
  AutonomousModelResult,
  runAutonomousCodingLoop,
} from '../app/lib/autonomous-coding-loop';
import { ToolBroker, ToolEvidenceSchema } from '../app/lib/tool-broker';
import { resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-autonomous-loop-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
      typecheck: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
    },
  }));
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'value.test.ts'), "import { value } from '../src/value';\nvoid value;\n");
  return root;
}

function configureFixtureBoundary(root: string, context: TestContext): void {
  const originalMode = process.env.ZENOS_RUNTIME_EXECUTION_MODE;
  const originalRoots = process.env.ZENOS_RUNTIME_MUTATION_ROOTS;
  process.env.ZENOS_RUNTIME_EXECUTION_MODE = 'isolated-executor';
  process.env.ZENOS_RUNTIME_MUTATION_ROOTS = root;
  context.after(() => {
    if (originalMode === undefined) delete process.env.ZENOS_RUNTIME_EXECUTION_MODE;
    else process.env.ZENOS_RUNTIME_EXECUTION_MODE = originalMode;
    if (originalRoots === undefined) delete process.env.ZENOS_RUNTIME_MUTATION_ROOTS;
    else process.env.ZENOS_RUNTIME_MUTATION_ROOTS = originalRoots;
  });
}

function evidence(tool: string, status: 'success' | 'failed' | 'remote_required', summary: string, details: Record<string, unknown> = {}) {
  return ToolEvidenceSchema.parse({
    tool,
    status,
    summary,
    details,
    durationMs: 1,
    cacheable: status === 'success',
    evidence: true,
  });
}

function brokerForFixture(root: string, options: { failTargetedTest?: boolean } = {}): ToolBroker {
  const broker = new ToolBroker();
  broker.register({
    name: 'repo.read',
    description: 'fixture read',
    risk: 'read_only',
    inputSchema: z.object({ path: z.string() }).passthrough(),
    cacheable: true,
    producesEvidence: true,
    async execute(input) {
      const content = fs.readFileSync(path.join(root, input.path), 'utf8');
      return evidence('repo.read', 'success', `Read ${input.path}.`, {
        path: input.path,
        hash: hash(content),
        rawContent: content,
        content,
        startLine: 1,
        endLine: content.split('\n').length,
      });
    },
  });
  broker.register({
    name: 'repo.search',
    description: 'fixture search',
    risk: 'read_only',
    inputSchema: z.object({ query: z.string() }).passthrough(),
    cacheable: true,
    producesEvidence: true,
    async execute(input) {
      return evidence('repo.search', 'success', `Searched ${input.query}.`, { matches: [] });
    },
  });
  broker.register({
    name: 'repo.patch',
    description: 'fixture patch',
    risk: 'write_local',
    inputSchema: z.object({
      path: z.string(),
      expectedHash: z.string().optional(),
      replacements: z.array(z.object({ oldText: z.string(), newText: z.string() })),
    }).passthrough(),
    cacheable: false,
    producesEvidence: true,
    async execute(input) {
      const target = path.join(root, input.path);
      const original = fs.readFileSync(target, 'utf8');
      assert.equal(input.expectedHash, hash(original));
      let updated = original;
      for (const replacement of input.replacements) {
        assert.equal(updated.split(replacement.oldText).length - 1, 1);
        updated = updated.replace(replacement.oldText, replacement.newText);
      }
      fs.writeFileSync(target, updated);
      return evidence('repo.patch', 'success', `Patched ${input.path}.`, {
        path: input.path,
        changed: updated !== original,
        originalHash: hash(original),
        updatedHash: hash(updated),
      });
    },
  });
  for (const name of ['test.run', 'typecheck.run', 'lint.run'] as const) {
    broker.register({
      name,
      description: `fixture ${name}`,
      risk: 'read_only',
      inputSchema: z.record(z.string(), z.unknown()),
      cacheable: true,
      producesEvidence: true,
      async execute() {
        if (name === 'test.run' && options.failTargetedTest) return evidence(name, 'failed', `${name} failed.`, { stderr: 'fixture failure' });
        return evidence(name, 'success', `${name} passed.`);
      },
    });
  }
  broker.register({
    name: 'build.run',
    description: 'fixture remote build',
    risk: 'write_local',
    inputSchema: z.record(z.string(), z.unknown()),
    cacheable: false,
    producesEvidence: true,
    remotePreferred: true,
    async execute() {
      return evidence('build.run', 'remote_required', 'Full build requires GitHub Actions.');
    },
  });
  return broker;
}

function modelResult(parsed: unknown, requestId: string): AutonomousModelResult {
  return {
    ok: true,
    role: 'worker',
    model: 'worker-test',
    provider: 'test',
    parsed,
    content: JSON.stringify(parsed),
    usage: {
      inputTokens: 40,
      outputTokens: 20,
      totalTokens: 60,
      accountedTokens: 60,
      estimated: false,
      source: 'provider',
      valid: true,
    },
    inputTokensEstimate: 40,
    outputTokensEstimate: 20,
    latencyMs: 1,
    attempts: 1,
    requestId,
  };
}

function invokerForFixture(root: string): AutonomousModelInvoker {
  return async (input) => {
    if (input.stage === 'plan') {
      return modelResult({
        summary: 'Change the exported value with the smallest patch.',
        filesToInspect: ['src/value.ts', 'tests/value.test.ts'],
        searchQueries: ['value'],
        plannedChanges: [{ path: 'src/value.ts', rationale: 'Requested behavior change.' }],
        validationFocus: ['related test', 'typecheck'],
        assumptions: [],
      }, input.requestId);
    }
    const current = fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf8');
    return modelResult({
      summary: 'Update value from 1 to 2.',
      patches: [{
        path: 'src/value.ts',
        expectedHash: hash(current),
        replacements: [{ oldText: 'export const value = 1;', newText: 'export const value = 2;' }],
      }],
      assumptions: [],
    }, input.requestId);
  };
}

test('autonomous coding loop plans, patches, validates, and stops at remote build boundary', async (context) => {
  const root = createFixture();
  configureFixtureBoundary(root, context);
  resetRuntimeStoreForTests(':memory:');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareCodexExecution({
    taskId: 'autonomous-patch-task',
    request: 'change src/value.ts from 1 to 2 and validate it',
    workspaceRoot: root,
  });

  const outcome = await runAutonomousCodingLoop({
    prepared,
    invokeModel: invokerForFixture(root),
    approvalGranted: true,
    maxRevisions: 1,
    broker: brokerForFixture(root),
    requestIdPrefix: 'run-test',
  });

  assert.equal(outcome.status, 'remote_required', JSON.stringify(outcome, null, 2));
  assert.equal(fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.ok(outcome.task.filesChanged.includes('src/value.ts'));
  assert.ok(outcome.toolEvidence.some((item) => item.tool === 'repo.patch' && item.status === 'success'));
  assert.ok(outcome.toolEvidence.some((item) => item.tool === 'build.run' && item.status === 'remote_required'));
  assert.equal(outcome.modelCalls.length, 2);
  assert.equal(outcome.task.tokenUsage.input, 80);
  assert.equal(outcome.task.tokenUsage.output, 40);
  assert.match(outcome.summary, /remote validation/i);
});

test('autonomous coding loop rolls back a patch when validation exhausts its revision budget', async (context) => {
  const root = createFixture();
  configureFixtureBoundary(root, context);
  resetRuntimeStoreForTests(':memory:');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareCodexExecution({
    taskId: 'autonomous-rollback-task',
    request: 'change src/value.ts from 1 to 2 and validate it',
    workspaceRoot: root,
  });

  const outcome = await runAutonomousCodingLoop({
    prepared,
    invokeModel: invokerForFixture(root),
    approvalGranted: true,
    maxRevisions: 0,
    broker: brokerForFixture(root, { failTargetedTest: true }),
    requestIdPrefix: 'run-rollback',
  });

  assert.equal(outcome.status, 'validation_failed', JSON.stringify(outcome, null, 2));
  assert.equal(fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
  assert.match(outcome.summary, /checkpoint was restored/i);
  assert.ok(outcome.hostUpdates.some((item) => /rolled back/i.test(item)));
});

test('autonomous coding loop inspects but never patches without approval', async (context) => {
  const root = createFixture();
  configureFixtureBoundary(root, context);
  resetRuntimeStoreForTests(':memory:');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareCodexExecution({
    taskId: 'autonomous-plan-task',
    request: 'change src/value.ts from 1 to 2',
    workspaceRoot: root,
  });

  const outcome = await runAutonomousCodingLoop({
    prepared,
    invokeModel: invokerForFixture(root),
    approvalGranted: false,
    broker: brokerForFixture(root),
    requestIdPrefix: 'run-plan-only',
  });

  assert.equal(outcome.status, 'planned');
  assert.equal(outcome.modelCalls.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(outcome.toolEvidence.some((item) => item.tool === 'repo.patch'), false);
  assert.match(outcome.summary, /approval/i);
});
