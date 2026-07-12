import { evaluateExecutionBoundary } from './execution-boundary';
import { GatewayMemoryBrief, GatewayTurnPreflightRequest } from './gateway-contracts';
import { LatencyBudgetPlan, LatencyObservation, observeLatency } from './latency-budget';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  renderRepositoryContext,
} from './repository-intelligence';
import { RouteDecision } from './zenos-runtime';
import {
  bootstrapMemoryContext,
  compactMemoryHandoff,
  recallMemoryContext,
} from './zenos-memory-client';
import { truncateToTokenBudget } from './token-economy';

export async function repositoryContextFor(
  input: GatewayTurnPreflightRequest,
  decision: RouteDecision,
): Promise<string> {
  if (!input.workspaceRoot || !decision.useTools) return '';
  if (!['repo_question', 'coding_change', 'debugging', 'security_or_secret'].includes(decision.taskType)) return '';
  const boundary = evaluateExecutionBoundary({ action: 'workspace_read', workspaceRoot: input.workspaceRoot });
  if (!boundary.allowed) return `Repository intelligence blocked by execution boundary: ${boundary.reason}`;
  try {
    const index = await buildRepositoryIndex(input.workspaceRoot);
    return renderRepositoryContext(index, analyzeChangeImpact(index));
  } catch (error) {
    return `Repository intelligence unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
}

export async function gatewayMemoryContextFor(
  request: GatewayTurnPreflightRequest,
  decision: RouteDecision,
  existingSession: boolean,
): Promise<GatewayMemoryBrief> {
  const namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  const softLimit = Math.max(40_000, Number(process.env.ZENOS_HOST_CONTEXT_SOFT_LIMIT_TOKENS || 160_000));
  const underPressure = request.estimatedContextTokens >= softLimit;
  const hasHandoffSource = request.handoffMessages.length >= 4;

  if (underPressure && hasHandoffSource) {
    const compact = await compactMemoryHandoff({
      messages: request.handoffMessages,
      namespace,
      sessionId: request.sessionId,
      conversationId: request.turnId,
      approxTokens: request.estimatedContextTokens,
      maxChars: 10_000,
      inputMaxChars: 240_000,
      reason: 'hermes-host-working-set-pressure',
    });
    if (compact.ok && compact.value?.context) {
      let context = compact.value.context;
      if (decision.taskType === 'memory_question') {
        const recalled = await recallMemoryContext({
          query: request.request,
          namespace,
          limit: Math.max(4, decision.maxMemoryItems),
          maxChars: 5_000,
        });
        if (recalled.ok && recalled.value) context = `${context}\n\n${recalled.value}`;
      }
      return {
        context: truncateToTokenBudget(context, 4_000, '\n[MEMORY BRIEF TRUNCATED]'),
        source: 'handoff',
        coverage: compact.value.coverage,
        degraded: compact.degraded,
        cacheHit: compact.cacheHit,
        latencyMs: compact.latencyMs,
      };
    }
  }

  if (!decision.useMemory) return { context: '', source: 'none' };

  if (!existingSession) {
    const bootstrap = await bootstrapMemoryContext({
      namespace,
      queries: [request.request, 'current active project goal decisions blockers pending work'],
      limit: Math.max(8, decision.maxMemoryItems),
      maxChars: 6_000,
    });
    if (bootstrap.ok && bootstrap.value) {
      return {
        context: bootstrap.value,
        source: 'bootstrap',
        degraded: bootstrap.degraded,
        cacheHit: bootstrap.cacheHit,
        latencyMs: bootstrap.latencyMs,
      };
    }
  }

  const recalled = await recallMemoryContext({
    query: request.request,
    namespace,
    limit: Math.max(1, decision.maxMemoryItems),
    maxChars: 8_000,
  });
  if (recalled.ok && recalled.value) {
    return {
      context: recalled.value,
      source: 'recall',
      degraded: recalled.degraded,
      cacheHit: recalled.cacheHit,
      latencyMs: recalled.latencyMs,
    };
  }
  return { context: '', source: 'none', degraded: true, latencyMs: recalled.latencyMs };
}

export async function prepareGatewayContexts(input: {
  request: GatewayTurnPreflightRequest;
  decision: RouteDecision;
  existingSession: boolean;
  latencyPlan: LatencyBudgetPlan;
}): Promise<{ repositoryContext: string; memoryBrief: GatewayMemoryBrief; observations: LatencyObservation[] }> {
  const repositoryStarted = Date.now();
  const memoryStarted = Date.now();
  const [repositoryContext, memoryBrief] = await Promise.all([
    repositoryContextFor(input.request, input.decision),
    gatewayMemoryContextFor(input.request, input.decision, input.existingSession),
  ]);
  return {
    repositoryContext,
    memoryBrief,
    observations: [
      observeLatency('repository', Date.now() - repositoryStarted, input.latencyPlan.repositoryMs),
      observeLatency('memory', memoryBrief.latencyMs ?? Date.now() - memoryStarted, input.latencyPlan.memoryMs),
    ],
  };
}
