import path from 'node:path';
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

function memoryTokenBudget(decision: RouteDecision): number {
  if (decision.taskType === 'memory_question') return 1_800;
  if (['coding_change', 'debugging', 'repo_question'].includes(decision.taskType)) return 1_000;
  if (['planning_or_architecture', 'security_or_secret', 'deploy_or_destructive_action'].includes(decision.taskType)) return 1_400;
  return 500;
}

export async function gatewayMemoryContextFor(
  request: GatewayTurnPreflightRequest,
  decision: RouteDecision,
  existingSession: boolean,
): Promise<GatewayMemoryBrief> {
  const namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  const softLimit = Math.max(24_000, Number(process.env.ZENOS_HOST_CONTEXT_SOFT_LIMIT_TOKENS || 64_000));
  const contextBudget = memoryTokenBudget(decision);
  const projectName = request.workspaceRoot ? path.basename(request.workspaceRoot) : '';
  const memoryQuery = projectName
    ? `Active project ${projectName}. ${request.request}`
    : request.request;
  const underPressure = request.estimatedContextTokens >= softLimit;
  const hasHandoffSource = request.handoffMessages.length >= 4;

  if (underPressure && hasHandoffSource) {
    const compact = await compactMemoryHandoff({
      messages: request.handoffMessages,
      namespace,
      sessionId: request.sessionId,
      conversationId: request.turnId,
      approxTokens: request.estimatedContextTokens,
      maxChars: 8_000,
      inputMaxChars: 120_000,
      reason: 'hermes-host-working-set-pressure',
    });
    if (compact.ok && compact.value?.context) {
      let context = compact.value.context;
      if (decision.taskType === 'memory_question') {
        const recalled = await recallMemoryContext({
          query: memoryQuery,
          namespace,
          limit: Math.max(4, decision.maxMemoryItems),
          maxChars: 5_000,
        });
        if (recalled.ok && recalled.value) context = `${context}\n\n${recalled.value}`;
      }
      return {
        context: truncateToTokenBudget(context, contextBudget, '\n[MEMORY BRIEF TRUNCATED]'),
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
      queries: [memoryQuery],
      limit: Math.max(4, decision.maxMemoryItems),
      maxChars: Math.ceil(contextBudget * 3.4),
    });
    if (bootstrap.ok && bootstrap.value) {
      return {
        context: truncateToTokenBudget(bootstrap.value, contextBudget, '\n[MEMORY BOOTSTRAP TRUNCATED]'),
        source: 'bootstrap',
        degraded: bootstrap.degraded,
        cacheHit: bootstrap.cacheHit,
        latencyMs: bootstrap.latencyMs,
      };
    }
  }

  const recalled = await recallMemoryContext({
    query: memoryQuery,
    namespace,
    limit: Math.max(1, decision.maxMemoryItems),
    maxChars: Math.ceil(contextBudget * 3.4),
  });
  if (recalled.ok && recalled.value) {
    return {
      context: truncateToTokenBudget(recalled.value, contextBudget, '\n[MEMORY RECALL TRUNCATED]'),
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
