import { incrementMetric, setGauge } from './metrics';
import type { RuntimeRole, TokenBudgetPlan } from './token-economy';
import { getRuntimeStore } from './zenos-runtime-store';

export type TokenGovernorSnapshot = {
  budgetId: string;
  limitTokens: number;
  reserveTokens: number;
  spentTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  calls: number;
  anomalyCount: number;
  invalidSamples: number;
};

type GovernorState = {
  limitTokens: number;
  reserveTokens: number;
  spentTokens: number;
  calls: number;
  anomalyCount: number;
  invalidSamples: number;
  updatedAt: number;
  reservations: Map<string, number>;
};

const governors = new Map<string, GovernorState>();
const STATE_TTL_MS = 60 * 60 * 1_000;

function cleanup(now = Date.now()): void {
  for (const [id, state] of governors) {
    if (now - state.updatedAt > STATE_TTL_MS) governors.delete(id);
  }
  try {
    getRuntimeStore().pruneTokenGovernors(new Date(now).toISOString());
  } catch {
    // The in-memory guard remains fail-safe if persistence is temporarily unavailable.
  }
}

function persistState(id: string, state: GovernorState): void {
  const updatedAt = new Date(state.updatedAt).toISOString();
  getRuntimeStore().saveTokenGovernor({
    budgetId: id,
    limitTokens: state.limitTokens,
    reserveTokens: state.reserveTokens,
    spentTokens: state.spentTokens,
    calls: state.calls,
    anomalyCount: state.anomalyCount,
    invalidSamples: state.invalidSamples,
    reservations: Object.fromEntries(state.reservations),
    status: 'active',
    updatedAt,
    expiresAt: new Date(state.updatedAt + STATE_TTL_MS).toISOString(),
  });
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
  const persisted = getRuntimeStore().getTokenGovernor(plan.budgetId);
  if (persisted && Date.parse(persisted.expiresAt) > Date.now()) {
    const restored: GovernorState = {
      limitTokens: Math.max(persisted.limitTokens, plan.totalTokens),
      reserveTokens: Math.max(persisted.reserveTokens, plan.reserveTokens),
      spentTokens: persisted.spentTokens,
      calls: persisted.calls,
      anomalyCount: persisted.anomalyCount,
      invalidSamples: persisted.invalidSamples,
      updatedAt: Date.now(),
      reservations: new Map(Object.entries(persisted.reservations)),
    };
    governors.set(plan.budgetId, restored);
    persistState(plan.budgetId, restored);
    return restored;
  }
  const created: GovernorState = {
    limitTokens: plan.totalTokens,
    reserveTokens: plan.reserveTokens,
    spentTokens: 0,
    calls: 0,
    anomalyCount: 0,
    invalidSamples: 0,
    updatedAt: Date.now(),
    reservations: new Map(),
  };
  governors.set(plan.budgetId, created);
  persistState(plan.budgetId, created);
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
  persistState(input.plan.budgetId, state);
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
  usageValid?: boolean;
  invalidReason?: string;
}): TokenGovernorSnapshot {
  const state = stateFor(input.plan);
  const reserved = state.reservations.get(input.requestId) || 0;
  state.reservations.delete(input.requestId);
  if (input.attempted) {
    const reported = Math.max(0, Math.round(input.actualTokens));
    const plausibleCap = Math.max(reserved + 2_048, reserved * 2, 2_500);
    const invalid = input.usageValid === false || reported > plausibleCap;
    const actual = invalid
      ? Math.min(Math.max(1, reserved), Math.max(0, state.limitTokens - state.spentTokens))
      : Math.min(reported, plausibleCap);
    if (invalid) {
      state.anomalyCount += 1;
      if (input.usageValid === false) state.invalidSamples += 1;
      incrementMetric('runtime_token_governor_anomaly_total', {
        role: input.role,
        reason: input.usageValid === false ? 'invalid_usage' : 'oversized_actual',
      });
    }
    state.spentTokens = Math.min(state.limitTokens, state.spentTokens + actual);
    state.calls += 1;
    incrementMetric('runtime_token_governor_spent_total', { role: input.role }, actual);
  }
  state.updatedAt = Date.now();
  persistState(input.plan.budgetId, state);
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
    anomalyCount: state.anomalyCount,
    invalidSamples: state.invalidSamples,
  };
}

export function completeTokenBudget(budgetId: string): void {
  getRuntimeStore().completeTokenGovernor(budgetId);
  governors.delete(budgetId);
}

export function resetTokenGovernorProcessCacheForTests(): void {
  governors.clear();
}
