import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePipeline, RuntimeContextSchema } from '../app/lib/zenos-runtime';
import { createTokenBudgetPlan, estimateTokenCount } from '../app/lib/token-economy';
import { compileRuntimeContext, renderRolePacket } from '../app/lib/runtime-context-compiler';
import { SkillRegistry, createDefaultSkillRegistry } from '../app/lib/skill-registry';
import { ToolBroker, ToolEvidenceSchema } from '../app/lib/tool-broker';
import { z } from 'zod';

test('token economy keeps Boss bounded and allocates cheap work first', () => {
  const context = RuntimeContextSchema.parse({
    request: 'fix the TypeScript auth bug and run tests',
    intent: 'execute',
    risk: 'medium',
    estimatedContextTokens: 8_000,
    hasRepositoryContext: true,
  });
  const decision = choosePipeline(context);
  const budget = createTokenBudgetPlan(decision, context);
  assert.ok(budget.worker.maxCalls >= 1);
  assert.ok(budget.boss.inputTokens <= 1_500);
  assert.ok(budget.boss.outputTokens <= 500);
  assert.ok(budget.worker.inputTokens > budget.boss.inputTokens);
});

test('context compiler reduces raw context and emits role-specific packets', () => {
  const context = RuntimeContextSchema.parse({
    request: 'fix the TypeScript auth bug',
    intent: 'execute',
    risk: 'medium',
    estimatedContextTokens: 10_000,
    hasRepositoryContext: true,
  });
  const decision = choosePipeline(context);
  const packet = compileRuntimeContext({
    request: context.request,
    decision,
    targetRole: 'worker',
    tokenBudget: 1_200,
    sourceContext: Array.from({ length: 80 }, (_, index) => `app/lib/auth.ts:${index + 1} token expiry check evidence ${index}`).join('\n'),
    toolContext: 'typecheck failed at app/lib/auth.ts:128 with TS2339',
    validationResults: ['auth tests must pass'],
    selectedProcedure: ['Inspect token parsing', 'Patch the smallest affected branch'],
  });
  const rendered = renderRolePacket(packet);
  assert.equal(packet.targetRole, 'worker');
  assert.ok(packet.verifiedFacts.length > 0);
  assert.ok(packet.contextReduction.compiledTokens <= 1_200);
  assert.ok(estimateTokenCount(rendered) <= 1_500);
  assert.match(rendered, /acceptanceCriteria/);
});

test('default skill registry selects bounded relevant skills', () => {
  const registry = createDefaultSkillRegistry();
  const selections = registry.select({
    request: 'typecheck fails with a TypeScript error in auth.ts',
    taskType: 'debugging',
    role: 'worker',
  });
  assert.equal(selections[0]?.skill.id, 'fix-typescript-bug');
  assert.ok(selections.length <= 3);
});

test('skill registry replaces versions by stable id', () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'sample-skill', version: '1', title: 'Sample', description: 'Sample skill', taskTypes: ['simple_chat'],
    triggers: ['sample'], steps: ['Do it'], acceptanceCriteria: ['Done'], compatibleRoles: ['worker'],
  });
  registry.register({
    id: 'sample-skill', version: '2', title: 'Sample v2', description: 'Updated sample skill', taskTypes: ['simple_chat'],
    triggers: ['sample'], steps: ['Do it better'], acceptanceCriteria: ['Done'], compatibleRoles: ['worker'],
  });
  assert.equal(registry.get('sample-skill')?.version, '2');
});

test('tool broker blocks risky tools without approval and normalizes evidence', async () => {
  const broker = new ToolBroker();
  broker.register({
    name: 'production.deploy',
    description: 'test production tool',
    risk: 'production',
    inputSchema: z.object({ target: z.string() }),
    cacheable: false,
    producesEvidence: true,
    async execute() {
      return ToolEvidenceSchema.parse({
        tool: 'production.deploy', status: 'success', summary: 'deployed', details: {}, durationMs: 1, cacheable: false, evidence: true,
      });
    },
  });
  const blocked = await broker.execute('production.deploy', { target: 'prod' }, {
    cwd: process.cwd(), approvalGranted: false, allowProduction: false,
  });
  assert.equal(blocked.status, 'blocked');
});
