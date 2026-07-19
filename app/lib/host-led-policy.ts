import { RouteDecision, RouteDecisionSchema, userExplicitlyDisabledVerifier } from './zenos-runtime';

export type HostLedRequest = {
  request: string;
  userRequestedVerification: boolean;
  userRequestedBoss: boolean;
};

export function hostLedRuntimeEnabled(): boolean {
  return (process.env.ZENOS_ORCHESTRATION_MODE || 'host-led').trim().toLowerCase() !== 'legacy';
}

export function applyHostLedPolicy(
  decision: RouteDecision,
  request: HostLedRequest,
): RouteDecision {
  const verifierOptOut = userExplicitlyDisabledVerifier(request.request);
  const useVerifier = !verifierOptOut && request.userRequestedVerification;
  const useBoss = request.userRequestedBoss || decision.requiresApproval || decision.risk === 'critical';
  return RouteDecisionSchema.parse({
    ...decision,
    useWorker: false,
    workerTier: 'none',
    maxWorkerCalls: 0,
    useVerifier,
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    maxRevisionAttempts: useVerifier ? Math.max(1, decision.maxRevisionAttempts) : 0,
    useBoss,
    allowEscalation: useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : decision.useTools || decision.useMemory
          ? 'grounded_path'
          : 'direct_fast_path',
    reasons: [
      ...decision.reasons,
      'host-led cognitive runtime: Hermes Host is the sole orchestrator',
      'native Hermes delegation replaces the preflight Runtime Worker model call',
      useVerifier
        ? 'independent verification was explicitly requested by the user'
        : 'independent Verifier is off by default; Host self-review plus deterministic evidence is authoritative',
      useBoss
        ? 'Boss authority is limited to explicit request, approval boundary, or critical risk'
        : 'Boss is not part of ordinary execution',
    ],
  });
}
