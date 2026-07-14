import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePipeline, RuntimeContextSchema } from '../app/lib/zenos-runtime';
import { createTokenBudgetPlan } from '../app/lib/token-economy';
import {
  authorizeTokenSpend,
  completeTokenBudget,
  resetTokenGovernorProcessCacheForTests,
  settleTokenSpend,
  tokenGovernorSnapshot,
} from '../app/lib/token-governor';
import { resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

function plan(id: string) {
  const context = RuntimeContextSchema.parse({
    request: 'audit a bounded critical deployment change',
    intent: 'execute',
    riskHint: 'critical',
    userRequestedVerification: true,
    userRequestedBoss: true,
    estimatedContextTokens: 8_000,
  });
  return createTokenBudgetPlan(choosePipeline(context), context, {
    userPriority: 'economy',
    budgetId: id,
  });
}

test('global governor reserves tokens atomically across parallel role calls', () => {
  const budget = plan('budget-parallel-reservation');
  const first = authorizeTokenSpend({
    plan: budget,
    requestId: 'worker-1',
    role: 'worker',
    estimatedTokens: Math.floor((budget.totalTokens - budget.reserveTokens) * 0.7),
  });
  assert.equal(first.allowed, true);

  const second = authorizeTokenSpend({
    plan: budget,
    requestId: 'verifier-1',
    role: 'verifier',
    estimatedTokens: Math.floor((budget.totalTokens - budget.reserveTokens) * 0.5),
  });
  assert.equal(second.allowed, false);

  const snapshot = tokenGovernorSnapshot(budget);
  assert.ok(snapshot.reservedTokens > 0);
  assert.ok(snapshot.remainingTokens < budget.totalTokens);
  completeTokenBudget(budget.budgetId);
});

test('optional calls preserve final-answer reserve while mandatory calls may consume it', () => {
  const budget = plan('budget-reserve-policy');
  const optional = authorizeTokenSpend({
    plan: budget,
    requestId: 'optional-boss',
    role: 'boss',
    estimatedTokens: budget.totalTokens - Math.floor(budget.reserveTokens / 2),
  });
  assert.equal(optional.allowed, false);

  const mandatory = authorizeTokenSpend({
    plan: budget,
    requestId: 'mandatory-host',
    role: 'host',
    estimatedTokens: budget.totalTokens - Math.floor(budget.reserveTokens / 2),
    mandatory: true,
  });
  assert.equal(mandatory.allowed, true);

  const settled = settleTokenSpend({
    plan: budget,
    requestId: 'mandatory-host',
    role: 'host',
    actualTokens: 1_000,
    attempted: true,
  });
  assert.equal(settled.calls, 1);
  assert.equal(settled.spentTokens, 1_000);
  completeTokenBudget(budget.budgetId);
});

test('Boss-requested Host revision may consume the final-answer reserve', () => {
  const budget = plan('budget-boss-revision-reserve');
  const optionalCeiling = budget.totalTokens - budget.reserveTokens;
  const prior = authorizeTokenSpend({
    plan: budget,
    requestId: 'prior-required-calls',
    role: 'host',
    estimatedTokens: optionalCeiling - 4_820,
    mandatory: true,
  });
  assert.equal(prior.allowed, true);
  settleTokenSpend({
    plan: budget,
    requestId: 'prior-required-calls',
    role: 'host',
    actualTokens: optionalCeiling - 4_820,
    attempted: true,
  });

  const optionalRevision = authorizeTokenSpend({
    plan: budget,
    requestId: 'boss-revision-optional',
    role: 'host',
    estimatedTokens: 4_884,
  });
  assert.equal(optionalRevision.allowed, false);
  assert.equal(optionalRevision.remainingTokens, 4_820);

  const requiredRevision = authorizeTokenSpend({
    plan: budget,
    requestId: 'boss-revision-required',
    role: 'host',
    estimatedTokens: 4_884,
    mandatory: true,
  });
  assert.equal(requiredRevision.allowed, true);
  settleTokenSpend({
    plan: budget,
    requestId: 'boss-revision-required',
    role: 'host',
    actualTokens: 4_000,
    attempted: true,
  });
  completeTokenBudget(budget.budgetId);
});

test('governor reservations and spend survive a process-cache reset', () => {
  resetRuntimeStoreForTests(':memory:');
  const budget = plan('budget-durable-process-restart');
  const authorization = authorizeTokenSpend({
    plan: budget,
    requestId: 'host-before-restart',
    role: 'host',
    estimatedTokens: 2_000,
    mandatory: true,
  });
  assert.equal(authorization.allowed, true);

  resetTokenGovernorProcessCacheForTests();
  const restored = tokenGovernorSnapshot(budget);
  assert.equal(restored.reservedTokens, 2_000);

  const settled = settleTokenSpend({
    plan: budget,
    requestId: 'host-before-restart',
    role: 'host',
    actualTokens: 1_500,
    attempted: true,
  });
  assert.equal(settled.reservedTokens, 0);
  assert.equal(settled.spentTokens, 1_500);
  completeTokenBudget(budget.budgetId);
});
