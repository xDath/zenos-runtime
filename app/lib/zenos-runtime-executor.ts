import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  buildRouteEvent,
  choosePipeline,
  estimateRouteTokens,
  RuntimeContextSchema,
  validateVerifierResult,
  validateWorkerResult,
  VerifierResult,
  WorkerResult,
} from './zenos-runtime';

export const RuntimeRunRequestSchema = RuntimeContextSchema.extend({
  context: z.string().optional().default(''),
  memoryContext: z.string().optional().default(''),
  toolContext: z.string().optional().default(''),
  dryRun: z.boolean().optional().default(false),
});

export const RuntimeModelRoleSchema = z.enum(['host', 'worker', 'boss', 'verifier']);

export type RuntimeRunRequest = z.input<typeof RuntimeRunRequestSchema>;
export type RuntimeModelRole = z.infer<typeof RuntimeModelRoleSchema>;

export interface RuntimeModelResult {
  ok: boolean;
  role: RuntimeModelRole;
  model?: string;
  content?: string;
  parsed?: unknown;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  error?: string;
}

export interface RuntimePipelineResult {
  ok: boolean;
  dryRun: boolean;
  decision: ReturnType<typeof choosePipeline>;
  routeEvent: ReturnType<typeof buildRouteEvent>;
  workerResult?: WorkerResult;
  hostDraft?: string;
  verifierResult?: VerifierResult;
  finalAnswer: string;
  modelCalls: RuntimeModelResult[];
  premiumTokensAvoidedEstimate: number;
  errors: string[];
}

function stripJsonFence(text: string): string {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function safeJsonParse(text: string): unknown | null {
  const clean = stripJsonFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface HermesModelConfig {
  baseUrl: string;
  apiKey: string;
  hostModel: string;
  workerModel: string;
  bossModel: string;
  verifierModel: string;
}

function readHermesConfigText(): string {
  const explicit = process.env.HERMES_CONFIG_PATH;
  const candidates = [
    explicit,
    path.join(os.homedir(), '.hermes/profiles/zenos/config.yaml'),
    path.join(os.homedir(), '.hermes/config.yaml'),
    '/root/.hermes/profiles/zenos/config.yaml',
    '/root/.hermes/config.yaml',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    } catch {
      // Ignore unreadable Hermes config and fall back to env-only config.
    }
  }
  return '';
}

function extractYamlScalar(text: string, key: string): string {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*['\"]?([^'\"\\n#]+)`, 'm'));
  return match?.[1]?.trim() || '';
}

function extractProviderBlock(text: string, providerName: string): string {
  const marker = new RegExp(`^\\s{2}${providerName}:\\s*$`, 'm');
  const match = marker.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const endMatch = /^\s{2}[A-Za-z0-9_-]+:\s*$/m.exec(rest);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

function loadHermesModelConfig(): HermesModelConfig {
  const text = readHermesConfigText();
  const providerRef = extractYamlScalar(text, 'provider').replace(/^custom:/, '') || 'etla-router';
  const providerBlock = extractProviderBlock(text, providerRef);
  const defaultModel = extractYamlScalar(providerBlock, 'default_model') || extractYamlScalar(text, 'default');
  const agentModel = extractYamlScalar(text, 'model');

  return {
    baseUrl: extractYamlScalar(providerBlock, 'base_url'),
    apiKey: extractYamlScalar(providerBlock, 'api_key'),
    hostModel: agentModel || defaultModel,
    workerModel: defaultModel || agentModel,
    bossModel: agentModel || defaultModel,
    verifierModel: defaultModel || agentModel,
  };
}

function readRuntimeOverrideConfig(): Partial<HermesModelConfig> {
  const explicit = process.env.ZENOS_RUNTIME_CONFIG_PATH;
  const candidates = [
    explicit,
    path.join(os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json'),
    path.join(os.homedir(), '.hermes/zenos-runtime.json'),
    '/root/.hermes/profiles/zenos/zenos-runtime.json',
    '/root/.hermes/zenos-runtime.json',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      // Ignore malformed override config and continue with env/Hermes defaults.
    }
  }
  return {};
}

function runtimeModelConfig(): HermesModelConfig {
  const hermes = loadHermesModelConfig();
  const override = readRuntimeOverrideConfig();
  return {
    baseUrl: process.env.ZENOS_LLM_BASE_URL || process.env.MEMORY_LLM_BASE_URL || override.baseUrl || hermes.baseUrl,
    apiKey: process.env.ZENOS_LLM_API_KEY || process.env.MEMORY_LLM_API_KEY || override.apiKey || hermes.apiKey,
    hostModel: process.env.ZENOS_HOST_MODEL || process.env.MEMORY_LLM_MODEL || override.hostModel || hermes.hostModel,
    workerModel: process.env.ZENOS_WORKER_MODEL || process.env.MEMORY_LLM_FALLBACK_MODEL || override.workerModel || hermes.workerModel,
    bossModel: process.env.ZENOS_BOSS_MODEL || process.env.ZENOS_HOST_MODEL || process.env.MEMORY_LLM_MODEL || override.bossModel || hermes.bossModel || hermes.hostModel,
    verifierModel: process.env.ZENOS_VERIFIER_MODEL || process.env.MEMORY_LLM_FALLBACK_MODEL || override.verifierModel || hermes.verifierModel,
  };
}

function modelForRole(role: RuntimeModelRole): string {
  const cfg = runtimeModelConfig();
  if (role === 'host') return cfg.hostModel;
  if (role === 'worker') return cfg.workerModel;
  if (role === 'boss') return cfg.bossModel;
  return cfg.verifierModel;
}

function modelBaseUrl(): string {
  return runtimeModelConfig().baseUrl.replace(/\/$/, '');
}

function modelApiKey(): string {
  return runtimeModelConfig().apiKey;
}

function modelEndpointUrl(): string {
  const baseUrl = modelBaseUrl();
  if (!baseUrl) return '';

  const lower = baseUrl.toLowerCase();
  if (lower.endsWith('/chat/completions') || lower.endsWith('/model')) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

export function hasRuntimeModels(): boolean {
  const cfg = runtimeModelConfig();
  return Boolean(cfg.baseUrl && cfg.hostModel && cfg.workerModel && cfg.verifierModel);
}

export function getRuntimeModelConfigSummary() {
  const cfg = runtimeModelConfig();
  return {
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    hostModel: cfg.hostModel,
    workerModel: cfg.workerModel,
    bossModel: cfg.bossModel,
    verifierModel: cfg.verifierModel,
    source: process.env.ZENOS_LLM_BASE_URL || process.env.ZENOS_HOST_MODEL ? 'env' : 'hermes-config',
  };
}

export async function callRuntimeModel(
  role: RuntimeModelRole,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { json?: boolean; maxTokens?: number } = {},
): Promise<RuntimeModelResult> {
  const model = modelForRole(role);
  const endpointUrl = modelEndpointUrl();
  const apiKey = modelApiKey();
  const promptText = messages.map((message) => `${message.role}: ${message.content}`).join('\n');

  if (!endpointUrl || !model) {
    return {
      ok: false,
      role,
      model,
      inputTokensEstimate: estimateTokens(promptText),
      outputTokensEstimate: 0,
      error: 'ZENOS_LLM_BASE_URL/MODEL or MEMORY_LLM_* is not configured',
    };
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: role === 'host' ? 0.25 : 0.1,
        max_tokens: options.maxTokens || (role === 'host' ? 1800 : 1200),
        stream: false,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        role,
        model,
        inputTokensEstimate: estimateTokens(promptText),
        outputTokensEstimate: estimateTokens(raw),
        error: `HTTP ${res.status}: ${raw.slice(0, 800)}`,
      };
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content || '';
    return {
      ok: Boolean(content),
      role,
      model,
      content,
      parsed: content ? safeJsonParse(content) : null,
      inputTokensEstimate: estimateTokens(promptText),
      outputTokensEstimate: estimateTokens(content),
      error: content ? undefined : `No content in LLM response: ${raw.slice(0, 500)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      role,
      model,
      inputTokensEstimate: estimateTokens(promptText),
      outputTokensEstimate: 0,
      error: message,
    };
  }
}


export async function runBossReviewModel(packet: unknown): Promise<RuntimeModelResult> {
  return callRuntimeModel('boss', [
    {
      role: 'system',
      content: `You are the premium Zenos Boss Agent. Review only the escalation packet.
Return concise JSON: {"verdict":"approve|revise|block|ask_user|delegate","confidence":0.0,"reasoningSummary":"...","requiredChanges":["..."],"allowedActions":["..."],"forbiddenActions":["..."]}`,
    },
    { role: 'user', content: JSON.stringify(packet, null, 2) },
  ], { json: true, maxTokens: 900 });
}

function compactSourceContext(input: z.infer<typeof RuntimeRunRequestSchema>): string {
  return [
    input.memoryContext ? `Memory context:\n${input.memoryContext}` : '',
    input.toolContext ? `Tool/source context:\n${input.toolContext}` : '',
    input.context ? `Extra context:\n${input.context}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 24_000);
}

export async function runWorkerCompression(input: z.infer<typeof RuntimeRunRequestSchema>): Promise<{ result?: WorkerResult; call: RuntimeModelResult }> {
  const sourceContext = compactSourceContext(input);
  const call = await callRuntimeModel('worker', [
    {
      role: 'system',
      content: `You are a cheap Zenos Worker. Compress raw context so a premium Host spends fewer tokens.
Return ONLY valid JSON matching this shape:
{"task":"...","summary":["max 10 bullets"],"findings":[{"claim":"...","evidence":["file/url/line"],"confidence":0.0,"risk":"low|medium|high|critical"}],"suggestedNextStep":"...","needsHostAttention":["..."],"rawContextNeeded":["..."]}
Do not solve risky decisions. Do not dump raw files. Be concise and evidence-backed.`,
    },
    {
      role: 'user',
      content: `User request:\n${input.request}\n\nRaw context to compress:\n${sourceContext || '(none provided)'}`,
    },
  ], { json: true, maxTokens: 1200 });

  if (!call.ok || !call.parsed) return { call };
  return { call, result: validateWorkerResult(call.parsed) };
}

export async function runHostSynthesis(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  workerResult?: WorkerResult,
): Promise<RuntimeModelResult> {
  const workerBlock = workerResult ? JSON.stringify(workerResult, null, 2) : '(no worker result)';
  const focusedContext = workerResult ? workerBlock : compactSourceContext(input).slice(0, 10_000);

  return callRuntimeModel('boss', [
    {
      role: 'system',
      content: `You are the premium Zenos Host. Your job is judgment and final synthesis, not raw context grinding.
Use worker summaries when present. Pull no unstated facts. If source context is insufficient, say what is missing.
Answer the user directly and concisely.`,
    },
    {
      role: 'user',
      content: `User request:\n${input.request}\n\nDecision-grade context:\n${focusedContext}`,
    },
  ], { maxTokens: 1800 });
}

export async function runVerifier(input: z.infer<typeof RuntimeRunRequestSchema>, draft: string): Promise<{ result?: VerifierResult; call: RuntimeModelResult }> {
  const call = await callRuntimeModel('verifier', [
    {
      role: 'system',
      content: `You are Zenos Verifier. Return ONLY valid JSON:
{"verdict":"pass|revise|escalate|block","confidence":0.0,"issues":[{"severity":"low|medium|high|critical","issue":"...","evidence":"...","requiredFix":"..."}],"checks":{"followsUserRequest":"pass|fail|unknown","sourceGrounded":"pass|fail|not_applicable","secretSafe":"pass|fail|unknown","actionSafe":"pass|fail|not_applicable","testsOrValidation":"pass|fail|not_applicable"},"nextAction":"answer|revise|ask_user|escalate|block"}`,
    },
    {
      role: 'user',
      content: `User request:\n${input.request}\n\nDraft answer/action:\n${draft}`,
    },
  ], { json: true, maxTokens: 900 });

  if (!call.ok || !call.parsed) return { call };
  return { call, result: validateVerifierResult(call.parsed) };
}

export async function runZenosPipeline(request: RuntimeRunRequest): Promise<RuntimePipelineResult> {
  const input = RuntimeRunRequestSchema.parse(request);
  const decision = choosePipeline(input);
  const routeEvent = buildRouteEvent(decision, input);
  const modelCalls: RuntimeModelResult[] = [];
  const errors: string[] = [];

  if (input.dryRun) {
    const estimate = estimateRouteTokens(decision, input);
    return {
      ok: true,
      dryRun: true,
      decision,
      routeEvent,
      finalAnswer: 'Dry run only: route decision generated without calling LLM models.',
      modelCalls,
      premiumTokensAvoidedEstimate: decision.useWorker ? Math.max(0, estimate.cheapInputTokens - 1200) : 0,
      errors,
    };
  }

  let workerResult: WorkerResult | undefined;
  if (decision.useWorker) {
    try {
      const worker = await runWorkerCompression(input);
      modelCalls.push(worker.call);
      workerResult = worker.result;
      if (!worker.result) errors.push(worker.call.error || 'Worker did not return a valid WorkerResult');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const host = await runHostSynthesis(input, workerResult);
  modelCalls.push(host);
  const hostDraft = host.content || '';
  if (!host.ok) errors.push(host.error || 'Host model failed');

  let verifierResult: VerifierResult | undefined;
  if (decision.useVerifier && hostDraft) {
    try {
      const verifier = await runVerifier(input, hostDraft);
      modelCalls.push(verifier.call);
      verifierResult = verifier.result;
      if (!verifier.result) errors.push(verifier.call.error || 'Verifier did not return a valid VerifierResult');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const blocked = verifierResult?.verdict === 'block';
  const finalAnswer = blocked
    ? `Verifier blocked this answer. Issues: ${verifierResult?.issues.map((issue) => issue.issue).join('; ') || 'unknown'}`
    : hostDraft || 'No final answer produced.';

  const rawContextTokens = estimateTokens(compactSourceContext(input));
  const hostInputTokens = modelCalls.find((call) => call.role === 'host')?.inputTokensEstimate || 0;

  return {
    ok: errors.length === 0 && !blocked,
    dryRun: false,
    decision,
    routeEvent,
    workerResult,
    hostDraft,
    verifierResult,
    finalAnswer,
    modelCalls,
    premiumTokensAvoidedEstimate: decision.useWorker ? Math.max(0, rawContextTokens - hostInputTokens) : 0,
    errors,
  };
}
