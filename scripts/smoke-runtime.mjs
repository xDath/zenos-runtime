#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

process.env.ZENOS_RUNTIME_DISABLE_MEMORY = 'true';
process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = 'true';
process.env.ZENOS_RUNTIME_DB_PATH = ':memory:';

const runtimeModule = await import(pathToFileURL(resolve('app/lib/zenos-runtime.ts')).href);
const stateModule = await import(pathToFileURL(resolve('app/lib/zenos-runtime-three-agent.ts')).href);
const executorModule = await import(pathToFileURL(resolve('app/lib/zenos-runtime-executor.ts')).href);
const storeModule = await import(pathToFileURL(resolve('app/lib/zenos-runtime-store.ts')).href);

const {
  choosePipeline,
  runRuntimeEval,
  validateWorkerResult,
  validateVerifierResult,
} = runtimeModule;
const {
  createRuntimeSession,
  dispatchWorker,
  recordWorkerEvent,
  runQualityGate,
  buildEscalationPacket,
  applyBossDecision,
  completeRuntimeSession,
  runtimeStoreInfo,
} = stateModule;
const { runZenosPipeline, getRuntimeModelConfigSummary } = executorModule;
const { resetRuntimeStoreForTests } = storeModule;

resetRuntimeStoreForTests(':memory:');

const report = runRuntimeEval();
assert.equal(report.status, 'pass');
assert.ok(report.total >= 20);

const explanation = choosePipeline({ request: 'jelaskan arsitektur deployment production', intent: 'explain' });
assert.notEqual(explanation.risk, 'critical');
assert.equal(explanation.requiresApproval, false);

const execution = choosePipeline({ request: 'deploy ke production sekarang', intent: 'execute' });
assert.equal(execution.risk, 'critical');
assert.equal(execution.useBoss, true);
assert.equal(execution.requiresApproval, true);

validateWorkerResult({
  task: 'inspect auth bug',
  summary: ['Expiry validation requires review.'],
  findings: [{ claim: 'Expiry comparison is suspect.', evidence: ['src/auth.ts:42'], confidence: 0.9, risk: 'medium' }],
  contradictions: [],
  unknowns: [],
  suggestedNextStep: 'Inspect the cited source and run tests.',
  needsHostAttention: ['expiry semantics'],
  rawContextNeeded: [],
  sourceCoverage: 0.9,
});

validateVerifierResult({
  verdict: 'pass',
  confidence: 0.95,
  issues: [],
  checks: {
    followsUserRequest: 'pass',
    sourceGrounded: 'pass',
    secretSafe: 'pass',
    actionSafe: 'pass',
    testsOrValidation: 'pass',
  },
  nextAction: 'answer',
});

const session = createRuntimeSession({ request: 'fix bug besar di repo', hasFiles: true, hasCodeChangeIntent: true, intent: 'mutate' });
const queued = dispatchWorker(session.sessionId, 'coding_brief', 'Inspect files and return evidence.');
assert.equal(queued.workers[0].status, 'queued');
const paused = recordWorkerEvent({
  sessionId: session.sessionId,
  workerId: queued.workers[0].workerId,
  type: 'risk',
  summary: 'Found destructive reset command.',
  evidence: ['scripts/deploy.sh:31'],
  severity: 'high',
  confidence: 0.95,
  needsBoss: true,
});
assert.equal(paused.status, 'paused');
assert.equal(paused.workers[0].status, 'paused');

const gate = runQualityGate({
  findings: [
    { claim: 'Supported', evidence: ['file.ts:1'], confidence: 0.9, risk: 'low' },
    { claim: 'Unsupported risky', evidence: [], confidence: 0.4, risk: 'high' },
  ],
  events: paused.events,
});
assert.equal(gate.verdict, 'escalate');

const packet = buildEscalationPacket(session.sessionId, 'Host found a high-risk worker event.');
assert.equal(packet.sessionId, session.sessionId);
const bossApplied = applyBossDecision(session.sessionId, {
  verdict: 'revise',
  confidence: 0.9,
  reasoningSummary: 'Replace destructive action with read-only inspection.',
  requiredChanges: ['Remove reset command'],
  allowedActions: ['read files', 'run tests'],
  forbiddenActions: ['git reset --hard'],
});
assert.equal(bossApplied.status, 'revising');
assert.equal(completeRuntimeSession(session.sessionId, 'Safe answer.').status, 'done');

const dryRun = await runZenosPipeline({
  request: 'summarize dokumen besar ini',
  context: 'x'.repeat(20_000),
  estimatedContextTokens: 8_000,
  dryRun: true,
  persistSession: false,
  persistRouteEvent: false,
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.status, 'dry_run');
assert.equal(dryRun.decision.useWorker, true);

const store = runtimeStoreInfo();
assert.equal(store.ok, true);
assert.equal(store.integrity, 'ok');
assert.equal(store.engine, 'sqlite-wal');

const models = getRuntimeModelConfigSummary();
assert.ok(models.hostModel, 'Host model must resolve');
assert.ok(models.workerModel, 'Worker model must resolve');
assert.ok(models.bossModel, 'Boss model must resolve');
assert.ok(models.verifierModel, 'Verifier model must resolve');

console.log(`Zenos Runtime v0.4 smoke passed: ${report.total} routing cases, SQLite WAL state, non-root control-plane boundary, latency budgets, Outcome Passports, Memory continuity, dry-run pipeline, and four role model slots.`);
