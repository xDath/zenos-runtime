#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const runtimePath = pathToFileURL(resolve('app/lib/zenos-runtime.ts')).href;
const executorPath = pathToFileURL(resolve('app/lib/zenos-runtime-executor.ts')).href;
const threeAgentPath = pathToFileURL(resolve('app/lib/zenos-runtime-three-agent.ts')).href;
const {
  choosePipeline,
  buildRouteEvent,
  validateWorkerResult,
  validateVerifierResult,
  runRuntimeEval,
  runtimeReadinessReport,
  routeEventMemoryContent,
} = await import(runtimePath);
const executorModule = await import(executorPath);
const { runZenosPipeline, getRuntimeModelConfigSummary } = executorModule.default || executorModule;
const {
  createRuntimeSession,
  dispatchWorker,
  recordWorkerEvent,
  runQualityGate,
  buildEscalationPacket,
  applyBossDecision,
  getRuntimeModels,
} = await import(threeAgentPath);

const cases = [
  {
    name: 'simple chat stays fast',
    input: { request: 'jelasin singkat bedanya host sama worker' },
    expect: { taskType: 'simple_chat', pipelineMode: 'direct_fast_path', useWorker: false, useVerifier: false },
  },
  {
    name: 'memory question recalls memory',
    input: { request: 'tadi roadmap Zenos Runtime isinya apa?' },
    expect: { taskType: 'memory_question', useMemory: true },
  },
  {
    name: 'large summarize uses cheap worker',
    input: { request: 'summarize log panjang ini', estimatedContextTokens: 9000 },
    expect: { taskType: 'summarization', pipelineMode: 'worker_compression_path', useWorker: true },
  },
  {
    name: 'coding change uses source tools and premium host',
    input: { request: 'fix bug di repo ini', hasFiles: true, hasCodeChangeIntent: true },
    expect: { taskType: 'coding_change', useTools: true, useMemory: true, hostTier: 'premium' },
  },
  {
    name: 'secret work is verified',
    input: { request: 'cek apakah ada secret leak di auth token', hasFiles: true },
    expect: { taskType: 'security_or_secret', useVerifier: true, hostTier: 'premium' },
  },
  {
    name: 'deploy work escalates',
    input: { request: 'deploy production sekarang', confidence: 0.9 },
    expect: { taskType: 'deploy_or_destructive_action', pipelineMode: 'escalated_deep_path', verifierTier: 'premium' },
  },
];

for (const testCase of cases) {
  const decision = choosePipeline(testCase.input);
  for (const [key, value] of Object.entries(testCase.expect)) {
    assert.equal(decision[key], value, `${testCase.name}: expected ${key}=${value}, got ${decision[key]}`);
  }
  const event = buildRouteEvent(decision, testCase.input);
  assert.equal(event.taskType, decision.taskType);
}

validateWorkerResult({
  task: 'inspect auth bug',
  summary: ['Likely failure is in session expiry handling.'],
  findings: [
    {
      claim: 'Expiry comparison needs focused host review.',
      evidence: ['src/auth/session.ts:42'],
      confidence: 0.78,
      risk: 'medium',
    },
  ],
  suggestedNextStep: 'Host should inspect cited line before patching.',
  needsHostAttention: ['time comparison semantics'],
  rawContextNeeded: ['src/auth/session.ts:42'],
});

validateVerifierResult({
  verdict: 'revise',
  confidence: 0.82,
  issues: [
    {
      severity: 'medium',
      issue: 'No validation command was reported for the code change.',
      evidence: 'missing test result',
      requiredFix: 'Run or explain tests before final answer.',
    },
  ],
  checks: {
    followsUserRequest: 'pass',
    sourceGrounded: 'pass',
    secretSafe: 'pass',
    actionSafe: 'not_applicable',
    testsOrValidation: 'fail',
  },
  nextAction: 'revise',
});

const report = runRuntimeEval();
assert.equal(report.status, 'pass');
assert.equal(report.failed, 0);

const memoryLine = routeEventMemoryContent(buildRouteEvent(choosePipeline(cases[0].input), cases[0].input));
assert.match(memoryLine, /Zenos Runtime route event/);

const readiness = runtimeReadinessReport();
assert.equal(readiness.status, 'production_ready_v1');

const dryRun = await runZenosPipeline({
  request: 'summarize dokumen besar ini supaya host hemat token',
  context: 'x'.repeat(12000),
  estimatedContextTokens: 9000,
  dryRun: true,
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.decision.useWorker, true);

const session = createRuntimeSession({
  request: 'fix bug besar di repo dan awasi worker kalau ada hal rancu',
  hasFiles: true,
  hasCodeChangeIntent: true,
  estimatedContextTokens: 12000,
});
assert.equal(session.status, 'working');

const withWorker = dispatchWorker(session.sessionId, 'coding_brief', 'Inspect affected files and produce evidence-backed change map.');
const workerId = withWorker.workers[0].workerId;
assert.equal(withWorker.workers[0].status, 'running');

const withEvent = recordWorkerEvent({
  sessionId: session.sessionId,
  workerId,
  type: 'risk',
  summary: 'Worker found a destructive reset command in proposed workflow.',
  evidence: ['scripts/deploy.sh:31'],
  severity: 'high',
  confidence: 0.91,
  needsBoss: true,
});
assert.equal(withEvent.status, 'paused');
assert.equal(withEvent.workers[0].status, 'paused');

const gate = runQualityGate({
  findings: [
    { claim: 'Supported fact', evidence: ['file.ts:1'], confidence: 0.9, risk: 'low' },
    { claim: 'Unsupported risky claim', evidence: [], confidence: 0.4, risk: 'high' },
  ],
  events: withEvent.events,
});
assert.equal(gate.needsBoss, true);
assert.equal(gate.verdict, 'escalate');
assert.equal(gate.usableFindings.length, 1);
assert.equal(gate.discardedFindings.length, 1);

const packet = buildEscalationPacket(session.sessionId, 'Host detected high-severity worker event.');
assert.equal(packet.sessionId, session.sessionId);
assert.equal(packet.triggeringEvents.length, 1);

const afterBoss = applyBossDecision(session.sessionId, {
  verdict: 'revise',
  confidence: 0.88,
  reasoningSummary: 'Do not run destructive reset; revise plan with safe inspection commands.',
  requiredChanges: ['Remove reset command', 'Run read-only inspection first'],
  allowedActions: ['read files', 'run tests'],
  forbiddenActions: ['git reset --hard'],
});
assert.equal(afterBoss.status, 'working');

const runtimeModels = getRuntimeModels();
assert.equal(runtimeModels.roles.length, 3);
assert.ok(runtimeModels.workerTemplates.coding_brief);

const modelSummary = getRuntimeModelConfigSummary();
assert.ok(modelSummary.hostModel, 'host model should resolve from env or Hermes config');
assert.ok(modelSummary.workerModel, 'worker model should resolve from env, override, or Hermes config');

console.log(`Zenos Runtime smoke passed (${cases.length} route cases + three-agent supervision + quality gate + eval + readiness + dry-run pipeline + Hermes model config).`);
