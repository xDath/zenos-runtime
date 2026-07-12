import * as crypto from 'node:crypto';
import { z } from 'zod';
import { log, redactText } from './logger';
import { incrementMetric, observeDuration, setGauge } from './metrics';
import { getRuntimeCache, runtimeCacheKey } from './runtime-cache';
import { RouteEvent, routeEventMemoryContent } from './zenos-runtime';

const MemoryResultSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  content: z.string(),
  score: z.number().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const RecallResponseSchema = z.object({
  success: z.boolean().optional(),
  results: z.array(MemoryResultSchema).default([]),
}).passthrough();

const AuthResponseSchema = z.object({
  success: z.boolean().optional(),
  token: z.string().min(16),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional().default(900),
  scopes: z.array(z.string()).optional().default([]),
}).passthrough();

export type MemoryItem = z.infer<typeof MemoryResultSchema>;
export type MemoryScope = 'memory:read' | 'memory:write' | 'memory:admin';

export type MemoryClientResult<T> = {
  ok: boolean;
  skipped: boolean;
  value?: T;
  status?: number;
  error?: string;
  latencyMs?: number;
  degraded?: boolean;
  cacheHit?: boolean;
};

type TokenRecord = { token: string; expiresAt: number };
type CircuitState = { failures: number; openUntil: number; lastError?: string };

const tokens = new Map<string, TokenRecord>();
let circuit: CircuitState = { failures: 0, openUntil: 0 };
const inFlightTokens = new Map<string, Promise<string>>();
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function memoryBaseUrl(): string {
  return (process.env.ZENOS_MEMORY_BASE_URL
    || process.env.ZENOS_MEMORY_URL
    || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
}

function memoryEnabled(): boolean {
  return process.env.ZENOS_RUNTIME_DISABLE_MEMORY !== 'true' && Boolean(memoryBaseUrl());
}

function memorySecret(): string {
  return process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET || '';
}

function memoryApiKey(): string {
  return process.env.ZENOS_MEMORY_API_KEY || '';
}

function scopesKey(scopes: MemoryScope[]): string {
  return [...new Set(scopes)].sort().join(' ');
}

function timeoutValue(candidate?: number): number {
  return Math.max(2_000, Math.min(candidate || Number(process.env.ZENOS_MEMORY_TIMEOUT_MS || 12_000), 90_000));
}

function checkCircuit(): string | null {
  if (circuit.openUntil > Date.now()) return `Memory circuit open until ${new Date(circuit.openUntil).toISOString()}`;
  if (circuit.openUntil) circuit = { failures: 0, openUntil: 0 };
  return null;
}

function recordSuccess(): void {
  circuit = { failures: 0, openUntil: 0 };
  setGauge('memory_circuit_open', 0);
}

function recordFailure(error: string): void {
  const failures = circuit.failures + 1;
  const threshold = Math.max(2, Number(process.env.ZENOS_MEMORY_CIRCUIT_FAILURES || 4));
  circuit = {
    failures,
    openUntil: failures >= threshold ? Date.now() + Math.min(120_000, 10_000 * failures) : 0,
    lastError: redactText(error),
  };
  setGauge('memory_circuit_open', circuit.openUntil > Date.now() ? 1 : 0);
  incrementMetric('memory_circuit_failures_total');
}

function tokenExchangeHeaders(scopes: MemoryScope[]): HeadersInit {
  const secret = memorySecret();
  if (!secret) throw new Error('ETLA_MASTER_SECRET or ZENOS_MEMORY_SECRET is required for Memory token exchange');
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const canonical = [
    'zenos-memory-signature-v2',
    String(timestamp),
    nonce,
    'POST',
    '/api/auth',
    EMPTY_SHA256,
  ].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return {
    'content-type': 'application/json',
    'x-etla-timestamp': String(timestamp),
    'x-etla-nonce': nonce,
    'x-etla-content-sha256': EMPTY_SHA256,
    'x-etla-signature': signature,
    'x-etla-client-id': process.env.ZENOS_MEMORY_CLIENT_ID || 'etla-runtime-v1',
    'x-etla-requested-scopes': scopesKey(scopes),
  };
}

async function exchangeToken(scopes: MemoryScope[], force = false): Promise<string> {
  const key = scopesKey(scopes);
  const cached = tokens.get(key);
  if (!force && cached && Date.now() < cached.expiresAt - 30_000) return cached.token;
  if (!force) {
    const existing = inFlightTokens.get(key);
    if (existing) return existing;
  }
  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutValue());
    try {
      const response = await fetch(`${memoryBaseUrl()}/api/auth`, {
        method: 'POST',
        headers: tokenExchangeHeaders(scopes),
        signal: controller.signal,
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Memory token exchange HTTP ${response.status}: ${redactText(text.slice(0, 600))}`);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Memory token exchange returned non-JSON data');
      }
      const parsed = AuthResponseSchema.parse(data);
      tokens.set(key, { token: parsed.token, expiresAt: Date.now() + parsed.expires_in * 1000 });
      incrementMetric('memory_token_exchanges_total', { result: 'success' });
      return parsed.token;
    } catch (error) {
      incrementMetric('memory_token_exchanges_total', { result: 'failed' });
      throw error;
    } finally {
      clearTimeout(timeout);
      inFlightTokens.delete(key);
    }
  })();
  inFlightTokens.set(key, request);
  return request;
}

async function authorizationHeaders(scopes: MemoryScope[], forceToken = false): Promise<Record<string, string>> {
  if (memorySecret()) {
    const token = await exchangeToken(scopes, forceToken);
    return { authorization: `Bearer ${token}` };
  }
  const apiKey = memoryApiKey();
  if (apiKey) return { authorization: `Bearer ${apiKey}` };
  throw new Error('Zenos Memory authentication is not configured');
}

async function memoryFetch<T>(
  path: string,
  body: unknown,
  options: { timeoutMs?: number; scopes?: MemoryScope[]; parser?: z.ZodType<T, z.ZodTypeDef, unknown>; retry401?: boolean } = {},
): Promise<MemoryClientResult<T>> {
  if (!memoryEnabled()) return { ok: false, skipped: true, error: 'Zenos Memory integration is disabled', degraded: true };
  const circuitError = checkCircuit();
  if (circuitError) return { ok: false, skipped: true, error: circuitError, degraded: true };
  const started = Date.now();
  const scopes = options.scopes || ['memory:read'];
  const payload = JSON.stringify(body);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = timeoutValue(options.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const auth = await authorizationHeaders(scopes, attempt > 0);
      const response = await fetch(`${memoryBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
        body: payload,
        signal: controller.signal,
        cache: 'no-store',
      });
      const text = await response.text();
      const latencyMs = observeDuration('memory_request_duration', started, { path, status: response.status });
      incrementMetric('memory_requests_total', { path, status: response.status });
      if (response.status === 401 && attempt === 0 && options.retry401 !== false && memorySecret()) {
        tokens.delete(scopesKey(scopes));
        continue;
      }
      if (!response.ok) {
        const error = `Memory HTTP ${response.status}: ${redactText(text.slice(0, 800))}`;
        recordFailure(error);
        return { ok: false, skipped: false, status: response.status, latencyMs, error, degraded: true };
      }
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        const error = 'Memory returned non-JSON data';
        recordFailure(error);
        return { ok: false, skipped: false, status: response.status, latencyMs, error, degraded: true };
      }
      const value = options.parser ? options.parser.parse(data) : data as T;
      recordSuccess();
      return { ok: true, skipped: false, status: response.status, latencyMs, value };
    } catch (error) {
      const message = error instanceof Error
        ? error.name === 'AbortError' ? `Memory request timed out after ${timeoutMs} ms` : error.message
        : String(error);
      if (attempt === 0 && /401|token/i.test(message) && memorySecret()) {
        tokens.delete(scopesKey(scopes));
        continue;
      }
      const latencyMs = observeDuration('memory_request_duration', started, { path, status: 'error' });
      recordFailure(message);
      incrementMetric('memory_requests_total', { path, status: 'error' });
      return { ok: false, skipped: false, latencyMs, error: redactText(message), degraded: true };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, skipped: false, error: 'Memory authentication retry exhausted', degraded: true };
}

export async function recallMemoryItems(input: {
  query: string;
  namespace?: string;
  limit?: number;
  tags?: string[];
}): Promise<MemoryClientResult<MemoryItem[]>> {
  if (process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL === 'true') {
    return { ok: false, skipped: true, error: 'Automatic memory recall is disabled', degraded: true };
  }
  const namespace = input.namespace || process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  const limit = Math.min(Math.max(input.limit || 5, 1), 20);
  const cache = getRuntimeCache();
  const cacheInput = { query: input.query, namespace, limit, tags: input.tags || [] };
  const cacheKey = runtimeCacheKey('memory', cacheInput, { memory: process.env.ZENOS_MEMORY_REVISION || 'cloud' });
  const cached = cache.get<MemoryItem[]>(cacheKey, { memory: process.env.ZENOS_MEMORY_REVISION || 'cloud' });
  if (cached) return { ok: true, skipped: false, value: cached, cacheHit: true, latencyMs: 0 };

  const result = await memoryFetch<z.infer<typeof RecallResponseSchema>>('/api/memory/hybrid-recall', {
    query: input.query,
    namespace,
    limit,
    tags: input.tags,
    include_low_quality: false,
    include_secrets: false,
  }, { scopes: ['memory:read'], parser: RecallResponseSchema });
  if (!result.ok || !result.value) {
    return {
      ok: false,
      skipped: result.skipped,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
      degraded: result.degraded,
    };
  }
  const items = (result.value.results || []).filter((item) => item.type !== 'credential' && item.metadata?.is_secret !== true);
  cache.set(cacheKey, items, {
    ttlMs: Math.max(5_000, Number(process.env.ZENOS_MEMORY_RECALL_CACHE_MS || 60_000)),
    revisions: { memory: process.env.ZENOS_MEMORY_REVISION || 'cloud' },
  });
  return { ...result, value: items };
}

export async function recallMemoryContext(input: {
  query: string;
  namespace?: string;
  limit?: number;
  maxChars?: number;
}): Promise<MemoryClientResult<string>> {
  const result = await recallMemoryItems(input);
  if (!result.ok || !result.value) {
    return {
      ok: false,
      skipped: result.skipped,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
      degraded: result.degraded,
      cacheHit: result.cacheHit,
    };
  }
  const maxChars = Math.min(Math.max(input.maxChars || 8_000, 500), 24_000);
  const lines: string[] = [];
  let usedChars = 0;
  for (const item of result.value) {
    const metadata = item.metadata || {};
    const source = typeof metadata.source === 'string'
      ? metadata.source
      : typeof (metadata.provenance as Record<string, unknown> | undefined)?.source_id === 'string'
        ? String((metadata.provenance as Record<string, unknown>).source_id)
        : item.id || 'memory';
    const confidence = typeof metadata.confidence === 'number' ? ` confidence=${metadata.confidence.toFixed(2)}` : '';
    const line = `- [${item.type || 'memory'} source=${source}${confidence}] ${redactText(item.content).replace(/\s+/g, ' ').trim()}`.slice(0, 2_400);
    if (!line.trim() || usedChars + line.length > maxChars) break;
    lines.push(line);
    usedChars += line.length;
  }
  return {
    ...result,
    ok: true,
    value: lines.length ? `Zenos Memory recall:\n${lines.join('\n')}` : '',
  };
}

export async function persistRouteEventToMemory(input: {
  namespace?: string;
  event: RouteEvent;
  runId?: string;
  sessionId?: string;
}): Promise<MemoryClientResult<unknown>> {
  if (process.env.ZENOS_RUNTIME_ALLOW_ROUTE_EVENT_MEMORY !== 'true') {
    return { ok: false, skipped: true, error: 'Per-run Memory telemetry is disabled; use distilled learning batches instead.' };
  }
  const namespace = input.namespace || process.env.ZENOS_MEMORY_NAMESPACE || 'runtime.learning';
  const content = routeEventMemoryContent(input.event);
  const result = await memoryFetch('/api/memory/remember', {
    content,
    namespace,
    type: 'event',
    metadata: {
      confidence: 0.95,
      importance: input.event.verdict === 'failed' || input.event.verdict === 'blocked' ? 8 : 4,
      tags: ['etla-runtime', 'route-event', input.event.taskType, input.event.pipelineMode, input.event.verdict],
      entities: ['Etla Runtime', input.event.taskType, input.event.pipelineMode],
      provenance: {
        created_by: 'etla-runtime-v1',
        run_id: input.runId,
        session_id: input.sessionId,
        policy_version: input.event.policyVersion,
      },
    },
    idempotency_key: input.runId ? `runtime-route-${input.runId}` : undefined,
  }, { scopes: ['memory:read', 'memory:write'] });
  if (!result.ok && !result.skipped) {
    log('warn', 'Failed to persist distilled Runtime event to Zenos Memory', {
      runId: input.runId,
      sessionId: input.sessionId,
      status: result.status,
      error: result.error,
    });
  }
  return result;
}

export async function memoryDependencyHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  circuitOpen?: boolean;
}> {
  if (!memoryEnabled()) return { configured: false, reachable: false };
  const circuitError = checkCircuit();
  if (circuitError) return { configured: true, reachable: false, error: circuitError, circuitOpen: true };
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${memoryBaseUrl()}/api/memory/public-status`, { signal: controller.signal, cache: 'no-store' });
    if (response.ok) recordSuccess();
    else recordFailure(`Memory public status HTTP ${response.status}`);
    return { configured: true, reachable: response.ok, status: response.status, latencyMs: Date.now() - started, circuitOpen: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(message);
    return { configured: true, reachable: false, latencyMs: Date.now() - started, error: redactText(message), circuitOpen: circuit.openUntil > Date.now() };
  } finally {
    clearTimeout(timeout);
  }
}

export function memoryConfigurationSummary(): {
  enabled: boolean;
  baseUrl: string;
  auth: 'hmac-v2-token' | 'api-key' | 'none';
  clientId: string;
  circuit: CircuitState;
  cachedTokens: number;
} {
  return {
    enabled: memoryEnabled(),
    baseUrl: memoryBaseUrl(),
    auth: memorySecret() ? 'hmac-v2-token' : memoryApiKey() ? 'api-key' : 'none',
    clientId: process.env.ZENOS_MEMORY_CLIENT_ID || 'etla-runtime-v1',
    circuit: { ...circuit },
    cachedTokens: tokens.size,
  };
}

export function resetMemoryClientForTests(): void {
  tokens.clear();
  inFlightTokens.clear();
  circuit = { failures: 0, openUntil: 0 };
}
