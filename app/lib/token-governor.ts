import { incrementMetric, setGauge } from './metrics';
import type { RuntimeRole, TokenBudgetPlan } from './token-economy';

export type TokenGovernorSnapshot = {
  budgetId: string;
  limitTokens: number;
  reserveTokens: number;
  spentTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  calls: number;
};

type GovernorState = {
  limitTokens: number;
  reserveTokens: number;
  spentTokens: number;
  calls: number;
  updatedAt: number;
  reservations: Map<string, number>;
};

const governors = new Map<string, GovernorState>();
const STATE_TTL_MS = 60 * 60 * 1_000;

function cleanup(now = Date.now()): void {
  for (const [id, state] of governors) {
    if (now - state.updatedAt > STATE_TTL_MS) governors.delete(id);
  }
}

function stateFor(plan: TokenBudgetPlan): GovernorState {
  cleanup();
  const current = governors.get(plan.budgetId);
  if (current) {
    current.limitTokens = Math.max(current.limitTokens, plan.totalTokens);
    current.reserveTokens = Math.max(current.reserveTokens, plan.reserveTokens);
    current.updatedAt = Date.now();
    return current;
  }
  const created: GovernorState = {
    limitTokens: plan.totalTokens,
    reserveTokens: plan.reserveTokens,
    spentTokens: 0,
    calls: 0,
    updatedAt: Date.now(),
    reservations: new Map(),
  };
  governors.set(plan.budgetId, created);
  return created;
}

function reservedTotal(state: GovernorState): number {
  return [...state.reservations.values()].reduce((sum, value) => sum + value, 0);
}

export function authorizeTokenSpend(input: {
  plan: TokenBudgetPlan;
  requestId: string;
  role: RuntimeRole;
  estimatedTokens: number;
  mandatory?: boolean;
}): { allowed: boolean; reason?: string; remainingTokens: number } {
  const state = stateFor(input.plan);
  const estimate = Math.max(1, Math.round(input.estimatedTokens));
  const reserved = reservedTotal(state);
  const ceiling = input.mandatory
    ? state.limitTokens
    : Math.max(0, state.limitTokens - state.reserveTokens);
  const remainingTokens = Math.max(0, ceiling - state.spentTokens - reserved);
  if (estimate > remainingTokens) {
    incrementMetric('runtime_token_governor_denied_total', {
      role: input.role,
      mandatory: String(Boolean(input.mandatory)),
    });
    return {
      allowed: false,
      reason: `Global token budget exhausted: need ${estimate}, remaining ${remainingTokens}`,
      remainingTokens,
    };
  }
  state.reservations.set(input.requestId, estimate);
  state.updatedAt = Date.now();
  setGauge('runtime_token_governor_remaining_tokens', remainingTokens - estimate, {
    budget: input.plan.budgetId,
  });
  return { allowed: true, remainingTokens: remainingTokens - estimate };
}

export function settleTokenSpend(input: {
  plan: TokenBudgetPlan;
  requestId: string;
  role: RuntimeRole;
  actualTokens: number;
  attempted: boolean;
}): TokenGovernorSnapshot {
  const state = stateFor(input.plan);
  state.reservations.delete(input.requestId);
  if (input.attempted) {
    const actual = Math.max(0, Math.round(input.actualTokens));
    state.spentTokens += actual;
    state.calls += 1;
    incrementMetric('runtime_token_governor_spent_total', { role: input.role }, actual);
  }
  state.updatedAt = Date.now();
  return tokenGovernorSnapshot(input.plan);
}

export function tokenGovernorSnapshot(plan: TokenBudgetPlan): TokenGovernorSnapshot {
  const state = stateFor(plan);
  const reserved = reservedTotal(state);
  return {
    budgetId: plan.budgetId,
    limitTokens: state.limitTokens,
    reserveTokens: state.reserveTokens,
    spentTokens: state.spentTokens,
    reservedTokens: reserved,
    remainingTokens: Math.max(0, state.limitTokens - state.spentTokens - reserved),
    calls: state.calls,
  };
}

export function completeTokenBudget(budgetId: string): void {
  governors.delete(budgetId);
}
