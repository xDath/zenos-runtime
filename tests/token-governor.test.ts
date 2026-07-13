import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePipeline, RuntimeContextSchema } from '../app/lib/zenos-runtime';
import { createTokenBudgetPlan } from '../app/lib/token-economy';
import {
  authorizeTokenSpend,
  completeTokenBudget,
  settleTokenSpend,
  tokenGovernorSnapshot,
} from '../app/lib/token-governor';

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
