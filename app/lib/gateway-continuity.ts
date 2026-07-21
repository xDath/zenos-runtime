import * as crypto from 'node:crypto';
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
  cognitiveMemoryBrief,
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
  const byTask: Record<RouteDecision['taskType'], number> = {
    simple_chat: 400,
    memory_question: 2_200,
    repo_question: 1_200,
    coding_change: 1_300,
    debugging: 1_400,
    summarization: 1_000,
    planning_or_architecture: 1_600,
    security_or_secret: 1_800,
    deploy_or_destructive_action: 1_800,
    eval_or_benchmark: 1_000,
  };
  const riskBoost = decision.risk === 'critical' ? 300 : decision.risk === 'high' ? 200 : 0;
  return Math.max(300, Math.min(2_500, byTask[decision.taskType] + riskBoost));
}

export function hostWorkingSetForDecision(decision: RouteDecision): number {
  const configured = Number(process.env.ZENOS_HOST_CONTEXT_SOFT_LIMIT_TOKENS || '0');
  if (Number.isFinite(configured) && configured > 0 && process.env.ZENOS_ADAPTIVE_CONTEXT_LIMITS === 'false') {
    return Math.max(24_000, Math.min(configured, 256_000));
  }
  const byTask: Record<RouteDecision['taskType'], number> = {
    simple_chat: 48_000,
    memory_question: 64_000,
    repo_question: 128_000,
    coding_change: 192_000,
    debugging: 160_000,
    summarization: 128_000,
    planning_or_architecture: 96_000,
    security_or_secret: 96_000,
    deploy_or_destructive_action: 128_000,
    eval_or_benchmark: 96_000,
  };
  const baseline = byTask[decision.taskType];
  const riskFactor = decision.risk === 'critical' ? 0.8 : decision.risk === 'high' ? 0.9 : 1;
  const adaptive = Math.max(24_000, Math.min(256_000, Math.round(baseline * riskFactor)));
  // Runtime owns the earlier logical checkpoint. Hermes' native compressor is
  // the later physical safety boundary, so a configured cap must constrain
  // every adaptive task class instead of only the legacy fixed-limit mode.
  return Number.isFinite(configured) && configured > 0
    ? Math.min(adaptive, Math.max(24_000, Math.min(configured, 256_000)))
    : adaptive;
}

function cognitivePhaseForDecision(decision: RouteDecision): string {
  if (decision.taskType === 'planning_or_architecture') return 'plan';
  if (decision.taskType === 'debugging') return 'discover';
  if (decision.taskType === 'coding_change' || decision.taskType === 'deploy_or_destructive_action') return 'execute';
  if (decision.taskType === 'eval_or_benchmark') return 'validate';
  return 'understand';
}

function safeNamespacePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
}

function memoryNamespaces(request: GatewayTurnPreflightRequest): { primary: string; shared?: string } {
  const shared = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  if (!request.workspaceRoot || process.env.ZENOS_MEMORY_PROJECT_NAMESPACES === 'false') return { primary: shared };
  const projectName = safeNamespacePart(path.basename(request.workspaceRoot));
  const projectHash = crypto.createHash('sha256').update(path.resolve(request.workspaceRoot)).digest('hex').slice(0, 10);
  return {
    primary: `${safeNamespacePart(shared)}.project.${projectName}.${projectHash}`.slice(0, 120),
    shared,
  };
}

async function recallAcrossNamespaces(input: {
  query: string;
  primary: string;
  shared?: string;
  limit: number;
  maxChars: number;
}): Promise<GatewayMemoryBrief> {
  const namespaces = [...new Set([input.primary, input.shared].filter((value): value is string => Boolean(value)))];
  const perNamespaceChars = Math.max(800, Math.floor(input.maxChars / namespaces.length));
  const results = await Promise.all(namespaces.map((namespace) => recallMemoryContext({
    query: input.query,
    namespace,
    limit: input.limit,
    maxChars: perNamespaceChars,
  })));
  const contexts = results
    .map((result, index) => result.ok && result.value ? `[namespace=${namespaces[index]}]\n${result.value}` : '')
    .filter(Boolean);
  if (!contexts.length) {
    return {
      context: '',
      source: 'none',
      degraded: true,
      latencyMs: Math.max(0, ...results.map((result) => result.latencyMs || 0)),
    };
  }
  return {
    context: contexts.join('\n\n'),
    source: 'recall',
    degraded: results.some((result) => result.degraded),
    cacheHit: results.every((result) => result.cacheHit),
    latencyMs: Math.max(0, ...results.map((result) => result.latencyMs || 0)),
  };
}

async function bootstrapAcrossNamespaces(input: {
  query: string;
  primary: string;
  shared?: string;
  limit: number;
  maxChars: number;
}): Promise<GatewayMemoryBrief> {
  const namespaces = [...new Set([input.primary, input.shared].filter((value): value is string => Boolean(value)))];
  const perNamespaceChars = Math.max(800, Math.floor(input.maxChars / namespaces.length));
  const results = await Promise.all(namespaces.map((namespace) => bootstrapMemoryContext({
    namespace,
    queries: [input.query],
    limit: input.limit,
    maxChars: perNamespaceChars,
  })));
  const contexts = results
    .map((result, index) => result.ok && result.value ? `[namespace=${namespaces[index]}]\n${result.value}` : '')
    .filter(Boolean);
  if (!contexts.length) return { context: '', source: 'none', degraded: true };
  return {
    context: contexts.join('\n\n'),
    source: 'bootstrap',
    degraded: results.some((result) => result.degraded),
    cacheHit: results.every((result) => result.cacheHit),
    latencyMs: Math.max(0, ...results.map((result) => result.latencyMs || 0)),
  };
}

export async function gatewayMemoryContextFor(
  request: GatewayTurnPreflightRequest,
  decision: RouteDecision,
  existingSession: boolean,
): Promise<GatewayMemoryBrief> {
  const namespaces = memoryNamespaces(request);
  const softLimit = hostWorkingSetForDecision(decision);
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
      namespace: namespaces.primary,
      sessionId: request.sessionId,
      conversationId: request.turnId,
      approxTokens: request.estimatedContextTokens,
      maxChars: 8_000,
      inputMaxChars: 120_000,
      reason: `hermes-host-working-set-pressure:${decision.taskType}:${softLimit}`,
    });
    if (compact.ok && compact.value?.context) {
      let context = compact.value.context;
      if (decision.taskType === 'memory_question') {
        const recalled = await recallAcrossNamespaces({
          query: memoryQuery,
          primary: namespaces.primary,
          shared: namespaces.shared,
          limit: Math.max(4, decision.maxMemoryItems),
          maxChars: 5_000,
        });
        if (recalled.context) context = `${context}\n\n${recalled.context}`;
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

  // Prefer a decision-grade cognitive packet over a generic memory dump for
  // every non-trivial Host task. It groups current decisions, procedures,
  // failures, preferences, tasks, and artifacts around the active objective.
  if (decision.taskType !== 'simple_chat') {
    const cognitive = await cognitiveMemoryBrief({
      objective: memoryQuery,
      phase: cognitivePhaseForDecision(decision),
      namespace: namespaces.primary,
      sharedNamespace: namespaces.shared,
      additionalNamespaces: [process.env.ZENOS_MEMORY_LEARNING_NAMESPACE || 'runtime.learning'],
      artifactHints: request.workspaceRoot ? [request.workspaceRoot, projectName] : undefined,
      limit: Math.max(8, decision.maxMemoryItems * 3),
      maxChars: Math.ceil(contextBudget * 3.4),
    });
    if (cognitive.ok && cognitive.value) {
      return {
        context: truncateToTokenBudget(cognitive.value, contextBudget, '\n[COGNITIVE BRIEF TRUNCATED]'),
        source: existingSession ? 'recall' : 'bootstrap',
        evidenceRefs: cognitive.evidenceRefs,
        degraded: cognitive.degraded,
        cacheHit: cognitive.cacheHit,
        latencyMs: cognitive.latencyMs,
      };
    }
  }

  if (!existingSession) {
    const bootstrap = await bootstrapAcrossNamespaces({
      query: memoryQuery,
      primary: namespaces.primary,
      shared: namespaces.shared,
      limit: Math.max(4, decision.maxMemoryItems),
      maxChars: Math.ceil(contextBudget * 3.4),
    });
    if (bootstrap.context) {
      return {
        ...bootstrap,
        context: truncateToTokenBudget(bootstrap.context, contextBudget, '\n[MEMORY BOOTSTRAP TRUNCATED]'),
      };
    }
  }

  const recalled = await recallAcrossNamespaces({
    query: memoryQuery,
    primary: namespaces.primary,
    shared: namespaces.shared,
    limit: Math.max(1, decision.maxMemoryItems),
    maxChars: Math.ceil(contextBudget * 3.4),
  });
  if (recalled.context) {
    return {
      ...recalled,
      context: truncateToTokenBudget(recalled.context, contextBudget, '\n[MEMORY RECALL TRUNCATED]'),
    };
  }
  return recalled;
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
