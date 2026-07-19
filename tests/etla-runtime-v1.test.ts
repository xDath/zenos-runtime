import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePipeline, RuntimeContextSchema } from '../app/lib/zenos-runtime';
import {
  createTokenBudgetPlan,
  estimateModelInputTokens,
  estimateTokenCount,
  recordTokenEstimateCalibration,
  resetTokenEstimatorForTests,
  tokenEstimatorSnapshot,
  truncateToTokenBudget,
} from '../app/lib/token-economy';
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
  assert.ok(budget.boss.outputTokens >= 900);
  assert.ok(budget.worker.outputTokens >= 1_600);
  assert.ok(budget.verifier.outputTokens >= 1_200);
  assert.ok(budget.host.outputTokens >= 1_600);
  assert.ok(budget.host.maxCalls >= 12);
  assert.ok(budget.worker.inputTokens > budget.boss.inputTokens);
});

test('host autonomy ceiling follows task complexity without forcing extra calls', () => {
  const chatContext = RuntimeContextSchema.parse({
    request: 'jelasin singkat status service',
    intent: 'explain',
  });
  const codingContext = RuntimeContextSchema.parse({
    request: 'fix the TypeScript auth bug and run tests',
    intent: 'execute',
    hasCodeChangeIntent: true,
    estimatedContextTokens: 8_000,
  });

  const chat = createTokenBudgetPlan(choosePipeline(chatContext), chatContext);
  const coding = createTokenBudgetPlan(choosePipeline(codingContext), codingContext);

  assert.ok(chat.host.maxCalls >= 2);
  assert.ok(coding.host.maxCalls >= 12);
  assert.ok(coding.host.maxCalls > chat.host.maxCalls);
  assert.ok(coding.host.maxCalls <= 32);
});

test('token estimator calibrates from provider usage without changing the public budget contract', () => {
  resetTokenEstimatorForTests();
  const sample = 'calibration sample '.repeat(300);
  const before = estimateTokenCount(sample);
  recordTokenEstimateCalibration(1_000, 1_300);
  const snapshot = tokenEstimatorSnapshot();
  const after = estimateTokenCount(sample);

  assert.equal(snapshot.samples, 1);
  assert.ok(snapshot.scale > 1);
  assert.ok(after > before);
  resetTokenEstimatorForTests();
});

test('model input estimator accounts for persistent provider framing separately from text size', () => {
  resetTokenEstimatorForTests();
  const prompt = 'bounded verifier prompt '.repeat(120);
  const visible = estimateTokenCount(prompt, 'ag/gemini-3.5-flash-low');
  const before = estimateModelInputTokens(prompt, 'ag/gemini-3.5-flash-low');
  assert.ok(before >= visible + 2_400);

  recordTokenEstimateCalibration(before, before + 1_000, 'ag/gemini-3.5-flash-low');
  const after = estimateModelInputTokens(prompt, 'ag/gemini-3.5-flash-low');
  const snapshot = tokenEstimatorSnapshot('ag/gemini-3.5-flash-low');
  assert.ok(snapshot.overheadTokens > 2_400);
  assert.ok(after > before);
  resetTokenEstimatorForTests();
});

test('context truncation preserves high-signal middle evidence instead of blind head-tail slicing', () => {
  const source = [
    `Background context ${'ordinary '.repeat(500)}`,
    `Historical notes ${'low-signal '.repeat(500)}`,
    'MUST preserve the database transaction boundary because the prior deployment failed this acceptance test.',
    `Additional discussion ${'routine '.repeat(500)}`,
    'Final instruction: verify the regression test before claiming success.',
  ].join('\n\n');
  const truncated = truncateToTokenBudget(source, 260);

  assert.ok(estimateTokenCount(truncated) <= 260);
  assert.match(truncated, /MUST preserve the database transaction boundary/);
  assert.match(truncated, /verify the regression test/);
});

test('concise response preferences do not override the actual task classification', () => {
  const decision = choosePipeline({
    request: 'Aku ingin hasil yang ringkas dan tepat. review source code ini',
    hasFiles: true,
    containsUntrustedInput: true,
  });
  assert.equal(decision.taskType, 'repo_question');
  assert.equal(decision.risk, 'high');
  assert.equal(decision.useVerifier, true);
});

test('direct Host-only chat reserves framing headroom instead of denying the first model call', () => {
  const context = RuntimeContextSchema.parse({
    request: 'Reply exactly RUNTIME_GROK_OK',
    intent: 'analyze',
    estimatedContextTokens: 32,
  });
  const decision = choosePipeline(context);
  const budget = createTokenBudgetPlan(decision, context);

  assert.equal(decision.useWorker, false);
  assert.equal(decision.useVerifier, false);
  assert.equal(decision.useBoss, false);
  assert.ok(budget.totalTokens >= 9_000);
  assert.ok(budget.totalTokens >= budget.host.inputTokens + budget.host.outputTokens + 2_000);
});

test('four-role orchestration reserves enough structured output budget to avoid truncated contracts', () => {
  const context = RuntimeContextSchema.parse({
    request: 'analyze this bounded source-code readiness evidence',
    intent: 'analyze',
    hasFiles: true,
    estimatedContextTokens: 8_000,
    userRequestedVerification: true,
    userRequestedBoss: true,
  });
  const decision = choosePipeline(context);
  const budget = createTokenBudgetPlan(decision, context);

  assert.equal(decision.useWorker, true);
  assert.equal(decision.useVerifier, true);
  assert.equal(decision.useBoss, true);
  assert.ok(budget.totalTokens >= 32_000);
  assert.ok(budget.worker.outputTokens >= 1_600);
  assert.ok(budget.verifier.outputTokens >= 2_200);
  assert.ok(budget.boss.outputTokens >= 1_800);
});

test('mandatory verifier and Boss remain executable after Host usage without forcing Worker', () => {
  const context = RuntimeContextSchema.parse({
    request: 'review this bounded readiness statement and ask the Boss for a final verdict',
    intent: 'analyze',
    estimatedContextTokens: 8_000,
    userRequestedVerification: true,
    userRequestedBoss: true,
  });
  const decision = choosePipeline(context);
  const budget = createTokenBudgetPlan(decision, context);

  assert.equal(decision.useWorker, false);
  assert.equal(decision.useVerifier, true);
  assert.equal(decision.useBoss, true);
  assert.ok(budget.totalTokens >= 24_000);
  assert.ok(budget.verifier.outputTokens >= 2_200);
  assert.ok(budget.boss.outputTokens >= 1_800);
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

test('context compiler collapses semantically identical source and Worker evidence', () => {
  const context = RuntimeContextSchema.parse({
    request: 'review the production readiness evidence',
    intent: 'analyze',
    estimatedContextTokens: 2_000,
  });
  const decision = choosePipeline(context);
  const packet = compileRuntimeContext({
    request: context.request,
    decision,
    targetRole: 'host',
    tokenBudget: 1_500,
    sourceContext: 'Evidence A: the service is loopback-only and runs as a non-root identity.',
    workerResult: {
      task: context.request,
      summary: [],
      findings: [{
        claim: 'the service is loopback-only and runs as a non-root identity.',
        evidence: ['source-context'],
        confidence: 0.8,
        risk: 'low',
      }],
      contradictions: [],
      unknowns: [],
      suggestedNextStep: 'continue',
      needsHostAttention: [],
      rawContextNeeded: [],
      sourceCoverage: 1,
    },
  });
  const matching = packet.verifiedFacts.filter((item) => item.claim.includes('loopback-only'));
  assert.equal(matching.length, 1);
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
