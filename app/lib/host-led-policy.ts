import { decideLowTierRouting } from './low-tier-routing';
import { RouteDecision, RouteDecisionSchema, userExplicitlyDisabledVerifier } from './zenos-runtime';

export type HostLedRequest = {
  request: string;
  userRequestedVerification: boolean;
  userRequestedBoss: boolean;
  sessionId?: string;
  workspaceRoot?: string;
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
  const lowTier = decideLowTierRouting({
    decision,
    sessionId: request.sessionId,
    workspaceAvailable: Boolean(request.workspaceRoot),
  });
  const useWorker = lowTier.activate;
  return RouteDecisionSchema.parse({
    ...decision,
    useWorker,
    workerTier: useWorker ? 'cheap' : 'none',
    maxWorkerCalls: useWorker ? Math.max(1, decision.maxWorkerCalls) : 0,
    useVerifier,
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    maxRevisionAttempts: useVerifier ? Math.max(1, decision.maxRevisionAttempts) : 0,
    useBoss,
    allowEscalation: useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : useWorker
          ? 'worker_compression_path'
          : decision.useTools || decision.useMemory
            ? 'grounded_path'
            : 'direct_fast_path',
    reasons: [
      ...decision.reasons,
      'host-led cognitive runtime: Hermes Host is the sole orchestrator and remains responsible for final synthesis',
      useWorker
        ? `low-tier tool-first route active: ${lowTier.reason}`
        : `low-tier tool-first route inactive: ${lowTier.reason}; samples=${lowTier.evidence.sampleSize}; success=${lowTier.evidence.successRate}`,
      useVerifier
        ? 'independent verification was explicitly requested by the user'
        : 'independent Verifier is off by default; Host self-review plus deterministic evidence is authoritative',
      useBoss
        ? 'Boss authority is limited to explicit request, approval boundary, or critical risk'
        : 'Boss is not part of ordinary execution',
    ],
  });
}
