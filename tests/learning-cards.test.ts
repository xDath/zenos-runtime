import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LearningCardSchema,
  buildRuntimeLearningCard,
  buildVerifiedLearningCard,
  renderLearningCard,
} from '../app/lib/learning-cards';

test('validated Runtime outcomes become evidence-backed procedure cards', () => {
  const card = buildRuntimeLearningCard({
    runId: 'run-success',
    objective: 'Fix the continuity coordinator.',
    taskType: 'coding_change',
    verdict: 'success',
    deterministicValidation: 'passed',
    toolSummary: 'npm test passed and app/lib/gateway-continuity.ts changed.',
    artifacts: ['app/lib/gateway-continuity.ts'],
    validFrom: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(card.type, 'procedure');
  assert.equal(card.verification, 'test_passed');
  assert.equal(card.confidence, 0.94);
  assert.ok(card.evidence.some((item) => item.source === 'test'));
  assert.ok(card.evidence.some((item) => item.source === 'tool'));
  assert.match(renderLearningCard(card), /test_passed/);
  assert.deepEqual(LearningCardSchema.parse(card), card);
});

test('observed failures become failure cards and unverified prose stays low confidence', () => {
  const failure = buildRuntimeLearningCard({
    runId: 'run-failed',
    objective: 'Deploy the Runtime release.',
    taskType: 'deploy_or_destructive_action',
    verdict: 'failed',
    deterministicValidation: 'failed',
    failures: ['Typecheck failed before activation.'],
    toolSummary: 'tsc returned exit code 2.',
    validFrom: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(failure.type, 'failure');
  assert.equal(failure.verification, 'tool_observed');
  assert.equal(failure.confidence, 0.82);

  const unverified = buildRuntimeLearningCard({
    runId: 'run-unknown',
    objective: 'Consider a possible architecture change.',
    taskType: 'planning_or_architecture',
    verdict: 'revised',
    deterministicValidation: 'unknown',
    validFrom: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(unverified.type, 'project_state');
  assert.equal(unverified.verification, 'unverified');
  assert.equal(unverified.confidence, 0.45);
});

test('explicit preference and decision cards require durable evidence and correct verification', () => {
  const preference = buildVerifiedLearningCard({
    type: 'preference',
    claim: 'The user prefers concise technical progress updates.',
    verification: 'user_confirmed',
    evidence: [{ source: 'user', ref: 'session:abc:message:42' }],
    validFrom: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(preference.type, 'preference');
  assert.equal(preference.verification, 'user_confirmed');
  assert.equal(preference.confidence, 0.98);

  const decision = buildVerifiedLearningCard({
    type: 'decision',
    claim: 'Runtime is the only checkpoint authority.',
    verification: 'tool_observed',
    evidence: [{ source: 'runtime', ref: 'runtime-run:checkpoint-coordinator' }],
    supersedes: ['legacy-double-compact-decision'],
    validFrom: '2026-07-21T00:00:01.000Z',
  });
  assert.equal(decision.type, 'decision');
  assert.deepEqual(decision.supersedes, ['legacy-double-compact-decision']);
  assert.throws(() => buildVerifiedLearningCard({
    type: 'preference',
    claim: 'Inferred preference without confirmation.',
    verification: 'tool_observed',
    evidence: [{ source: 'tool', ref: 'tool:guess' }],
  }), /user confirmation/i);
  assert.throws(() => buildVerifiedLearningCard({
    type: 'procedure',
    claim: 'Untested procedure.',
    verification: 'tool_observed',
    evidence: [{ source: 'tool', ref: 'tool:run' }],
  }), /deterministic test/i);
});
