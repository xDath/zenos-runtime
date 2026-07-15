import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  apiKeyForSlot,
  baseUrlForSlot,
  mergeModelSlots,
  modelForSlot,
  providerForSlot,
  publicModelSlots,
  readRuntimeModelSlots,
  readSessionModelSlots,
  RuntimeModelSlots,
  RuntimeModelSlotsSchema,
} from './zenos-runtime-model-config';
import {
  buildRouteEvent,
  choosePipeline,
  estimateRouteTokens,
  RouteDecision,
  RouteEvent,
  RuntimeContextSchema,
  validateVerifierResult,
  validateWorkerResult,
  VerifierResult,
  WorkerResult,
} from './zenos-runtime';
import {
  applyBossDecision,
  buildEscalationPacket,
  completeRuntimeSession,
  createRuntimeSession,
  failRuntimeSession,
  getRuntimeSession,
  recordWorkerEvent,
  runQualityGate,
  updateRuntimeSession,
  updateWorkerLease,
} from './zenos-runtime-three-agent';
import { BossDecision, BossDecisionSchema, EscalationPacket, WorkerTemplateName, workerTemplates } from './zenos-runtime-state';
import { getRuntimeStore } from './zenos-runtime-store';
import { persistRouteEventToMemory, recallMemoryContext } from './zenos-memory-client';
import { incrementMetric, observeDuration } from './metrics';
import { log, redactText } from './logger';
import { compileRuntimeContext, renderRolePacket, RuntimeWorkPacket } from './runtime-context-compiler';
import { compactSourceContext, mergeWorkerResults, splitRoleContext } from './runtime-role-context';
import { CodingTaskState, prepareCodexExecution } from './codex-execution-core';
import { AutonomousCodingOutcome, runAutonomousCodingLoop } from './autonomous-coding-loop';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  ChangeImpact,
  renderRepositoryContext,
} from './repository-intelligence';
import { normalizeWorkspacePath } from './execution-boundary';
import { createDefaultSkillRegistry } from './skill-registry';
import {
  buildDeltaRevisionContext,
  createTokenBudgetPlan,
  estimateModelInputTokens,
  recordTokenEstimateCalibration,
  roleBudget,
  TokenBudgetPlan,
  truncateToTokenBudget,
} from './token-economy';
import { createLatencyBudgetPlan, LatencyObservation, observeLatency } from './latency-budget';
import { authorizeTokenSpend, settleTokenSpend } from './token-governor';
import { recordOutcomePassport } from './outcome-ledger';

export const RuntimeRunRequestSchema = RuntimeContextSchema.extend({
  sessionId: z.string().min(1).max(220).optional(),
  persistSession: z.boolean().optional().default(true),
  context: z.string().max(500_000).optional().default(''),
  memoryContext: z.string().max(100_000).optional().default(''),
  toolContext: z.string().max(500_000).optional().default(''),
  namespace: z.string().trim().min(1).max(120).optional().default('zenos'),
  autoRecallMemory: z.boolean().optional().default(true),
  persistRouteEvent: z.boolean().optional().default(false),
  tokenPriority: z.enum(['economy', 'balanced', 'quality']).optional().default('economy'),
  approvalGranted: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  modelOverrides: RuntimeModelSlotsSchema.optional().default({}),
  maxRevisionAttempts: z.number().int().min(0).max(1).optional(),
  workspaceRoot: z.string().trim().min(1).max(4_096).transform(normalizeWorkspacePath).optional(),
  enableRepositoryIntelligence: z.boolean().optional().default(true),
  codingTaskId: z.string().trim().min(1).max(220).optional(),
  autonomousCoding: z.boolean().optional().default(true),
  maxAutonomousRevisions: z.number().int().min(0).max(3).optional().default(2),
  includeExecutionReceipt: z.boolean().optional().default(true),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(8_000)).max(30).optional().default([]),
  forbiddenActions: z.array(z.string().trim().min(1).max(8_000)).max(30).optional().default([]),
});

export const RuntimeModelRoleSchema = z.enum(['host', 'worker', 'boss', 'verifier']);
export type RuntimeRunRequest = z.input<typeof RuntimeRunRequestSchema>;
export type RuntimeModelRole = z.infer<typeof RuntimeModelRoleSchema>;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ResolvedRoleConfig = {
  role: RuntimeModelRole;
  model: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  endpointUrl: string;
  transport: 'http' | 'hermes-cli';
};

export type RuntimeModelUsage = {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  accountedTokens: number;
  estimated: boolean;
  source: 'provider' | 'estimate' | 'hermes-session-delta';
  valid: boolean;
  invalidReason?: string;
  providerRequestId?: string;
};

export interface RuntimeModelResult {
  ok: boolean;
  role: RuntimeModelRole;
  model: string;
  provider: string;
  content?: string;
  parsed?: unknown;
  usage: RuntimeModelUsage;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  latencyMs: number;
  attempts: number;
  finishReason?: string;
  requestId: string;
  error?: string;
}

export type RuntimeRepositoryIntelligenceResult = {
  root: string;
  revision: string;
  fileCount: number;
  changedFiles: string[];
  configFiles: string[];
  packageScripts: string[];
  impact: ChangeImpact;
  stats: {
    scannedFiles: number;
    parsedFiles: number;
    reusedFiles: number;
    changedFiles: number;
    removedFiles: number;
    skippedLargeFiles: number;
    durationMs: number;
  };
};

export type RuntimeAutonomousCodingResult = {
  status: AutonomousCodingOutcome['status'];
  taskId: string;
  phase: CodingTaskState['currentPhase'];
  taskStatus: CodingTaskState['status'];
  filesChanged: string[];
  planSummary?: string;
  patchAttempts: number;
  tools: Array<{ tool: string; status: string; artifactId?: string }>;
  hostUpdates: string[];
  summary: string;
  error?: string;
};

export type RuntimeExecutionReceipt = {
  host: { models: string[]; calls: number };
  worker: { models: string[]; calls: number };
  verifier: { models: string[]; calls: number; verdict?: string };
  boss: { models: string[]; calls: number; verdict?: string; skipped: boolean };
  tools: Array<{ tool: string; status: string; artifactId?: string }>;
  coding?: { taskId: string; status: string; phase: string; filesChanged: string[]; summary: string };
};

export interface RuntimePipelineResult {
  ok: boolean;
  status: 'done' | 'blocked' | 'needs_input' | 'failed' | 'dry_run';
  runId: string;
  sessionId?: string;
  dryRun: boolean;
  decision: RouteDecision;
  routeEvent: RouteEvent;
  budgetPlan: TokenBudgetPlan;
  contextPackets: Partial<Record<RuntimeModelRole, RuntimeWorkPacket>>;
  memoryRecall?: { ok: boolean; skipped: boolean; latencyMs?: number; error?: string };
  repositoryIntelligence?: RuntimeRepositoryIntelligenceResult;
  codingTask?: CodingTaskState;
  autonomousCoding?: RuntimeAutonomousCodingResult;
  executionReceipt?: RuntimeExecutionReceipt;
  workerResults: WorkerResult[];
  workerResult?: WorkerResult;
  hostDraft?: string;
  hostDrafts: string[];
  verifierResult?: VerifierResult;
  verifierResults: VerifierResult[];
  bossDecision?: BossDecision;
  finalAnswer: string;
  modelCalls: RuntimeModelResult[];
  revisions: number;
  premiumTokensAvoidedEstimate: number;
  warnings: string[];
  errors: string[];
}

const OpenAIResponseSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.union([z.string(), z.null()]).optional() }).passthrough(),
    finish_reason: z.string().nullable().optional(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    }).passthrough().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().int().nonnegative().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const circuitBreakers = new Map<string, { failures: number; openUntil: number }>();

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stripJsonFence(text: string): string {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function safeJsonParse(text: string): unknown | null {
  const clean = stripJsonFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    const objectStart = clean.indexOf('{');
    const objectEnd = clean.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(clean.slice(objectStart, objectEnd + 1));
      } catch {
        // Continue to array fallback.
      }
    }
    const arrayStart = clean.indexOf('[');
    const arrayEnd = clean.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(clean.slice(arrayStart, arrayEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function builtInModelSlots(): RuntimeModelSlots {
  return RuntimeModelSlotsSchema.parse({
    hostModel: 'deepseek',
    workerModel: 'deepseek',
    bossModel: 'ag/gemini-pro-agent',
    verifierModel: 'ag/gemini-3.5-flash-low',
    hostProvider: 'etla-router',
    workerProvider: 'etla-router',
    bossProvider: 'etla-router',
    verifierProvider: 'etla-router',
  });
}

function environmentModelSlots(): RuntimeModelSlots {
  return RuntimeModelSlotsSchema.parse({
    baseUrl: process.env.ZENOS_LLM_BASE_URL || process.env.MEMORY_LLM_BASE_URL || undefined,
    apiKey: process.env.ZENOS_LLM_API_KEY || process.env.MEMORY_LLM_API_KEY || undefined,
    hostModel: process.env.ZENOS_HOST_MODEL || process.env.MEMORY_LLM_MODEL || undefined,
    workerModel: process.env.ZENOS_WORKER_MODEL || process.env.MEMORY_LLM_FALLBACK_MODEL || undefined,
    bossModel: process.env.ZENOS_BOSS_MODEL || process.env.ZENOS_HOST_MODEL || process.env.MEMORY_LLM_MODEL || undefined,
    verifierModel: process.env.ZENOS_VERIFIER_MODEL || process.env.MEMORY_LLM_FALLBACK_MODEL || undefined,
    hostProvider: process.env.ZENOS_HOST_PROVIDER || undefined,
    workerProvider: process.env.ZENOS_WORKER_PROVIDER || undefined,
    bossProvider: process.env.ZENOS_BOSS_PROVIDER || undefined,
    verifierProvider: process.env.ZENOS_VERIFIER_PROVIDER || undefined,
  });
}

export function readRuntimeOverrideConfig(): RuntimeModelSlots {
  return readRuntimeModelSlots();
}

export function resolveRuntimeModelSlots(sessionId?: string, inlineOverrides: RuntimeModelSlots = {}): RuntimeModelSlots {
  return mergeModelSlots(
    builtInModelSlots(),
    environmentModelSlots(),
    readRuntimeModelSlots(),
    readSessionModelSlots(sessionId),
    inlineOverrides,
  );
}

function endpointUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  if (lower.endsWith('/chat/completions') || lower.endsWith('/model')) return normalized;
  return `${normalized}/chat/completions`;
}

function resolveRoleConfig(role: RuntimeModelRole, sessionId?: string, inlineOverrides: RuntimeModelSlots = {}): ResolvedRoleConfig {
  const slots = resolveRuntimeModelSlots(sessionId, inlineOverrides);
  const model = modelForSlot(slots, role);
  const baseUrl = baseUrlForSlot(slots, role);
  const apiKey = apiKeyForSlot(slots, role);
  const configuredTransport = process.env.ZENOS_MODEL_TRANSPORT;
  const transport = configuredTransport === 'hermes-cli' || (!apiKey && configuredTransport !== 'http')
    ? 'hermes-cli'
    : 'http';
  return {
    role,
    model,
    provider: providerForSlot(slots, role),
    baseUrl,
    apiKey,
    endpointUrl: endpointUrl(baseUrl),
    transport,
  };
}

export function hasRuntimeModels(sessionId?: string): boolean {
  const slots = resolveRuntimeModelSlots(sessionId);
  return Boolean(
    modelForSlot(slots, 'host')
    && modelForSlot(slots, 'worker')
    && modelForSlot(slots, 'boss')
    && modelForSlot(slots, 'verifier')
    && baseUrlForSlot(slots, 'host'),
  );
}

export function getRuntimeModelConfigSummary(sessionId?: string) {
  const slots = resolveRuntimeModelSlots(sessionId);
  const safe = publicModelSlots(slots);
  return {
    ...safe,
    roles: Object.fromEntries((['host', 'worker', 'boss', 'verifier'] as RuntimeModelRole[]).map((role) => {
      const config = resolveRoleConfig(role, sessionId);
      return [role, {
        model: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        hasApiKey: Boolean(config.apiKey),
        transport: config.transport,
      }];
    })),
    sourcePriority: ['hermes', 'environment', 'global-runtime-config', 'session-runtime-config', 'inline-override'],
  };
}

function recordModelCallLifecycle(input: {
  sessionId?: string;
  requestId: string;
  role: RuntimeModelRole;
  model: string;
  provider: string;
  transport: 'http' | 'hermes-cli';
  outcome: 'started' | 'success' | 'failed';
  inputTokensEstimate: number;
  trigger?: string;
  result?: RuntimeModelResult;
}): void {
  if (!input.sessionId) return;
  try {
    const runId = input.requestId.includes(':') ? input.requestId.split(':')[0] : input.requestId;
    const usage = input.result?.usage;
    getRuntimeStore().insertEvent({
      sessionId: input.sessionId,
      workerId: `model-${input.role}-${input.requestId}`,
      type: input.outcome === 'failed' ? 'error' : input.outcome === 'success' ? 'done' : 'progress',
      summary: input.outcome === 'started'
        ? `${input.role} model ${input.model || 'unconfigured'} started.`
        : input.outcome === 'success'
          ? `${input.role} model ${input.model} completed.`
          : `${input.role} model ${input.model || 'unconfigured'} failed.`,
      evidence: [],
      severity: input.outcome === 'failed' ? 'medium' : 'low',
      confidence: input.outcome === 'failed' ? 0 : 1,
      needsBoss: false,
      metadata: {
        lifecycle: 'model_call',
        role: input.role,
        callId: input.requestId,
        runId,
        status: input.outcome === 'started' ? 'calling' : input.outcome === 'success' ? 'completed' : 'failed',
        outcome: input.outcome,
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        inputTokensEstimate: input.inputTokensEstimate,
        ...(input.trigger ? { trigger: input.trigger } : {}),
        ...(usage ? { modelUsage: usage } : {}),
        ...(input.result ? {
          latencyMs: input.result.latencyMs,
          attempts: input.result.attempts,
          finishReason: input.result.finishReason,
          error: input.result.error,
        } : {}),
      },
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Telemetry must never change model-call behavior.
  }
}

function modelUsage(
  data: z.infer<typeof OpenAIResponseSchema>,
  prompt: string,
  content: string,
  limits: { maxInputTokens: number; maxOutputTokens: number },
): RuntimeModelUsage {
  const usage = data.usage;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
  if (usage && (usage.prompt_tokens !== undefined || usage.input_tokens !== undefined || outputTokens !== undefined)) {
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens
      ?? 0;
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.cache_creation_input_tokens
      ?? 0;
    const openAiPromptTotal = usage.prompt_tokens;
    const nativeInput = usage.input_tokens;
    const inputTokens = openAiPromptTotal !== undefined
      ? Math.max(0, openAiPromptTotal - cacheReadTokens)
      : Math.max(0, nativeInput || 0);
    const logicalInput = openAiPromptTotal !== undefined
      ? Math.max(0, openAiPromptTotal)
      : inputTokens + cacheReadTokens + cacheWriteTokens;
    const output = Math.max(0, outputTokens || 0);
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
      ?? usage.reasoning_tokens
      ?? 0;
    const totalTokens = logicalInput + output;
    const accountedTokens = inputTokens + cacheWriteTokens + output;
    const maxPlausibleInput = Math.max(16_000, limits.maxInputTokens * 2 + 8_000);
    const maxPlausibleOutput = Math.max(2_048, limits.maxOutputTokens * 2 + 1_024);
    const invalidReason = logicalInput > maxPlausibleInput
      ? `provider input usage ${logicalInput} exceeds plausible cap ${maxPlausibleInput}`
      : output > maxPlausibleOutput
        ? `provider output usage ${output} exceeds plausible cap ${maxPlausibleOutput}`
        : cacheReadTokens > maxPlausibleInput * 4 || cacheWriteTokens > maxPlausibleInput * 2
          ? 'provider cache usage exceeds plausible per-call bounds'
          : undefined;
    if (!invalidReason) {
      return {
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens: output,
        reasoningTokens,
        totalTokens,
        accountedTokens,
        estimated: false,
        source: 'provider',
        valid: true,
        providerRequestId: data.id,
      };
    }
    const estimatedInput = estimateTokens(prompt);
    const estimatedOutput = estimateTokens(content);
    return {
      inputTokens: estimatedInput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: estimatedOutput,
      reasoningTokens: 0,
      totalTokens: estimatedInput + estimatedOutput,
      accountedTokens: estimatedInput + estimatedOutput,
      estimated: true,
      source: 'estimate',
      valid: false,
      invalidReason,
      providerRequestId: data.id,
    };
  }
  const input = estimateTokens(prompt);
  const output = estimateTokens(content);
  return {
    inputTokens: input,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: 0,
    totalTokens: input + output,
    accountedTokens: input + output,
    estimated: true,
    source: 'estimate',
    valid: true,
    providerRequestId: data.id,
  };
}

function circuitKey(config: ResolvedRoleConfig): string {
  return `${config.endpointUrl}|${config.model}|${config.role}`;
}

function checkCircuit(config: ResolvedRoleConfig): string | null {
  const state = circuitBreakers.get(circuitKey(config));
  if (!state) return null;
  if (state.openUntil > Date.now()) return `Model circuit is open until ${new Date(state.openUntil).toISOString()}`;
  circuitBreakers.delete(circuitKey(config));
  return null;
}

function recordCircuitSuccess(config: ResolvedRoleConfig): void {
  circuitBreakers.delete(circuitKey(config));
}

function recordCircuitFailure(config: ResolvedRoleConfig): void {
  const key = circuitKey(config);
  const current = circuitBreakers.get(key) || { failures: 0, openUntil: 0 };
  const failures = current.failures + 1;
  circuitBreakers.set(key, {
    failures,
    openUntil: failures >= 5 ? Date.now() + Math.min(120_000, 10_000 * failures) : 0,
  });
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

async function callHermesCliTransport(
  config: ResolvedRoleConfig,
  prompt: string,
  options: { timeoutMs?: number; retries?: number; requestId: string },
): Promise<RuntimeModelResult> {
  const binary = process.env.ZENOS_HERMES_CLI || '/root/.local/bin/zenos';
  const inputEstimate = estimateTokens(prompt);
  const emptyUsage: RuntimeModelUsage = {
    inputTokens: inputEstimate,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputEstimate,
    accountedTokens: inputEstimate,
    estimated: true,
    source: 'estimate',
    valid: true,
  };
  const started = Date.now();
  const maxAttempts = Math.min(Math.max((options.retries ?? 1) + 1, 1), 3);
  let lastError = 'Hermes CLI model call failed';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const provider = config.provider && config.provider !== 'default'
      ? (config.provider.startsWith('custom:') ? config.provider : `custom:${config.provider}`)
      : '';
    const args = ['-z', prompt, '-m', config.model];
    if (provider) args.push('--provider', provider);
    const timeoutMs = Math.min(Math.max(options.timeoutMs || Number(process.env.ZENOS_MODEL_TIMEOUT_MS || '90000'), 5_000), 240_000);
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, args, {
          env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let totalBytes = 0;
        const limit = 5_000_000;
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
          reject(new Error(`Hermes CLI timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          totalBytes += Buffer.byteLength(chunk);
          if (totalBytes > limit) {
            child.kill('SIGKILL');
            reject(new Error('Hermes CLI response exceeded the 5 MB safety limit'));
            return;
          }
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          totalBytes += Buffer.byteLength(chunk);
          stderr += chunk;
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Hermes CLI exited with ${signal || code}: ${redactText(stripAnsi(stderr).slice(0, 1_200))}`));
            return;
          }
          const clean = stripAnsi(stdout).trim();
          if (!clean) {
            reject(new Error(`Hermes CLI produced no output: ${redactText(stripAnsi(stderr).slice(0, 800))}`));
            return;
          }
          resolve(clean);
        });
      });
      const outputEstimate = estimateTokens(content);
      const usage: RuntimeModelUsage = {
        inputTokens: inputEstimate,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: outputEstimate,
        reasoningTokens: 0,
        totalTokens: inputEstimate + outputEstimate,
        accountedTokens: inputEstimate + outputEstimate,
        estimated: true,
        source: 'estimate',
        valid: true,
      };
      const latencyMs = observeDuration('model_call_duration', started, { role: config.role, model: config.model, transport: 'hermes-cli', ok: true });
      incrementMetric('model_calls_total', { role: config.role, model: config.model, transport: 'hermes-cli', status: 'success' });
      incrementMetric('model_tokens_total', { role: config.role, direction: 'input' }, usage.inputTokens);
      incrementMetric('model_tokens_total', { role: config.role, direction: 'output' }, usage.outputTokens);
      recordCircuitSuccess(config);
      return {
        ok: true,
        role: config.role,
        model: config.model,
        provider: config.provider,
        content,
        parsed: safeJsonParse(content),
        usage,
        inputTokensEstimate: inputEstimate,
        outputTokensEstimate: usage.outputTokens,
        latencyMs,
        attempts: attempt,
        requestId: options.requestId,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) await delay(Math.min(2_000, 300 * 2 ** (attempt - 1)));
    }
  }

  recordCircuitFailure(config);
  const latencyMs = observeDuration('model_call_duration', started, { role: config.role, model: config.model, transport: 'hermes-cli', ok: false });
  incrementMetric('model_calls_total', { role: config.role, model: config.model, transport: 'hermes-cli', status: 'failed' });
  return {
    ok: false,
    role: config.role,
    model: config.model,
    provider: config.provider,
    usage: emptyUsage,
    inputTokensEstimate: inputEstimate,
    outputTokensEstimate: 0,
    latencyMs,
    attempts: maxAttempts,
    requestId: options.requestId,
    error: redactText(lastError),
  };
}

export async function callRuntimeModel(
  role: RuntimeModelRole,
  messages: ChatMessage[],
  options: {
    json?: boolean;
    maxTokens?: number;
    timeoutMs?: number;
    retries?: number;
    temperature?: number;
    maxInputTokens?: number;
    sessionId?: string;
    modelOverrides?: RuntimeModelSlots;
    requestId?: string;
    trigger?: string;
    tokenBudgetPlan?: TokenBudgetPlan;
    mandatory?: boolean;
  } = {},
): Promise<RuntimeModelResult> {
  const config = resolveRoleConfig(role, options.sessionId, options.modelOverrides || {});
  const maxInputTokens = Math.max(128, Math.min(options.maxInputTokens || 64_000, 128_000));
  const perMessageBudget = Math.max(64, Math.floor(maxInputTokens / Math.max(1, messages.length)));
  const boundedMessages = messages.map((message) => ({
    ...message,
    content: truncateToTokenBudget(message.content, perMessageBudget),
  }));
  const prompt = boundedMessages.map((message) => `${message.role}: ${message.content}`).join('\n');
  const inputEstimate = estimateModelInputTokens(prompt, config.model);
  const requestId = options.requestId || crypto.randomUUID();
  const requestedOutputTokens = Math.min(
    Math.max(options.maxTokens || (role === 'host' ? 2_400 : 1_400), 64),
    16_000,
  );
  const started = Date.now();
  const emptyUsage: RuntimeModelUsage = {
    inputTokens: inputEstimate,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputEstimate,
    accountedTokens: inputEstimate,
    estimated: true,
    source: 'estimate',
    valid: true,
  };
  let governorAuthorized = false;
  if (options.tokenBudgetPlan) {
    const authorization = authorizeTokenSpend({
      plan: options.tokenBudgetPlan,
      requestId,
      role,
      estimatedTokens: inputEstimate + requestedOutputTokens,
      mandatory: options.mandatory,
    });
    if (!authorization.allowed) {
      incrementMetric('model_calls_total', { role, model: config.model, status: 'budget_denied' });
      return {
        ok: false,
        role,
        model: config.model,
        provider: config.provider,
        usage: { ...emptyUsage, inputTokens: 0, totalTokens: 0, accountedTokens: 0 },
        inputTokensEstimate: inputEstimate,
        outputTokensEstimate: 0,
        latencyMs: 0,
        attempts: 0,
        requestId,
        error: authorization.reason || 'Global token budget denied the model call',
      };
    }
    governorAuthorized = true;
  }
  recordModelCallLifecycle({
    sessionId: options.sessionId,
    requestId,
    role,
    model: config.model,
    provider: config.provider,
    transport: config.transport,
    outcome: 'started',
    inputTokensEstimate: inputEstimate,
    trigger: options.trigger,
  });
  const finalize = (result: RuntimeModelResult): RuntimeModelResult => {
    if (result.attempts > 0 && !result.usage.estimated && result.usage.valid) {
      recordTokenEstimateCalibration(
        inputEstimate,
        result.usage.inputTokens + (result.usage.cacheReadTokens || 0) + (result.usage.cacheWriteTokens || 0),
        config.model,
      );
    }
    if (options.tokenBudgetPlan && governorAuthorized) {
      settleTokenSpend({
        plan: options.tokenBudgetPlan,
        requestId,
        role,
        actualTokens: result.attempts > 0 ? result.usage.accountedTokens : 0,
        attempted: result.attempts > 0,
        usageValid: result.usage.valid,
        invalidReason: result.usage.invalidReason,
      });
    }
    recordModelCallLifecycle({
      sessionId: options.sessionId,
      requestId,
      role,
      model: config.model,
      provider: config.provider,
      transport: config.transport,
      outcome: result.ok ? 'success' : 'failed',
      inputTokensEstimate: inputEstimate,
      trigger: options.trigger,
      result,
    });
    return result;
  };

  if (!config.model || (config.transport === 'http' && !config.endpointUrl)) {
    return finalize({
      ok: false,
      role,
      model: config.model,
      provider: config.provider,
      usage: emptyUsage,
      inputTokensEstimate: inputEstimate,
      outputTokensEstimate: 0,
      latencyMs: 0,
      attempts: 0,
      requestId,
      error: `Model role ${role} is not fully configured`,
    });
  }

  const circuitError = checkCircuit(config);
  if (circuitError) {
    return finalize({
      ok: false,
      role,
      model: config.model,
      provider: config.provider,
      usage: emptyUsage,
      inputTokensEstimate: inputEstimate,
      outputTokensEstimate: 0,
      latencyMs: 0,
      attempts: 0,
      requestId,
      error: circuitError,
    });
  }

  if (config.transport === 'hermes-cli') {
    const cliPrompt = [
      options.json ? 'Return only valid JSON. Do not wrap it in markdown fences.' : '',
      prompt,
    ].filter(Boolean).join('\n\n');
    return finalize(await callHermesCliTransport(config, cliPrompt, {
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
      requestId,
    }));
  }

  const maxAttempts = Math.min(Math.max((options.retries ?? 0) + 1, 1), 2);
  let lastError = 'Unknown model error';
  let useJsonFormat = Boolean(options.json);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = Math.min(Math.max(options.timeoutMs || Number(process.env.ZENOS_MODEL_TIMEOUT_MS || '90000'), 5_000), 240_000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetch(config.endpointUrl, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          messages: boundedMessages,
          temperature: options.temperature ?? (role === 'host' ? 0.2 : role === 'boss' ? 0.1 : 0.05),
          max_tokens: requestedOutputTokens,
          stream: false,
          ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const raw = await response.text();
      if (raw.length > 5_000_000) throw new Error('Model response exceeded the 5 MB safety limit');
      if (!response.ok) {
        const safeError = redactText(raw.slice(0, 1_200));
        lastError = `HTTP ${response.status}: ${safeError}`;
        if (response.status === 400 && useJsonFormat && /response_format|json/i.test(raw)) {
          useJsonFormat = false;
          continue;
        }
        if (attempt < maxAttempts && retryableStatus(response.status)) {
          await delay(Math.min(4_000, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200)));
          continue;
        }
        recordCircuitFailure(config);
        break;
      }

      let rawData: unknown;
      try {
        rawData = JSON.parse(raw);
      } catch {
        throw new Error(`Model returned non-JSON transport response: ${redactText(raw.slice(0, 500))}`);
      }
      const parsedTransport = OpenAIResponseSchema.safeParse(rawData);
      if (!parsedTransport.success) throw new Error('Model response did not match the OpenAI-compatible response contract');
      const content = parsedTransport.data.choices[0]?.message.content || '';
      if (!content.trim()) throw new Error('Model response contained no assistant content');
      const usage = modelUsage(parsedTransport.data, prompt, content, {
        maxInputTokens,
        maxOutputTokens: requestedOutputTokens,
      });
      if (!usage.valid) {
        incrementMetric('runtime_usage_anomaly_total', { role, model: config.model, source: usage.source });
        log('warn', 'Rejected implausible provider token usage', {
          role,
          model: config.model,
          requestId,
          providerRequestId: usage.providerRequestId,
          reason: usage.invalidReason,
        });
      }
      const latencyMs = observeDuration('model_call_duration', started, { role, model: config.model, ok: true });
      incrementMetric('model_calls_total', { role, model: config.model, status: 'success' });
      incrementMetric('model_tokens_total', { role, direction: 'input' }, usage.inputTokens);
      incrementMetric('model_tokens_total', { role, direction: 'output' }, usage.outputTokens);
      recordCircuitSuccess(config);
      return finalize({
        ok: true,
        role,
        model: config.model,
        provider: config.provider,
        content,
        parsed: safeJsonParse(content),
        usage,
        inputTokensEstimate: inputEstimate,
        outputTokensEstimate: estimateTokens(content),
        latencyMs,
        attempts: attempt,
        finishReason: parsedTransport.data.choices[0]?.finish_reason || undefined,
        requestId,
      });
    } catch (error) {
      lastError = error instanceof Error
        ? error.name === 'AbortError' ? `Model request timed out after ${options.timeoutMs || process.env.ZENOS_MODEL_TIMEOUT_MS || '90000'} ms` : error.message
        : String(error);
      if (attempt < maxAttempts) {
        await delay(Math.min(4_000, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200)));
        continue;
      }
      recordCircuitFailure(config);
    } finally {
      clearTimeout(timeout);
    }
  }

  const latencyMs = observeDuration('model_call_duration', started, { role, model: config.model, ok: false });
  incrementMetric('model_calls_total', { role, model: config.model, status: 'failed' });
  log('warn', 'Runtime model call failed', { requestId, role, model: config.model, provider: config.provider, error: lastError });
  return finalize({
    ok: false,
    role,
    model: config.model,
    provider: config.provider,
    usage: emptyUsage,
    inputTokensEstimate: inputEstimate,
    outputTokensEstimate: 0,
    latencyMs,
    attempts: maxAttempts,
    requestId,
    error: redactText(lastError),
  });
}

export async function runBossReviewModel(
  packet: unknown,
  options: {
    sessionId?: string;
    modelOverrides?: RuntimeModelSlots;
    requestId?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    trigger?: string;
    tokenBudgetPlan?: TokenBudgetPlan;
    mandatory?: boolean;
  } = {},
): Promise<RuntimeModelResult> {
  return callRuntimeModel('boss', [
    {
      role: 'system',
      content: `You are the premium Zenos Boss. You receive a compact escalation packet, not raw context.
Judge risk, evidence, unresolved ambiguity, and allowed actions. Do not rubber-stamp critical actions.
Return ONLY JSON: {"verdict":"approve|revise|block|ask_user|delegate","confidence":0.0,"reasoningSummary":"...","requiredChanges":["..."],"allowedActions":["..."],"forbiddenActions":["..."]}`,
    },
    { role: 'user', content: JSON.stringify(packet, null, 2) },
  ], { json: true, maxTokens: options.maxOutputTokens || 500, maxInputTokens: options.maxInputTokens || 1_500, ...options });
}

export async function runWorkerCompression(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  chunk?: string,
  options: {
    pass?: number;
    totalPasses?: number;
    requestId?: string;
    packet?: RuntimeWorkPacket;
    budget?: TokenBudgetPlan;
    delegationTask?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
  } = {},
): Promise<{ result?: WorkerResult; call: RuntimeModelResult }> {
  const sourceContext = options.packet ? renderRolePacket(options.packet) : (chunk ?? compactSourceContext(input));
  const budget = options.budget ? roleBudget(options.budget, 'worker') : undefined;
  const call = await callRuntimeModel('worker', [
    {
      role: 'system',
      content: `You are a bounded Zenos Worker. Extract and compress evidence so the Host can make a better decision with fewer tokens.
Never invent evidence. Separate facts, contradictions, unknowns, and required raw context.
Return ONLY JSON matching:
{"task":"...","summary":["..."],"findings":[{"claim":"...","evidence":["file/url/line or source label"],"confidence":0.0,"risk":"low|medium|high|critical"}],"contradictions":["..."],"unknowns":["..."],"suggestedNextStep":"...","needsHostAttention":["..."],"rawContextNeeded":["..."],"sourceCoverage":0.0}`,
    },
    {
      role: 'user',
      content: `Worker pass ${options.pass || 1}/${options.totalPasses || 1}\nUser request:\n${input.request}\n\nHost delegation:\n${options.delegationTask || 'Extract the evidence the Host needs to answer safely and accurately.'}\n\nAcceptance criteria:\n${(options.acceptanceCriteria || []).map((item) => `- ${item}`).join('\n') || '- Preserve material evidence and uncertainty.'}\n\nConstraints:\n${(options.constraints || []).map((item) => `- ${item}`).join('\n') || '- Do not make the final user-facing decision.'}\n\nBounded source context:\n${sourceContext || '(no source context supplied)'}`,
    },
  ], {
    json: true,
    maxTokens: budget?.outputTokens || 1_600,
    maxInputTokens: budget?.inputTokens || 8_000,
    sessionId: input.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: options.requestId,
    trigger: 'host_delegation',
    tokenBudgetPlan: options.budget,
  });
  if (!call.ok || !call.parsed) return { call };
  try {
    return { call, result: validateWorkerResult(call.parsed) };
  } catch (error) {
    return { call: { ...call, ok: false, error: error instanceof Error ? error.message : 'Worker output failed validation' } };
  }
}

export async function runHostSynthesis(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  decision: RouteDecision,
  workerResult?: WorkerResult,
  options: { requestId?: string; packet?: RuntimeWorkPacket; budget?: TokenBudgetPlan } = {},
): Promise<RuntimeModelResult> {
  const sourceContext = compactSourceContext(input);
  const workerBlock = workerResult ? JSON.stringify(workerResult, null, 2) : '';
  const focusedContext = options.packet ? renderRolePacket(options.packet) : (workerBlock || sourceContext.slice(0, decision.maxContextTokens * 4));
  const budget = options.budget ? roleBudget(options.budget, 'host') : undefined;
  const sourceWarning = decision.requiresSourceContext && !input.toolContext.trim() && !input.context.trim()
    ? 'Required source/tool context was not supplied. Do not claim that files, logs, tests, or current external facts were inspected.'
    : '';
  return callRuntimeModel('host', [
    {
      role: 'system',
      content: `You are the Zenos Host: the user-facing supervisor and final synthesizer.
Use evidence from workers and supplied context. Never pretend to have used tools or inspected sources that are absent.
For risky actions, provide a safe decision or plan rather than implying execution. State material uncertainty directly.
${sourceWarning}`,
    },
    {
      role: 'user',
      content: `User request:\n${input.request}\n\nRoute decision:\n${JSON.stringify(decision)}\n\nDecision-grade context:\n${focusedContext || '(none supplied)'}`,
    },
  ], {
    maxTokens: budget?.outputTokens || 2_400,
    maxInputTokens: budget?.inputTokens || decision.maxContextTokens,
    sessionId: input.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: options.requestId,
    tokenBudgetPlan: options.budget,
    mandatory: true,
  });
}

export async function runHostRevision(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  draft: string,
  instructions: string[],
  workerResult?: WorkerResult,
  options: { requestId?: string; budget?: TokenBudgetPlan; relevantEvidence?: string[] } = {},
): Promise<RuntimeModelResult> {
  const budget = options.budget ? roleBudget(options.budget, 'host') : undefined;
  const deltaContext = buildDeltaRevisionContext({
    request: input.request,
    previousCandidate: draft,
    failedChecks: instructions,
    relevantEvidence: options.relevantEvidence,
    requiredChanges: instructions,
    maxTokens: budget?.inputTokens || 5_000,
  });
  return callRuntimeModel('host', [
    {
      role: 'system',
      content: `You are the Zenos Host revising a draft after an independent quality gate.
Apply every required change that is supported. Remove unsupported claims. Do not mention this internal revision process unless necessary to answer the user.`,
    },
    {
      role: 'user',
      content: `${deltaContext}\n\nWorker evidence summary:\n${workerResult ? truncateToTokenBudget(JSON.stringify(workerResult), 1_200) : '(none)'}`,
    },
  ], {
    maxTokens: budget?.outputTokens || 2_400,
    maxInputTokens: budget?.inputTokens || 5_000,
    sessionId: input.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: options.requestId,
    tokenBudgetPlan: options.budget,
    mandatory: true,
  });
}

function mandatoryVerifierFallback(reason: string): VerifierResult {
  return validateVerifierResult({
    verdict: 'escalate',
    confidence: 0.35,
    issues: [{
      severity: 'high',
      issue: 'The mandatory model verifier was unavailable or returned an invalid structured verdict.',
      evidence: redactText(reason).slice(0, 2_000),
      requiredFix: 'Escalate to the Boss authority or fail closed; do not silently release the unverified draft.',
    }],
    checks: {
      followsUserRequest: 'unknown',
      sourceGrounded: 'fail',
      secretSafe: 'unknown',
      actionSafe: 'fail',
      testsOrValidation: 'fail',
    },
    nextAction: 'escalate',
  });
}

export async function runVerifier(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  draft: string,
  workerResult?: WorkerResult,
  options: { requestId?: string; packet?: RuntimeWorkPacket; budget?: TokenBudgetPlan; mandatory?: boolean } = {},
): Promise<{ result?: VerifierResult; call: RuntimeModelResult }> {
  const budget = options.budget ? roleBudget(options.budget, 'verifier') : undefined;
  const verificationContext = options.packet ? renderRolePacket(options.packet) : compactSourceContext(input).slice(0, 8_000);
  const call = await callRuntimeModel('verifier', [
    {
      role: 'system',
      content: `You are the independent Zenos Verifier. Check the draft against the user's request, supplied evidence, secret safety, action safety, and validation claims.
A revise verdict must include concrete requiredFix items. Escalate only when premium judgment is necessary. Block only for material unsafe or unsupported output.
Return ONLY JSON:
{"verdict":"pass|revise|escalate|block","confidence":0.0,"issues":[{"severity":"low|medium|high|critical","issue":"...","evidence":"...","requiredFix":"..."}],"checks":{"followsUserRequest":"pass|fail|unknown","sourceGrounded":"pass|fail|not_applicable","secretSafe":"pass|fail|unknown","actionSafe":"pass|fail|not_applicable","testsOrValidation":"pass|fail|not_applicable"},"nextAction":"answer|revise|ask_user|escalate|block"}`,
    },
    {
      role: 'user',
      content: `User request:\n${input.request}\n\nDraft answer/action:\n${draft}\n\nWorker evidence brief:\n${workerResult ? truncateToTokenBudget(JSON.stringify(workerResult), 1_200) : '(none)'}\n\nVerifier packet:\n${verificationContext || '(none)'}`,
    },
  ], {
    json: true,
    maxTokens: budget?.outputTokens || 1_200,
    maxInputTokens: budget?.inputTokens || 5_000,
    sessionId: input.sessionId,
    modelOverrides: input.modelOverrides,
    requestId: options.requestId,
    tokenBudgetPlan: options.budget,
    mandatory: options.mandatory,
  });
  if (!call.ok || !call.parsed) {
    const failedCall = call.ok
      ? { ...call, ok: false, error: 'Verifier returned no parseable structured content' }
      : call;
    return options.mandatory
      ? { call: failedCall, result: mandatoryVerifierFallback(failedCall.error || 'Verifier returned no structured content') }
      : { call: failedCall };
  }
  try {
    return { call, result: validateVerifierResult(call.parsed) };
  } catch (error) {
    const failedCall = {
      ...call,
      ok: false,
      error: error instanceof Error ? error.message : 'Verifier output failed validation',
    };
    return options.mandatory
      ? { call: failedCall, result: mandatoryVerifierFallback(failedCall.error) }
      : { call: failedCall };
  }
}

function actualTokenTotals(calls: RuntimeModelResult[]): { input: number; output: number } {
  return calls.reduce((totals, call) => ({
    input: totals.input + call.usage.inputTokens,
    output: totals.output + call.usage.outputTokens,
  }), { input: 0, output: 0 });
}

function requestHash(input: z.infer<typeof RuntimeRunRequestSchema>): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    request: input.request,
    context: input.context,
    memoryContext: input.memoryContext,
    toolContext: input.toolContext,
    intent: input.intent,
    sessionId: input.sessionId,
  })).digest('hex');
}

function outputBucket(answer: string): RouteEvent['outputSizeBucket'] {
  const tokens = estimateTokens(answer);
  if (tokens < 500) return 'small';
  if (tokens < 1_500) return 'medium';
  return 'large';
}

function compactAutonomousCoding(outcome: AutonomousCodingOutcome): RuntimeAutonomousCodingResult {
  return {
    status: outcome.status,
    taskId: outcome.task.taskId,
    phase: outcome.task.currentPhase,
    taskStatus: outcome.task.status,
    filesChanged: outcome.task.filesChanged,
    planSummary: outcome.plan?.summary,
    patchAttempts: outcome.patches.length,
    tools: outcome.toolEvidence.map((item) => ({
      tool: item.tool,
      status: item.status,
      artifactId: item.artifactId,
    })),
    hostUpdates: outcome.hostUpdates,
    summary: outcome.summary,
    error: outcome.error,
  };
}

function buildExecutionReceipt(input: {
  calls: RuntimeModelResult[];
  verifier?: VerifierResult;
  boss?: BossDecision;
  autonomous?: AutonomousCodingOutcome;
}): RuntimeExecutionReceipt {
  const role = (name: RuntimeModelRole) => {
    const calls = input.calls.filter((call) => call.role === name);
    return {
      models: [...new Set(calls.map((call) => call.model).filter(Boolean))],
      calls: calls.length,
    };
  };
  const host = role('host');
  const worker = role('worker');
  const verifier = role('verifier');
  const boss = role('boss');
  return {
    host,
    worker,
    verifier: { ...verifier, verdict: input.verifier?.verdict },
    boss: { ...boss, verdict: input.boss?.verdict, skipped: boss.calls === 0 },
    tools: input.autonomous?.toolEvidence.map((item) => ({
      tool: item.tool,
      status: item.status,
      artifactId: item.artifactId,
    })) || [],
    coding: input.autonomous ? {
      taskId: input.autonomous.task.taskId,
      status: input.autonomous.status,
      phase: input.autonomous.task.currentPhase,
      filesChanged: input.autonomous.task.filesChanged,
      summary: input.autonomous.summary,
    } : undefined,
  };
}

function recordPipelineActivity(
  sessionId: string | undefined,
  role: RuntimeModelRole | 'tool',
  summary: string,
  metadata: Record<string, unknown> = {},
  type: 'progress' | 'tool_result' | 'done' | 'error' = 'progress',
): void {
  if (!sessionId) return;
  try {
    const { usage, ...eventMetadata } = metadata;
    recordWorkerEvent({
      sessionId,
      workerId: `runtime-${role}`,
      type: type === 'error' ? 'progress' : type,
      summary,
      evidence: [],
      severity: 'low',
      confidence: 1,
      needsBoss: false,
      metadata: { role, outcome: type, ...eventMetadata, ...(usage ? { modelUsage: usage } : {}) },
    });
  } catch {
    // Monitoring must not change the execution result.
  }
}

function renderExecutionReceipt(receipt: RuntimeExecutionReceipt): string {
  const roleLine = (label: string, value: { models: string[]; calls: number }) =>
    `- ${label}: ${value.calls ? `${value.models.join(', ') || 'configured model'} · ${value.calls} call(s)` : 'not invoked'}`;
  const toolCounts = new Map<string, { total: number; statuses: Set<string> }>();
  for (const item of receipt.tools) {
    const current = toolCounts.get(item.tool) || { total: 0, statuses: new Set<string>() };
    current.total += 1;
    current.statuses.add(item.status);
    toolCounts.set(item.tool, current);
  }
  const toolLine = toolCounts.size
    ? [...toolCounts.entries()].map(([tool, value]) => `${tool}×${value.total} [${[...value.statuses].join('/')}]`).join(', ')
    : 'none recorded';
  const coding = receipt.coding
    ? `- Coding task: ${receipt.coding.status} · phase ${receipt.coding.phase} · ${receipt.coding.filesChanged.length} file(s) changed\n- Coding evidence: ${receipt.coding.summary}`
    : '- Coding task: not applicable';
  return [
    '### Runtime execution receipt',
    roleLine('Host', receipt.host),
    roleLine('Worker', receipt.worker),
    `- Verifier: ${receipt.verifier.calls ? `${receipt.verifier.models.join(', ')} · ${receipt.verifier.verdict || 'completed'}` : 'not invoked'}`,
    `- Boss: ${receipt.boss.skipped ? 'not invoked (not required)' : `${receipt.boss.models.join(', ')} · ${receipt.boss.verdict || 'completed'}`}`,
    `- Tools: ${toolLine}`,
    coding,
  ].join('\n');
}

function createEscalationPacketWithoutSession(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  runId: string,
  draft: string,
  workerResult: WorkerResult | undefined,
  verifier: VerifierResult | undefined,
  decision: RouteDecision,
): EscalationPacket {
  return {
    runId,
    userGoal: input.request,
    hostAssessment: verifier?.issues.map((issue) => issue.issue).join('; ') || `Route risk is ${decision.risk}.`,
    currentDraft: draft,
    decisionNeeded: 'approve',
    workerFindings: workerResult?.findings || [],
    verifierIssues: verifier?.issues || [],
    conflicts: workerResult?.contradictions || [],
    unknowns: workerResult?.unknowns || [],
    triggeringEvents: [],
    budget: {
      maxPremiumTokens: 10_000,
      maxHostTokens: decision.maxContextTokens,
      maxWorkerTokens: 30_000,
      maxModelCalls: 8,
      premiumTokensUsed: 0,
      hostTokensUsed: 0,
      workerTokensUsed: 0,
      verifierTokensUsed: 0,
      modelCallsUsed: 0,
      estimatedPremiumTokensAvoided: 0,
    },
  };
}

function updateSessionBudget(sessionId: string | undefined, calls: RuntimeModelResult[], premiumAvoided: number): void {
  if (!sessionId) return;
  const session = getRuntimeSession(sessionId);
  if (!session) return;
  const byRole = (role: RuntimeModelRole) => calls.filter((call) => call.role === role).reduce((sum, call) => sum + call.usage.totalTokens, 0);
  updateRuntimeSession(sessionId, {
    budget: {
      ...session.budget,
      premiumTokensUsed: session.budget.premiumTokensUsed + byRole('boss'),
      hostTokensUsed: session.budget.hostTokensUsed + byRole('host'),
      workerTokensUsed: session.budget.workerTokensUsed + byRole('worker'),
      verifierTokensUsed: session.budget.verifierTokensUsed + byRole('verifier'),
      modelCallsUsed: session.budget.modelCallsUsed + calls.length,
      estimatedPremiumTokensAvoided: session.budget.estimatedPremiumTokensAvoided + premiumAvoided,
    },
  });
}

function recordNativePipelineOutcome(input: {
  runId: string;
  sessionId?: string;
  request: string;
  decision: RouteDecision;
  status: 'done' | 'blocked' | 'failed';
  revisions: number;
  calls: RuntimeModelResult[];
  totalDurationMs: number;
  memoryRecall?: RuntimePipelineResult['memoryRecall'];
  repositoryIntelligence?: RuntimeRepositoryIntelligenceResult;
  workerResult?: WorkerResult;
  verifierResult?: VerifierResult;
  bossDecision?: BossDecision;
  memoryContext: string;
}): void {
  const plan = createLatencyBudgetPlan(input.decision);
  const observations: LatencyObservation[] = [];
  const roleBudget = {
    host: plan.hostMs,
    worker: plan.workerMs,
    verifier: plan.verifierMs,
    boss: plan.bossMs,
  } as const;
  for (const role of ['host', 'worker', 'verifier', 'boss'] as const) {
    const durationMs = input.calls
      .filter((call) => call.role === role)
      .reduce((sum, call) => sum + Math.max(0, call.latencyMs || 0), 0);
    if (durationMs > 0) observations.push(observeLatency(role, durationMs, roleBudget[role]));
  }
  if (input.memoryRecall?.latencyMs !== undefined) {
    observations.push(observeLatency('memory', input.memoryRecall.latencyMs, plan.memoryMs));
  }
  if (input.repositoryIntelligence?.stats.durationMs !== undefined) {
    observations.push(observeLatency('repository', input.repositoryIntelligence.stats.durationMs, plan.repositoryMs));
  }
  observations.push(observeLatency('total', input.totalDurationMs, plan.totalMs));

  recordOutcomePassport({
    runId: input.runId,
    sessionId: input.sessionId,
    request: input.request,
    decision: input.decision,
    verdict: input.status === 'blocked'
      ? 'blocked'
      : input.status === 'failed'
        ? 'failed'
        : input.revisions > 0
          ? 'revised'
          : 'success',
    transformed: input.revisions > 0,
    calls: input.calls,
    latencyObservations: observations,
    verifierVerdict: input.verifierResult?.verdict,
    verifierConfidence: input.verifierResult?.confidence,
    bossVerdict: input.bossDecision?.verdict,
    bossConfidence: input.bossDecision?.confidence,
    evidenceCoverage: input.workerResult?.sourceCoverage,
    memorySource: input.memoryRecall?.ok
      ? 'recall'
      : input.memoryContext.trim()
        ? 'supplied'
        : 'none',
  });
}

export async function executeManagedWorker(input: {
  sessionId: string;
  workerId: string;
  context?: string;
  requestId?: string;
}): Promise<{ ok: boolean; worker?: WorkerResult; call: RuntimeModelResult }> {
  const session = getRuntimeSession(input.sessionId);
  if (!session) throw new Error('Runtime session not found');
  const lease = session.workers.find((worker) => worker.workerId === input.workerId);
  if (!lease) throw new Error('Runtime worker not found');
  const template = workerTemplates[lease.template as WorkerTemplateName];
  if (!template) throw new Error(`Unknown worker template: ${lease.template}`);
  updateWorkerLease(input.sessionId, input.workerId, { status: 'running', attempts: lease.attempts + 1, error: undefined });
  const call = await callRuntimeModel('worker', [
    {
      role: 'system',
      content: `You are a managed Zenos Worker using template ${lease.template}: ${template.description}
Return only the standard WorkerResult JSON contract. Evidence is mandatory for factual findings.`,
    },
    { role: 'user', content: `Task:\n${lease.task}\n\nContext:\n${input.context || session.userGoal}` },
  ], {
    json: true,
    maxTokens: Math.min(lease.maxTokens, 3_000),
    sessionId: input.sessionId,
    requestId: input.requestId,
  });
  if (!call.ok || !call.parsed) {
    updateWorkerLease(input.sessionId, input.workerId, { status: 'failed', error: call.error || 'Worker call failed' });
    recordWorkerEvent({
      sessionId: input.sessionId,
      workerId: input.workerId,
      type: 'error',
      summary: call.error || 'Managed worker failed.',
      evidence: [],
      severity: 'medium',
      confidence: 1,
      needsBoss: false,
      metadata: { model: call.model },
    });
    return { ok: false, call };
  }
  try {
    const worker = validateWorkerResult(call.parsed);
    updateWorkerLease(input.sessionId, input.workerId, { status: 'done', result: worker, error: undefined });
    for (const finding of worker.findings) {
      recordWorkerEvent({
        sessionId: input.sessionId,
        workerId: input.workerId,
        type: finding.risk === 'high' || finding.risk === 'critical' ? 'risk' : 'finding',
        summary: finding.claim,
        evidence: finding.evidence,
        severity: finding.risk,
        confidence: finding.confidence,
        needsBoss: finding.risk === 'critical',
        metadata: {},
      });
    }
    recordWorkerEvent({
      sessionId: input.sessionId,
      workerId: input.workerId,
      type: 'done',
      summary: worker.summary.join(' ').slice(0, 8_000),
      evidence: worker.findings.flatMap((finding) => finding.evidence).slice(0, 20),
      severity: 'low',
      confidence: worker.sourceCoverage,
      needsBoss: false,
      metadata: { model: call.model, usage: call.usage },
    });
    return { ok: true, worker, call };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Managed worker output failed validation';
    updateWorkerLease(input.sessionId, input.workerId, { status: 'failed', error: message });
    recordWorkerEvent({
      sessionId: input.sessionId,
      workerId: input.workerId,
      type: 'error',
      summary: message,
      evidence: [],
      severity: 'medium',
      confidence: 1,
      needsBoss: false,
      metadata: { model: call.model },
    });
    return { ok: false, call: { ...call, ok: false, error: message } };
  }
}

export async function runZenosPipeline(request: RuntimeRunRequest): Promise<RuntimePipelineResult> {
  const input = RuntimeRunRequestSchema.parse(request);
  const started = Date.now();
  const runId = `run_${crypto.randomUUID()}`;
  const decision = choosePipeline(input);
  const budgetPlan = createTokenBudgetPlan(decision, input, {
    userPriority: input.tokenPriority,
    budgetId: runId,
  });
  const contextPackets: Partial<Record<RuntimeModelRole, RuntimeWorkPacket>> = {};
  const modelCalls: RuntimeModelResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const workerResults: WorkerResult[] = [];
  const hostDrafts: string[] = [];
  const verifierResults: VerifierResult[] = [];
  let bossDecision: BossDecision | undefined;
  let memoryRecall: RuntimePipelineResult['memoryRecall'];
  let repositoryIntelligence: RuntimeRepositoryIntelligenceResult | undefined;
  let codingTask: CodingTaskState | undefined;
  let autonomousOutcome: AutonomousCodingOutcome | undefined;
  let revisions = 0;
  let sessionId = input.sessionId;

  if (input.persistSession) {
    if (!sessionId) {
      const session = createRuntimeSession(input, { modelOverrides: input.modelOverrides, metadata: { createdBy: 'runtime-run', runId } });
      sessionId = session.sessionId;
      input.sessionId = sessionId;
    } else if (!getRuntimeSession(sessionId)) {
      createRuntimeSession(input, { sessionId, modelOverrides: input.modelOverrides, metadata: { createdBy: 'runtime-run', runId } });
    }
    updateRuntimeSession(sessionId, { status: 'working', activeRunId: runId });
    recordPipelineActivity(sessionId, 'host', `Host started run ${runId} on the ${decision.pipelineMode} pipeline.`, {
      runId,
      taskType: decision.taskType,
      risk: decision.risk,
    });
  }

  const store = getRuntimeStore();
  store.saveRun({
    runId,
    sessionId,
    requestHash: requestHash(input),
    status: input.dryRun ? 'queued' : 'running',
    decision,
    errors: [],
    startedAt: new Date().toISOString(),
  });

  let routeEvent = buildRouteEvent(decision, input);
  if (input.dryRun) {
    const estimate = estimateRouteTokens(decision, input);
    const result: RuntimePipelineResult = {
      ok: true,
      status: 'dry_run',
      runId,
      sessionId,
      dryRun: true,
      decision,
      routeEvent,
      budgetPlan,
      contextPackets,
      workerResults: [],
      hostDrafts: [],
      verifierResults: [],
      finalAnswer: 'Dry run only: route decision generated without model calls.',
      modelCalls: [],
      revisions: 0,
      premiumTokensAvoidedEstimate: decision.useWorker ? Math.max(0, estimate.premiumInputTokens - 1_200) : 0,
      warnings,
      errors,
    };
    store.saveRun({ runId, sessionId, requestHash: requestHash(input), status: 'done', decision, result, errors: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    if (sessionId) completeRuntimeSession(sessionId, result.finalAnswer);
    return result;
  }

  try {
    if (decision.useMemory && input.autoRecallMemory && !input.memoryContext.trim()) {
      const recalled = await recallMemoryContext({ query: input.request, namespace: input.namespace, limit: decision.maxMemoryItems });
      memoryRecall = { ok: recalled.ok, skipped: recalled.skipped, latencyMs: recalled.latencyMs, error: recalled.error };
      if (recalled.ok && recalled.value) input.memoryContext = recalled.value;
      else if (!recalled.skipped) warnings.push(`Memory recall unavailable: ${recalled.error || 'unknown error'}`);
    }

    if (decision.useTools && input.enableRepositoryIntelligence && input.workspaceRoot) {
      if (decision.taskType === 'coding_change' || decision.taskType === 'debugging') {
        const prepared = await prepareCodexExecution({
          taskId: input.codingTaskId,
          runId,
          sessionId,
          request: input.request,
          workspaceRoot: input.workspaceRoot,
          acceptanceCriteria: input.acceptanceCriteria,
          forbiddenActions: input.forbiddenActions,
        });
        codingTask = prepared.state;
        repositoryIntelligence = {
          root: prepared.repository.root,
          revision: prepared.repository.revision,
          fileCount: prepared.repository.files.length,
          changedFiles: prepared.repository.git.changedFiles,
          configFiles: prepared.repository.configFiles,
          packageScripts: Object.keys(prepared.repository.packageScripts).sort(),
          impact: prepared.impact,
          stats: prepared.repository.stats,
        };
        input.toolContext = [input.toolContext, prepared.context].filter(Boolean).join('\n\n');
        warnings.push(`Prepared Codex execution task ${prepared.state.taskId} at phase ${prepared.state.currentPhase}.`);
        if (input.autonomousCoding) {
          autonomousOutcome = await runAutonomousCodingLoop({
            prepared,
            approvalGranted: input.approvalGranted,
            maxRevisions: Math.min(
              input.maxAutonomousRevisions,
              Math.max(0, budgetPlan.worker.maxCalls - 2),
            ),
            requestIdPrefix: runId,
            invokeModel: async ({ stage, system, user, maxTokens, requestId }) => callRuntimeModel('worker', [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ], {
              json: true,
              maxTokens: Math.min(maxTokens, budgetPlan.worker.outputTokens),
              maxInputTokens: budgetPlan.worker.inputTokens,
              timeoutMs: budgetPlan.worker.timeoutMs,
              retries: budgetPlan.worker.maxRetries,
              sessionId,
              modelOverrides: input.modelOverrides,
              requestId,
              temperature: stage === 'plan' ? 0.15 : 0.05,
            }),
          });
          modelCalls.push(...autonomousOutcome.modelCalls);
          codingTask = autonomousOutcome.task;
          input.toolContext = [
            input.toolContext,
            `Autonomous coding outcome:\n${JSON.stringify(compactAutonomousCoding(autonomousOutcome), null, 2)}`,
          ].filter(Boolean).join('\n\n');
          warnings.push(`Autonomous coding loop: ${autonomousOutcome.status} — ${autonomousOutcome.summary}`);
        }
      } else {
        const repository = await buildRepositoryIndex(input.workspaceRoot);
        const impact = analyzeChangeImpact(repository);
        repositoryIntelligence = {
          root: repository.root,
          revision: repository.revision,
          fileCount: repository.files.length,
          changedFiles: repository.git.changedFiles,
          configFiles: repository.configFiles,
          packageScripts: Object.keys(repository.packageScripts).sort(),
          impact,
          stats: repository.stats,
        };
        input.toolContext = [input.toolContext, renderRepositoryContext(repository, impact)].filter(Boolean).join('\n\n');
      }
    }

    if (decision.requiresSourceContext && !input.toolContext.trim() && !input.context.trim()) {
      warnings.push('The route requires source/tool context, but none was supplied. The Host was instructed not to claim inspection.');
    }

    const skillSelections = createDefaultSkillRegistry().select({
      request: input.request,
      taskType: decision.taskType,
      role: 'worker',
      limit: 3,
    });
    const selectedProcedure = skillSelections.flatMap((selection) => selection.skill.steps).slice(0, 16);
    if (skillSelections.length) {
      warnings.push(`Selected Runtime skills: ${skillSelections.map((selection) => `${selection.skill.id}@${selection.skill.version}`).join(', ')}.`);
    }

    if (decision.useWorker && !autonomousOutcome) {
      const chunks = splitRoleContext(compactSourceContext(input), Math.max(1, decision.maxWorkerCalls));
      const calls = await Promise.all(chunks.map((chunk, index) => {
        const packet = compileRuntimeContext({
          request: input.request,
          decision,
          targetRole: 'worker',
          tokenBudget: budgetPlan.worker.inputTokens,
          // chunk is already produced from compactSourceContext(input), so do
          // not serialize memory/tool/session context a second time.
          sourceContext: chunk,
          selectedProcedure,
        });
        if (index === 0) contextPackets.worker = packet;
        return runWorkerCompression(input, chunk, {
          pass: index + 1,
          totalPasses: chunks.length,
          requestId: `${runId}:worker:${index + 1}`,
          packet,
          budget: budgetPlan,
        });
      }));
      for (const worker of calls) {
        modelCalls.push(worker.call);
        if (worker.result) workerResults.push(worker.result);
        else warnings.push(`Worker pass failed: ${worker.call.error || 'invalid worker output'}`);
        recordPipelineActivity(sessionId, 'worker', worker.result
          ? `Worker ${worker.call.model} completed an evidence-compression pass.`
          : `Worker ${worker.call.model || 'unknown'} failed an evidence-compression pass.`, {
          runId,
          model: worker.call.model,
          provider: worker.call.provider,
          usage: worker.call.usage,
          ok: Boolean(worker.result),
        }, worker.result ? 'progress' : 'error');
      }
    }

    let workerResult = mergeWorkerResults(workerResults, input.request);
    if (workerResult) {
      const gate = runQualityGate({ findings: workerResult.findings, events: [], requireEvidence: true, minConfidence: 0.7 });
      if (gate.verdict === 'revise') warnings.push(`${gate.discardedFindings.length} worker findings were discarded by the quality gate.`);
      if (gate.verdict === 'escalate' || gate.verdict === 'block') warnings.push(`Worker quality gate verdict: ${gate.verdict}.`);
      workerResult = { ...workerResult, findings: gate.usableFindings };
    }

    const hostPacket = compileRuntimeContext({
      request: input.request,
      decision,
      targetRole: 'host',
      tokenBudget: budgetPlan.host.inputTokens,
      memoryContext: input.memoryContext,
      sourceContext: input.context,
      toolContext: input.toolContext,
      workerResult,
      selectedProcedure,
    });
    contextPackets.host = hostPacket;
    const host = await runHostSynthesis(input, decision, workerResult, { requestId: `${runId}:host:1`, packet: hostPacket, budget: budgetPlan });
    modelCalls.push(host);
    recordPipelineActivity(sessionId, 'host', host.ok
      ? `Host ${host.model} produced the user-facing draft.`
      : `Host ${host.model || 'unknown'} failed to produce a draft.`, {
      runId,
      model: host.model,
      provider: host.provider,
      usage: host.usage,
    }, host.ok ? 'progress' : 'error');
    if (!host.ok || !host.content) throw new Error(host.error || 'Host model failed to produce a draft');
    let draft = host.content;
    hostDrafts.push(draft);

    const maxRevisions = Math.min(1, Math.max(
      decision.maxRevisionAttempts,
      input.maxRevisionAttempts ?? decision.maxRevisionAttempts,
    ));
    let verifierResult: VerifierResult | undefined;
    const verifierMandatory = input.userRequestedVerification
      || decision.requiresApproval
      || decision.risk === 'high'
      || decision.risk === 'critical';
    if (decision.useVerifier) {
      for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
        const verifierPacket = compileRuntimeContext({
          request: input.request,
          decision,
          targetRole: 'verifier',
          tokenBudget: budgetPlan.verifier.inputTokens,
          memoryContext: input.memoryContext,
          sourceContext: input.context,
          toolContext: input.toolContext,
          workerResult,
          validationResults: [`Draft revision attempt ${attempt + 1}`],
          selectedProcedure,
        });
        contextPackets.verifier = verifierPacket;
        const verifier = await runVerifier(input, draft, workerResult, {
          requestId: `${runId}:verifier:${attempt + 1}`,
          packet: verifierPacket,
          budget: budgetPlan,
          mandatory: verifierMandatory,
        });
        modelCalls.push(verifier.call);
        if (!verifier.result) {
          recordPipelineActivity(sessionId, 'verifier', 'Optional verifier was unavailable; Host draft retained without claiming independent verification.', {
            runId,
            model: verifier.call.model,
            provider: verifier.call.provider,
            error: verifier.call.error,
            mandatory: false,
          }, 'error');
          break;
        }
        verifierResult = verifier.result;
        verifierResults.push(verifier.result);
        recordPipelineActivity(sessionId, 'verifier', `Verifier ${verifier.call.model} returned ${verifier.result.verdict}.`, {
          runId,
          model: verifier.call.model,
          provider: verifier.call.provider,
          verdict: verifier.result.verdict,
          confidence: verifier.result.confidence,
          usage: verifier.call.usage,
        }, verifier.result.verdict === 'block' ? 'error' : 'progress');
        if (verifier.result.verdict === 'pass') break;
        if (verifier.result.verdict === 'block') break;
        if (verifier.result.verdict === 'escalate') break;
        if (verifier.result.verdict === 'revise' && attempt < maxRevisions) {
          const fixes = verifier.result.issues.map((issue) => issue.requiredFix || issue.issue);
          const revision = await runHostRevision(input, draft, fixes, workerResult, {
            requestId: `${runId}:host-revision:${attempt + 1}`,
            budget: budgetPlan,
          });
          modelCalls.push(revision);
          if (!revision.ok || !revision.content) {
            throw new Error(`Host revision failed: ${revision.error || 'no revised content'}`);
          }
          draft = revision.content;
          revisions += 1;
          hostDrafts.push(draft);
          recordPipelineActivity(sessionId, 'host', `Host ${revision.model} completed revision ${revisions} from verifier feedback.`, {
            runId,
            model: revision.model,
            provider: revision.provider,
            revision: revisions,
            usage: revision.usage,
          });
        }
      }
    }

    const shouldEscalate = decision.useBoss
      || verifierResult?.verdict === 'escalate'
      || (verifierResult?.verdict === 'revise' && decision.allowEscalation);
    if (shouldEscalate) {
      const packet = sessionId
        ? buildEscalationPacket(sessionId, verifierResult?.issues.map((issue) => issue.issue).join('; ') || `Route risk is ${decision.risk}.`, {
          currentDraft: draft,
          runId,
          verifierIssues: verifierResult?.issues || [],
        })
        : createEscalationPacketWithoutSession(input, runId, draft, workerResult, verifierResult, decision);
      const boss = await runBossReviewModel(packet, {
        sessionId,
        modelOverrides: input.modelOverrides,
        requestId: `${runId}:boss`,
        maxInputTokens: budgetPlan.boss.inputTokens,
        maxOutputTokens: budgetPlan.boss.outputTokens,
        tokenBudgetPlan: budgetPlan,
        mandatory: input.userRequestedBoss || decision.requiresApproval,
      });
      modelCalls.push(boss);
      if (!boss.ok || !boss.parsed) {
        throw new Error(boss.error || 'Boss review failed for an escalated route');
      } else {
        bossDecision = BossDecisionSchema.parse(boss.parsed);
        recordPipelineActivity(sessionId, 'boss', `Boss ${boss.model} returned ${bossDecision.verdict}.`, {
          runId,
          model: boss.model,
          provider: boss.provider,
          verdict: bossDecision.verdict,
          confidence: bossDecision.confidence,
          usage: boss.usage,
        }, bossDecision.verdict === 'block' ? 'error' : 'progress');
        if (sessionId) applyBossDecision(sessionId, bossDecision);
        if (bossDecision.verdict === 'block') {
          const blocked = `Zenos Boss blocked this response: ${bossDecision.reasoningSummary}`;
          const blockedReceipt = buildExecutionReceipt({
            calls: modelCalls,
            verifier: verifierResult,
            boss: bossDecision,
            autonomous: autonomousOutcome,
          });
          const blockedAnswer = input.includeExecutionReceipt
            ? `${blocked}\n\n${renderExecutionReceipt(blockedReceipt)}`
            : blocked;
          routeEvent = { ...routeEvent, verdict: 'blocked' };
          const tokens = actualTokenTotals(modelCalls);
          routeEvent = { ...routeEvent, actualInputTokens: tokens.input, actualOutputTokens: tokens.output, modelCalls: modelCalls.length, revisions, latencyMs: Date.now() - started, outputSizeBucket: outputBucket(blockedAnswer) };
          const result: RuntimePipelineResult = {
            ok: false,
            status: 'blocked',
            runId,
            sessionId,
            dryRun: false,
            decision,
            routeEvent,
            budgetPlan,
            contextPackets,
            memoryRecall,
            repositoryIntelligence,
            codingTask,
            autonomousCoding: autonomousOutcome ? compactAutonomousCoding(autonomousOutcome) : undefined,
            executionReceipt: blockedReceipt,
            workerResults,
            workerResult,
            hostDraft: hostDrafts[0],
            hostDrafts,
            verifierResult,
            verifierResults,
            bossDecision,
            finalAnswer: blockedAnswer,
            modelCalls,
            revisions,
            premiumTokensAvoidedEstimate: 0,
            warnings,
            errors,
          };
          store.saveRun({ runId, sessionId, requestHash: requestHash(input), status: 'blocked', decision, result, errors, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString() });
          updateSessionBudget(sessionId, modelCalls, 0);
          if (sessionId) failRuntimeSession(sessionId, blockedAnswer);
          recordNativePipelineOutcome({
            runId,
            sessionId,
            request: input.request,
            decision,
            status: 'blocked',
            revisions,
            calls: modelCalls,
            totalDurationMs: Date.now() - started,
            memoryRecall,
            repositoryIntelligence,
            workerResult,
            verifierResult,
            bossDecision,
            memoryContext: input.memoryContext,
          });
          return result;
        }
        if (bossDecision.verdict === 'ask_user') {
          draft = `Additional user input is required before proceeding safely: ${bossDecision.reasoningSummary}`;
        }
        if (bossDecision.verdict === 'revise' || bossDecision.verdict === 'delegate') {
          if (bossDecision.verdict === 'delegate') {
            const delegated = await runWorkerCompression(input, compactSourceContext(input), { requestId: `${runId}:worker:delegated` });
            modelCalls.push(delegated.call);
            recordPipelineActivity(sessionId, 'worker', delegated.result
              ? `Boss-delegated Worker ${delegated.call.model} completed additional evidence work.`
              : `Boss-delegated Worker ${delegated.call.model || 'unknown'} failed.`, {
              runId,
              model: delegated.call.model,
              provider: delegated.call.provider,
              usage: delegated.call.usage,
              delegatedByBoss: true,
            }, delegated.result ? 'progress' : 'error');
            if (delegated.result) {
              workerResults.push(delegated.result);
              workerResult = mergeWorkerResults(workerResults, input.request);
            }
          }
          const revision = await runHostRevision(
            input,
            draft,
            bossDecision.requiredChanges.length ? bossDecision.requiredChanges : [bossDecision.reasoningSummary],
            workerResult,
            { requestId: `${runId}:host-boss-revision`, budget: budgetPlan },
          );
          modelCalls.push(revision);
          if (!revision.ok || !revision.content) throw new Error(revision.error || 'Boss-requested revision failed');
          draft = revision.content;
          revisions += 1;
          hostDrafts.push(draft);
          recordPipelineActivity(sessionId, 'host', `Host ${revision.model} completed Boss-requested revision ${revisions}.`, {
            runId,
            model: revision.model,
            provider: revision.provider,
            revision: revisions,
            usage: revision.usage,
          });
          if (decision.useVerifier) {
            const finalVerifier = await runVerifier(input, draft, workerResult, { requestId: `${runId}:verifier:final` });
            modelCalls.push(finalVerifier.call);
            if (!finalVerifier.result) {
              throw new Error(`Final verifier unavailable: ${finalVerifier.call.error || 'invalid output'}`);
            }
            verifierResult = finalVerifier.result;
            verifierResults.push(finalVerifier.result);
            recordPipelineActivity(sessionId, 'verifier', `Final Verifier ${finalVerifier.call.model} returned ${finalVerifier.result.verdict}.`, {
              runId,
              model: finalVerifier.call.model,
              provider: finalVerifier.call.provider,
              verdict: finalVerifier.result.verdict,
              confidence: finalVerifier.result.confidence,
              usage: finalVerifier.call.usage,
            }, finalVerifier.result.verdict === 'pass' ? 'progress' : 'error');
            if (finalVerifier.result.verdict !== 'pass') {
              throw new Error(`Final verifier did not approve the revised answer (${finalVerifier.result.verdict}): ${finalVerifier.result.issues.map((issue) => issue.issue).join('; ') || 'no issue detail supplied'}`);
            }
          }
        }
      }
    }

    if (decision.requiresApproval && !input.approvalGranted) {
      warnings.push('Critical action approval was not granted; the response is advisory and must not be treated as executed.');
    }

    if (verifierResult?.verdict === 'block') {
      throw new Error(`Verifier blocked the answer: ${verifierResult.issues.map((issue) => issue.issue).join('; ')}`);
    }
    if ((verifierResult?.verdict === 'revise' || verifierResult?.verdict === 'escalate') && !bossDecision) {
      throw new Error(`Verifier verdict remained unresolved (${verifierResult.verdict}) after the permitted control-flow steps.`);
    }

    let status: RuntimePipelineResult['status'] = bossDecision?.verdict === 'ask_user' ? 'needs_input' : 'done';
    if (autonomousOutcome?.status === 'planned' || autonomousOutcome?.status === 'remote_required') status = 'needs_input';
    if (autonomousOutcome?.status === 'blocked') status = 'blocked';
    if (autonomousOutcome?.status === 'failed' || autonomousOutcome?.status === 'validation_failed') status = 'failed';
    const executionReceipt = buildExecutionReceipt({
      calls: modelCalls,
      verifier: verifierResult,
      boss: bossDecision,
      autonomous: autonomousOutcome,
    });
    if (input.includeExecutionReceipt) {
      draft = `${draft}\n\n${renderExecutionReceipt(executionReceipt)}`;
    }
    const tokenTotals = actualTokenTotals(modelCalls);
    const rawContextTokens = estimateTokens(compactSourceContext(input));
    const hostInputTokens = modelCalls.filter((call) => call.role === 'host').reduce((sum, call) => sum + call.usage.inputTokens, 0);
    const premiumAvoided = decision.useWorker ? Math.max(0, rawContextTokens - hostInputTokens) : 0;
    routeEvent = {
      ...routeEvent,
      verdict: status === 'blocked'
        ? 'blocked'
        : status === 'failed'
          ? 'failed'
          : revisions > 0
            ? 'revised'
            : shouldEscalate
              ? 'escalated'
              : 'success',
      latencyMs: Date.now() - started,
      actualInputTokens: tokenTotals.input,
      actualOutputTokens: tokenTotals.output,
      modelCalls: modelCalls.length,
      revisions,
      outputSizeBucket: outputBucket(draft),
    };

    const result: RuntimePipelineResult = {
      ok: status === 'done',
      status,
      runId,
      sessionId,
      dryRun: false,
      decision,
      routeEvent,
      budgetPlan,
      contextPackets,
      memoryRecall,
      repositoryIntelligence,
      codingTask,
      autonomousCoding: autonomousOutcome ? compactAutonomousCoding(autonomousOutcome) : undefined,
      executionReceipt,
      workerResults,
      workerResult,
      hostDraft: hostDrafts[0],
      hostDrafts,
      verifierResult,
      verifierResults,
      bossDecision,
      finalAnswer: draft,
      modelCalls,
      revisions,
      premiumTokensAvoidedEstimate: premiumAvoided,
      warnings,
      errors,
    };

    recordPipelineActivity(sessionId, 'host', status === 'done'
      ? `Host finalized run ${runId} with verified execution evidence.`
      : `Host finalized run ${runId} with status ${status}.`, {
      runId,
      status,
      codingStatus: autonomousOutcome?.status,
      filesChanged: autonomousOutcome?.task.filesChanged || [],
    }, status === 'done' ? 'done' : status === 'failed' || status === 'blocked' ? 'error' : 'progress');

    if (input.persistRouteEvent) {
      const memory = await persistRouteEventToMemory({ namespace: input.namespace, event: routeEvent, runId, sessionId });
      store.saveRouteEvent({ runId, sessionId, namespace: input.namespace, event: routeEvent, memoryStatus: memory.ok ? 'persisted' : memory.skipped ? 'skipped' : 'failed', memoryResponse: memory.value || memory.error });
      if (!memory.ok && !memory.skipped) warnings.push(`Route-event memory persistence failed: ${memory.error || 'unknown error'}`);
    } else {
      store.saveRouteEvent({ runId, sessionId, namespace: input.namespace, event: routeEvent, memoryStatus: 'disabled' });
    }

    store.saveRun({
      runId,
      sessionId,
      requestHash: requestHash(input),
      status: status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : 'done',
      decision,
      result,
      errors,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
    });
    updateSessionBudget(sessionId, modelCalls, premiumAvoided);
    if (sessionId) {
      if (status === 'failed' || status === 'blocked') failRuntimeSession(sessionId, autonomousOutcome?.error || autonomousOutcome?.summary || 'Runtime execution failed');
      else completeRuntimeSession(sessionId, draft);
    }
    incrementMetric('pipeline_runs_total', { status, task: decision.taskType, risk: decision.risk });
    observeDuration('pipeline_run_duration', started, { status, task: decision.taskType });
    if (status === 'done' || status === 'blocked' || status === 'failed') {
      const outcomeStatus: 'done' | 'blocked' | 'failed' = status;
      recordNativePipelineOutcome({
        runId,
        sessionId,
        request: input.request,
        decision,
        status: outcomeStatus,
        revisions,
        calls: modelCalls,
        totalDurationMs: Date.now() - started,
        memoryRecall,
        repositoryIntelligence,
        workerResult,
        verifierResult,
        bossDecision,
        memoryContext: input.memoryContext,
      });
    }
    return result;
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    errors.push(message);
    recordPipelineActivity(sessionId, 'host', `Host failed run ${runId}: ${message}`, {
      runId,
      codingStatus: autonomousOutcome?.status,
    }, 'error');
    const tokenTotals = actualTokenTotals(modelCalls);
    routeEvent = {
      ...routeEvent,
      verdict: /block/i.test(message) ? 'blocked' : 'failed',
      latencyMs: Date.now() - started,
      actualInputTokens: tokenTotals.input,
      actualOutputTokens: tokenTotals.output,
      modelCalls: modelCalls.length,
      revisions,
      outputSizeBucket: 'small',
    };
    const failureReceipt = buildExecutionReceipt({
      calls: modelCalls,
      verifier: verifierResults.at(-1),
      boss: bossDecision,
      autonomous: autonomousOutcome,
    });
    const failureBase = `Zenos Runtime could not safely complete this request: ${message}`;
    const failureAnswer = input.includeExecutionReceipt
      ? `${failureBase}\n\n${renderExecutionReceipt(failureReceipt)}`
      : failureBase;
    routeEvent = { ...routeEvent, outputSizeBucket: outputBucket(failureAnswer) };
    const result: RuntimePipelineResult = {
      ok: false,
      status: /block/i.test(message) ? 'blocked' : 'failed',
      runId,
      sessionId,
      dryRun: false,
      decision,
      routeEvent,
      budgetPlan,
      contextPackets,
      memoryRecall,
      repositoryIntelligence,
      codingTask,
      autonomousCoding: autonomousOutcome ? compactAutonomousCoding(autonomousOutcome) : undefined,
      executionReceipt: failureReceipt,
      workerResults,
      workerResult: mergeWorkerResults(workerResults, input.request),
      hostDraft: hostDrafts[0],
      hostDrafts,
      verifierResult: verifierResults.at(-1),
      verifierResults,
      bossDecision,
      finalAnswer: failureAnswer,
      modelCalls,
      revisions,
      premiumTokensAvoidedEstimate: 0,
      warnings,
      errors,
    };
    store.saveRun({ runId, sessionId, requestHash: requestHash(input), status: result.status === 'blocked' ? 'blocked' : 'failed', decision, result, errors, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString() });
    store.saveRouteEvent({ runId, sessionId, namespace: input.namespace, event: routeEvent, memoryStatus: 'not_attempted', memoryResponse: message });
    updateSessionBudget(sessionId, modelCalls, 0);
    if (sessionId) failRuntimeSession(sessionId, failureAnswer);
    incrementMetric('pipeline_runs_total', { status: result.status, task: decision.taskType, risk: decision.risk });
    observeDuration('pipeline_run_duration', started, { status: result.status, task: decision.taskType });
    recordNativePipelineOutcome({
      runId,
      sessionId,
      request: input.request,
      decision,
      status: result.status === 'blocked' ? 'blocked' : 'failed',
      revisions,
      calls: modelCalls,
      totalDurationMs: Date.now() - started,
      memoryRecall,
      repositoryIntelligence,
      workerResult: mergeWorkerResults(workerResults, input.request),
      verifierResult: verifierResults.at(-1),
      bossDecision,
      memoryContext: input.memoryContext,
    });
    log('error', 'Zenos pipeline failed', { runId, sessionId, task: decision.taskType, risk: decision.risk, error: message });
    return result;
  }
}
