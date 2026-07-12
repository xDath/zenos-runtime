import { authConfigurationStatus } from './auth';
import { getRuntimeModelConfigSummary, hasRuntimeModels } from './zenos-runtime-executor';
import { memoryConfigurationSummary, memoryDependencyHealth } from './zenos-memory-client';
import { runtimeReadinessReport } from './zenos-runtime';
import { getRuntimeStore } from './zenos-runtime-store';

export const ZENOS_RUNTIME_VERSION = '0.2.0';

export type ReadinessCheck = {
  name: string;
  required: boolean;
  passed: boolean;
  degraded?: boolean;
  evidence: string;
  latencyMs?: number;
};

async function routerHealth(): Promise<{ configured: boolean; reachable: boolean; status?: number; latencyMs?: number; error?: string }> {
  const summary = getRuntimeModelConfigSummary();
  const role = summary.roles.host as { baseUrl?: string } | undefined;
  const baseUrl = role?.baseUrl || summary.baseUrl || '';
  if (!baseUrl) return { configured: false, reachable: false };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { configured: true, reachable: false, error: 'Invalid model base URL' };
  }
  url.pathname = '/api/health';
  url.search = '';
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return { configured: true, reachable: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { configured: true, reachable: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildRuntimeReadiness(options: { includeDependencies?: boolean } = {}) {
  const policy = runtimeReadinessReport();
  const store = getRuntimeStore().health();
  const auth = authConfigurationStatus();
  const models = getRuntimeModelConfigSummary();
  const checks: ReadinessCheck[] = [
    {
      name: 'routing policy regression',
      required: true,
      passed: policy.status === 'policy_ready',
      evidence: `${policy.evalReport.passed}/${policy.evalReport.total} policy cases pass (${policy.policyVersion})`,
    },
    {
      name: 'transactional session store',
      required: true,
      passed: store.ok && store.integrity === 'ok',
      evidence: `SQLite schema ${store.schemaVersion}, integrity ${store.integrity}, path ${store.path}`,
    },
    {
      name: 'authentication fail-closed',
      required: true,
      passed: auth.configured && auth.failClosed,
      evidence: `API key=${auth.apiKeyConfigured}, HMAC=${auth.hmacConfigured}, failClosed=${auth.failClosed}`,
    },
    {
      name: 'role model configuration',
      required: true,
      passed: hasRuntimeModels(),
      evidence: `host=${models.hostModel || 'missing'}, worker=${models.workerModel || 'missing'}, boss=${models.bossModel || 'missing'}, verifier=${models.verifierModel || 'missing'}`,
    },
    {
      name: 'legacy HMAC compatibility',
      required: false,
      passed: true,
      degraded: auth.legacyHmacAllowed,
      evidence: auth.legacyHmacAllowed ? 'Legacy path-only HMAC remains enabled for migration compatibility.' : 'Only body-bound HMAC v2 and scoped tokens are accepted.',
    },
  ];

  if (options.includeDependencies !== false) {
    const [router, memory] = await Promise.all([routerHealth(), memoryDependencyHealth()]);
    checks.push({
      name: 'model router dependency',
      required: true,
      passed: router.configured && router.reachable,
      evidence: router.reachable ? `Router returned HTTP ${router.status}` : router.error || 'Router is not reachable',
      latencyMs: router.latencyMs,
    });
    const memoryConfig = memoryConfigurationSummary();
    checks.push({
      name: 'Zenos Memory dependency',
      required: false,
      passed: !memoryConfig.enabled || memory.reachable,
      degraded: memoryConfig.enabled && !memory.reachable,
      evidence: memoryConfig.enabled
        ? memory.reachable ? `Memory returned HTTP ${memory.status}` : memory.error || 'Memory is configured but unreachable'
        : 'Memory integration is disabled',
      latencyMs: memory.latencyMs,
    });
  }

  const requiredFailed = checks.some((check) => check.required && !check.passed);
  const degraded = checks.some((check) => check.degraded || (!check.required && !check.passed));
  return {
    ok: !requiredFailed,
    status: requiredFailed ? 'not_ready' : degraded ? 'degraded' : 'ready',
    service: 'zenos-runtime',
    version: ZENOS_RUNTIME_VERSION,
    architecture: 'host-worker-boss-verifier',
    persistence: 'sqlite-wal',
    policyVersion: policy.policyVersion,
    checks,
    timestamp: new Date().toISOString(),
  } as const;
}
