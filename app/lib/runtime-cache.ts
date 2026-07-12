import * as crypto from 'node:crypto';
import { incrementMetric, setGauge } from './metrics';

export type CacheNamespace =
  | 'request'
  | 'memory'
  | 'context'
  | 'repository'
  | 'tool'
  | 'validation'
  | 'classification'
  | 'profile'
  | 'skill'
  | 'prompt';

export type CacheDependencyRevision = {
  workspace?: string;
  memory?: string;
  model?: string;
  prompt?: string;
  skill?: string;
  tool?: string;
  policy?: string;
};

type CacheRecord<T> = {
  value: T;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  hits: number;
  bytes: number;
  revisions: CacheDependencyRevision;
};

export type RuntimeCacheStats = {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  namespaces: Record<string, number>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runtimeCacheKey(namespace: CacheNamespace, input: unknown, revisions: CacheDependencyRevision = {}): string {
  const digest = crypto.createHash('sha256')
    .update(stableJson({ namespace, input, revisions }))
    .digest('hex');
  return `${namespace}:${digest}`;
}

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 1024;
  }
}

function revisionsMatch(expected: CacheDependencyRevision, actual: CacheDependencyRevision): boolean {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)] as Array<keyof CacheDependencyRevision>);
  for (const key of keys) {
    if ((expected[key] || '') !== (actual[key] || '')) return false;
  }
  return true;
}

export class RuntimeCache {
  private readonly records = new Map<string, CacheRecord<unknown>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    readonly maxEntries = Math.max(50, Number(process.env.ETLA_CACHE_MAX_ENTRIES || 2_000)),
    readonly maxBytes = Math.max(1_000_000, Number(process.env.ETLA_CACHE_MAX_BYTES || 64 * 1024 * 1024)),
  ) {}

  get<T>(key: string, revisions: CacheDependencyRevision = {}): T | undefined {
    const record = this.records.get(key) as CacheRecord<T> | undefined;
    if (!record) {
      this.misses += 1;
      incrementMetric('runtime_cache_requests_total', { result: 'miss', namespace: key.split(':')[0] });
      return undefined;
    }
    if (record.expiresAt <= Date.now() || !revisionsMatch(record.revisions, revisions)) {
      this.delete(key);
      this.misses += 1;
      incrementMetric('runtime_cache_requests_total', { result: 'stale', namespace: key.split(':')[0] });
      return undefined;
    }
    record.lastAccessedAt = Date.now();
    record.hits += 1;
    this.records.delete(key);
    this.records.set(key, record);
    this.hits += 1;
    incrementMetric('runtime_cache_requests_total', { result: 'hit', namespace: key.split(':')[0] });
    return record.value;
  }

  set<T>(
    key: string,
    value: T,
    options: { ttlMs?: number; revisions?: CacheDependencyRevision } = {},
  ): T {
    const ttlMs = Math.max(1_000, Math.min(options.ttlMs || 60_000, 24 * 60 * 60 * 1000));
    const bytes = estimateBytes(value);
    if (bytes > this.maxBytes) return value;
    this.delete(key);
    const now = Date.now();
    this.records.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      lastAccessedAt: now,
      hits: 0,
      bytes,
      revisions: options.revisions || {},
    });
    this.totalBytes += bytes;
    this.evictIfNeeded();
    this.updateGauges();
    return value;
  }

  remember<T>(
    namespace: CacheNamespace,
    input: unknown,
    revisions: CacheDependencyRevision,
    producer: () => T,
    options: { ttlMs?: number } = {},
  ): T {
    const key = runtimeCacheKey(namespace, input, revisions);
    const cached = this.get<T>(key, revisions);
    if (cached !== undefined) return cached;
    return this.set(key, producer(), { ttlMs: options.ttlMs, revisions });
  }

  async rememberAsync<T>(
    namespace: CacheNamespace,
    input: unknown,
    revisions: CacheDependencyRevision,
    producer: () => Promise<T>,
    options: { ttlMs?: number; cacheErrors?: boolean } = {},
  ): Promise<T> {
    const key = runtimeCacheKey(namespace, input, revisions);
    const cached = this.get<T>(key, revisions);
    if (cached !== undefined) return cached;
    try {
      const value = await producer();
      return this.set(key, value, { ttlMs: options.ttlMs, revisions });
    } catch (error) {
      if (options.cacheErrors) this.set(key, { error: error instanceof Error ? error.message : String(error) }, { ttlMs: 5_000, revisions });
      throw error;
    }
  }

  delete(key: string): boolean {
    const current = this.records.get(key);
    if (!current) return false;
    this.records.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - current.bytes);
    this.updateGauges();
    return true;
  }

  invalidateNamespace(namespace: CacheNamespace): number {
    let removed = 0;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(`${namespace}:`) && this.delete(key)) removed += 1;
    }
    incrementMetric('runtime_cache_invalidations_total', { namespace }, removed);
    return removed;
  }

  clear(): void {
    this.records.clear();
    this.totalBytes = 0;
    this.updateGauges();
  }

  stats(): RuntimeCacheStats {
    const namespaces: Record<string, number> = {};
    for (const key of this.records.keys()) {
      const namespace = key.split(':')[0];
      namespaces[namespace] = (namespaces[namespace] || 0) + 1;
    }
    return {
      entries: this.records.size,
      bytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      namespaces,
    };
  }

  private evictIfNeeded(): void {
    const now = Date.now();
    for (const [key, record] of [...this.records]) {
      if (record.expiresAt <= now) this.delete(key);
    }
    while (this.records.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
      this.evictions += 1;
      incrementMetric('runtime_cache_evictions_total');
    }
  }

  private updateGauges(): void {
    setGauge('runtime_cache_entries', this.records.size);
    setGauge('runtime_cache_bytes', this.totalBytes);
  }
}

let singleton: RuntimeCache | undefined;

export function getRuntimeCache(): RuntimeCache {
  if (!singleton) singleton = new RuntimeCache();
  return singleton;
}

export function resetRuntimeCacheForTests(): RuntimeCache {
  singleton = new RuntimeCache(100, 4 * 1024 * 1024);
  return singleton;
}
