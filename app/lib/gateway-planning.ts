import { z } from 'zod';
import {
  GatewayHostPlan,
  GatewayHostPlanSchema,
  GatewayMemoryBrief,
  GatewayTurnPreflightRequest,
} from './gateway-contracts';
import { LatencyBudgetPlan, roleLatencyTimeout } from './latency-budget';
import { RouteDecision, RouteDecisionSchema, userExplicitlyDisabledVerifier } from './zenos-runtime';
import {
  applyHostLedPolicy,
  hostLedRuntimeEnabled,
} from './host-led-policy';

export { hostLedRuntimeEnabled } from './host-led-policy';
export const hostLedDecision = applyHostLedPolicy;
import { RuntimeModelResult, RuntimeRunRequestSchema, callRuntimeModel } from './zenos-runtime-executor';
import { estimateTokenCount, TokenBudgetPlan } from './token-economy';

export function safeHostPlan(call: RuntimeModelResult): GatewayHostPlan | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = GatewayHostPlanSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

export function needsHostPlanning(request: GatewayTurnPreflightRequest, decision: RouteDecision): boolean {
  if (hostLedRuntimeEnabled()) return false;
  if (request.userRequestedBoss || request.userRequestedVerification) return true;
  if (decision.risk === 'high' || decision.risk === 'critical' || request.confidence < 0.72) return true;
  // Host remains the orchestrator whenever bounded delegation is proposed.
  // Simple/direct turns skip this extra call entirely.
  if (decision.useWorker || decision.useBoss) return true;
  if (['repo_question', 'planning_or_architecture', 'security_or_secret', 'deploy_or_destructive_action'].includes(decision.taskType)) return true;
  if (decision.useTools && ['execute', 'mutate'].includes(request.intent)) return true;
  return false;
}

function deterministicWorkerFloor(decision: RouteDecision, request: GatewayTurnPreflightRequest): boolean {
  if (!decision.useWorker) return false;
  if (['coding_change', 'debugging'].includes(decision.taskType)) return true;
  if (decision.taskType === 'summarization' && request.estimatedContextTokens >= 4_000) return true;
  return false;
}

export function pipelineForHostPlan(
  decision: RouteDecision,
  plan: GatewayHostPlan,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const verifierOptOut = userExplicitlyDisabledVerifier(request.request);
  const requiredVerifier = !verifierOptOut && (
    decision.useVerifier
    || request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical'
  );
  const requiredBoss = decision.useBoss
    || request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  const requiredWorker = deterministicWorkerFloor(decision, request);
  const useWorker = requiredWorker || plan.useWorker;
  const useVerifier = verifierOptOut ? false : requiredVerifier || plan.useVerifier;
  const useBoss = requiredBoss || plan.useBoss;
  const pipelineMode: RouteDecision['pipelineMode'] = useBoss
    ? 'escalated_deep_path'
    : useVerifier
      ? 'verified_path'
      : useWorker
        ? 'worker_compression_path'
        : decision.useTools || decision.useMemory
          ? 'grounded_path'
          : 'direct_fast_path';

  return RouteDecisionSchema.parse({
    ...decision,
    pipelineMode,
    useWorker,
    useVerifier,
    useBoss,
    allowEscalation: decision.allowEscalation || useBoss || plan.confidence < 0.55,
    workerTier: useWorker ? (decision.workerTier === 'none' ? 'standard' : decision.workerTier) : 'none',
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    maxWorkerCalls: useWorker ? Math.max(1, decision.maxWorkerCalls) : 0,
    maxRevisionAttempts: useVerifier ? Math.max(1, decision.maxRevisionAttempts) : 0,
    reasons: [
      ...decision.reasons,
      `host-plan:${plan.rationale}`,
      useWorker
        ? requiredWorker
          ? 'Deterministic task policy requires bounded Worker support'
          : 'Host delegated bounded work to Worker'
        : 'Host retained the task without Worker delegation',
      useVerifier
        ? requiredVerifier
          ? 'Deterministic policy requires independent Verifier review'
          : 'Host requested independent Verifier review'
        : verifierOptOut
          ? 'User explicitly disabled the independent Verifier; Host owns final self-review'
          : 'Verifier not required by Host or deterministic policy',
      useBoss
        ? requiredBoss
          ? 'Deterministic policy requires Boss authority'
          : 'Host requested Boss authority'
        : 'Boss not required by Host or safety policy',
    ],
  });
}

export function hostPlanningFallback(
  decision: RouteDecision,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const verifierOptOut = userExplicitlyDisabledVerifier(request.request);
  const useVerifier = !verifierOptOut && (
    decision.useVerifier
    || request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical'
  );
  const useBoss = decision.useBoss
    || request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  const useWorker = deterministicWorkerFloor(decision, request);
  return RouteDecisionSchema.parse({
    ...decision,
    useWorker,
    workerTier: useWorker ? (decision.workerTier === 'none' ? 'standard' : decision.workerTier) : 'none',
    maxWorkerCalls: useWorker ? Math.max(1, decision.maxWorkerCalls) : 0,
    useVerifier,
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    useBoss,
    allowEscalation: decision.allowEscalation || useBoss,
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
      useWorker
        ? 'Host planner unavailable; deterministic Worker requirement retained'
        : 'Host planner unavailable; optional Worker delegation disabled rather than letting Worker lead the turn',
    ],
  });
}

export async function runGatewayHostPlanning(
  request: GatewayTurnPreflightRequest,
  input: z.infer<typeof RuntimeRunRequestSchema>,
  baseline: RouteDecision,
  repositoryContext: string,
  memory: GatewayMemoryBrief,
  runId: string,
  latencyPlan: LatencyBudgetPlan,
  budget: TokenBudgetPlan,
): Promise<{ plan?: GatewayHostPlan; call?: RuntimeModelResult; decision: RouteDecision }> {
  if (hostLedRuntimeEnabled()) return { decision: hostLedDecision(baseline, request) };
  if (!needsHostPlanning(request, baseline)) return { decision: baseline };

  const complexPlanner = baseline.risk === 'high'
    || baseline.risk === 'critical'
    || request.estimatedContextTokens >= 40_000;
  const plannerPromptTokens = estimateTokenCount([
    request.request,
    request.context.slice(-4_000),
    repositoryContext.slice(0, 8_000),
    memory.context.slice(0, 4_000),
  ].join('\n\n'));

  const call = await callRuntimeModel('host', [
    {
      role: 'system',
      content: `You are the Zenos Host Planner, the primary brain and orchestrator for this user turn.
Understand the user's goal before any Worker or Boss is invoked. Do not answer the user yet.
Delegate to Worker only for bounded inspection, evidence extraction, compression, or implementation support.
Use Verifier when independent checking materially improves reliability. Respect an explicit user request to disable the independent Verifier; in that case Host must perform the final self-review instead and must not re-enable Verifier through planning.
Boss is the highest decision authority, but invoke Boss only for explicit user requests, critical/high-stakes uncertainty, unresolved conflict, or when your confidence is genuinely insufficient.
Return ONLY JSON matching:
{"intentSummary":"...","useWorker":true,"workerTask":"...","useVerifier":false,"useBoss":false,"confidence":0.0,"rationale":"...","acceptanceCriteria":["..."],"constraints":["..."]}`,
    },
    {
      role: 'user',
      content: `User request:\n${request.request}\n\nDeterministic safety baseline:\n${JSON.stringify(baseline)}\n\nConversation context (bounded):\n${request.context.slice(-4_000) || '(none)'}\n\nDurable Memory context (bounded):\n${memory.context.slice(0, 4_000) || '(none)'}\n\nRepository context (bounded):\n${repositoryContext.slice(0, 8_000) || '(none)'}\n\nChoose the minimum sufficient delegation while keeping Host responsible for the final decision.`,
    },
  ], {
    json: true,
    maxTokens: complexPlanner ? 400 : 280,
    maxInputTokens: complexPlanner
      ? 3_500
      : Math.max(1_400, Math.min(2_500, plannerPromptTokens + 300)),
    timeoutMs: roleLatencyTimeout(latencyPlan, 'host'),
    sessionId: request.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: `${runId}:gateway-host-plan`,
    trigger: 'host_planning',
    tokenBudgetPlan: budget,
  });
  const plan = safeHostPlan(call);
  return {
    plan,
    call,
    decision: plan
      ? pipelineForHostPlan(baseline, plan, request)
      : hostPlanningFallback(baseline, request),
  };
}

export function compactHostPlan(plan?: GatewayHostPlan): string {
  if (!plan) return '';
  return [
    `Host intent: ${plan.intentSummary}`,
    `Host orchestration: worker=${plan.useWorker}; verifier=${plan.useVerifier}; boss=${plan.useBoss}; confidence=${plan.confidence.toFixed(2)}`,
    plan.workerTask ? `Worker delegation: ${plan.workerTask}` : '',
    plan.acceptanceCriteria.length ? `Acceptance criteria: ${plan.acceptanceCriteria.join('; ')}` : '',
    plan.constraints.length ? `Constraints: ${plan.constraints.join('; ')}` : '',
    `Host rationale: ${plan.rationale}`,
  ].filter(Boolean).join('\n');
}
