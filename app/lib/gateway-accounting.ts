import { RuntimeModelResult } from './zenos-runtime-executor';
import { getRuntimeSession, updateRuntimeSession } from './zenos-runtime-three-agent';

export type HermesHostUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
};

export function callIdentity(call?: RuntimeModelResult): { model?: string; provider?: string; invoked: boolean; ok?: boolean } {
  return call
    ? { model: call.model, provider: call.provider, invoked: true, ok: call.ok }
    : { invoked: false };
}

export function modelCallTokens(call: RuntimeModelResult): number {
  const usage = call.usage;
  if (!usage) return 0;
  return Math.max(0, Math.round(
    usage.totalTokens
      || usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + usage.outputTokens,
  ));
}

export function accountGatewayModelUsage(
  sessionId: string,
  calls: RuntimeModelResult[],
  hostUsage: HermesHostUsage,
): void {
  const session = getRuntimeSession(sessionId);
  if (!session) return;
  const byRole = (role: RuntimeModelResult['role']) => calls
    .filter((call) => call.role === role)
    .reduce((sum, call) => sum + modelCallTokens(call), 0);
  const hermesHostTokens = Math.max(0, Math.round(
    hostUsage.inputTokens
      + hostUsage.cacheReadTokens
      + hostUsage.cacheWriteTokens
      + hostUsage.outputTokens,
  ));
  updateRuntimeSession(sessionId, {
    budget: {
      ...session.budget,
      premiumTokensUsed: session.budget.premiumTokensUsed + byRole('boss'),
      hostTokensUsed: session.budget.hostTokensUsed + hermesHostTokens + byRole('host'),
      workerTokensUsed: session.budget.workerTokensUsed + byRole('worker'),
      verifierTokensUsed: session.budget.verifierTokensUsed + byRole('verifier'),
      modelCallsUsed: session.budget.modelCallsUsed + Math.max(0, hostUsage.calls) + calls.length,
    },
  });
}

export function gatewayHostCallCount(calls: RuntimeModelResult[], hostUsage: Pick<HermesHostUsage, 'calls'>): number {
  return Math.max(0, hostUsage.calls) + calls.filter((call) => call.role === 'host').length;
}
