import { z } from 'zod';
import {
  GatewayHostPlan,
  GatewayHostPlanSchema,
  GatewayMemoryBrief,
  GatewayTurnPreflightRequest,
} from './gateway-contracts';
import { LatencyBudgetPlan, roleLatencyTimeout } from './latency-budget';
import { RouteDecision, RouteDecisionSchema } from './zenos-runtime';
import { RuntimeModelResult, RuntimeRunRequestSchema, callRuntimeModel } from './zenos-runtime-executor';
import { estimateTokenCount } from './token-economy';

export function safeHostPlan(call: RuntimeModelResult): GatewayHostPlan | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = GatewayHostPlanSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

export function needsHostPlanning(request: GatewayTurnPreflightRequest, decision: RouteDecision): boolean {
  if (request.userRequestedBoss || request.userRequestedVerification) return true;
  if (decision.risk === 'high' || decision.risk === 'critical' || request.confidence < 0.7) return true;
  if (['planning_or_architecture', 'summarization', 'eval_or_benchmark', 'security_or_secret', 'deploy_or_destructive_action'].includes(decision.taskType)) return true;
  if (decision.useWorker && !['repo_question', 'coding_change', 'debugging'].includes(decision.taskType)) return true;
  return false;
}

export function pipelineForHostPlan(
  decision: RouteDecision,
  plan: GatewayHostPlan,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const safetyVerifier = request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const safetyBoss = request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  const useWorker = plan.useWorker;
  const useVerifier = safetyVerifier || plan.useVerifier;
  const useBoss = safetyBoss || plan.useBoss;
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
      useWorker ? 'Host delegated bounded work to Worker' : 'Host retained the task without Worker delegation',
      useBoss ? 'Boss authority requested by Host or mandatory safety policy' : 'Boss not required by Host or safety policy',
    ],
  });
}

export function hostPlanningFallback(
  decision: RouteDecision,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const useVerifier = request.userRequestedVerification
    || decision.requiresApproval
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const useBoss = request.userRequestedBoss
    || decision.requiresApproval
    || decision.risk === 'critical';
  return RouteDecisionSchema.parse({
    ...decision,
    useWorker: false,
    workerTier: 'none',
    maxWorkerCalls: 0,
    useVerifier,
    verifierTier: useVerifier ? (decision.verifierTier === 'none' ? 'cheap' : decision.verifierTier) : 'none',
    useBoss,
    allowEscalation: decision.allowEscalation || useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : decision.useTools || decision.useMemory
          ? 'grounded_path'
          : 'direct_fast_path',
    reasons: [
      ...decision.reasons,
      'Host planner unavailable; Worker delegation disabled rather than letting Worker lead the turn',
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
): Promise<{ plan?: GatewayHostPlan; call?: RuntimeModelResult; decision: RouteDecision }> {
  if (!needsHostPlanning(request, baseline)) return { decision: baseline };

  const complexPlanner = baseline.risk === 'high'
    || baseline.risk === 'critical'
    || baseline.taskType === 'planning_or_architecture'
    || request.estimatedContextTokens >= 40_000;
  const plannerPromptTokens = estimateTokenCount([
    request.request,
    request.context.slice(-12_000),
    repositoryContext.slice(0, 16_000),
    memory.context.slice(0, 10_000),
  ].join('\n\n'));

  const call = await callRuntimeModel('host', [
    {
      role: 'system',
      content: `You are the Zenos Host Planner, the primary brain and orchestrator for this user turn.
Understand the user's goal before any Worker or Boss is invoked. Do not answer the user yet.
Delegate to Worker only for bounded inspection, evidence extraction, compression, or implementation support.
Use Verifier when independent checking materially improves reliability.
Boss is the highest decision authority, but invoke Boss only for explicit user requests, critical/high-stakes uncertainty, unresolved conflict, or when your confidence is genuinely insufficient.
Return ONLY JSON matching:
{"intentSummary":"...","useWorker":true,"workerTask":"...","useVerifier":false,"useBoss":false,"confidence":0.0,"rationale":"...","acceptanceCriteria":["..."],"constraints":["..."]}`,
    },
    {
      role: 'user',
      content: `User request:\n${request.request}\n\nDeterministic safety baseline:\n${JSON.stringify(baseline)}\n\nConversation context (bounded):\n${request.context.slice(-12_000) || '(none)'}\n\nDurable Memory context (bounded):\n${memory.context.slice(0, 10_000) || '(none)'}\n\nRepository context (bounded):\n${repositoryContext.slice(0, 16_000) || '(none)'}\n\nChoose the minimum sufficient delegation while keeping Host responsible for the final decision.`,
    },
  ], {
    json: true,
    maxTokens: complexPlanner ? 600 : 400,
    maxInputTokens: complexPlanner
      ? 6_000
      : Math.max(1_800, Math.min(3_500, plannerPromptTokens + 500)),
    timeoutMs: roleLatencyTimeout(latencyPlan, 'host'),
    sessionId: request.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: `${runId}:gateway-host-plan`,
    trigger: 'host_planning',
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
