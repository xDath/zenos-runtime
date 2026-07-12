type Bucket = {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
};

export type RateLimitPolicy = {
  capacity: number;
  refillPerSecond: number;
  cost?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
};

export const RATE_LIMITS = {
  read: { capacity: 180, refillPerSecond: 3 },
  write: { capacity: 60, refillPerSecond: 1 },
  model: { capacity: 20, refillPerSecond: 0.25 },
  expensive: { capacity: 8, refillPerSecond: 0.05 },
  stream: { capacity: 12, refillPerSecond: 0.1 },
} satisfies Record<string, RateLimitPolicy>;

const buckets = new Map<string, Bucket>();
let operations = 0;

function cleanup(now: number): void {
  operations += 1;
  if (operations % 500 !== 0) return;
  const staleBefore = now - 60 * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastSeen < staleBefore) buckets.delete(key);
  }
}

export function checkRateLimit(key: string, policy: RateLimitPolicy): RateLimitResult {
  const now = Date.now();
  cleanup(now);
  const cost = Math.max(policy.cost || 1, 0.001);
  const current = buckets.get(key) || { tokens: policy.capacity, lastRefill: now, lastSeen: now };
  const elapsedSeconds = Math.max(0, now - current.lastRefill) / 1000;
  const tokens = Math.min(policy.capacity, current.tokens + elapsedSeconds * policy.refillPerSecond);
  const allowed = tokens >= cost;
  const nextTokens = allowed ? tokens - cost : tokens;
  buckets.set(key, { tokens: nextTokens, lastRefill: now, lastSeen: now });
  const deficit = Math.max(0, cost - nextTokens);
  const retryAfterSeconds = allowed || policy.refillPerSecond <= 0
    ? 0
    : Math.max(1, Math.ceil(deficit / policy.refillPerSecond));
  return {
    allowed,
    remaining: Math.max(0, Math.floor(nextTokens)),
    retryAfterSeconds,
    limit: policy.capacity,
  };
}

export function clientIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp.slice(0, 128);
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (forwarded || 'unknown').slice(0, 128);
}

export function rateLimit(key: string, limit = 60, windowMs = 60_000): boolean {
  const policy = {
    capacity: limit,
    refillPerSecond: limit / Math.max(windowMs / 1000, 1),
  };
  return checkRateLimit(key, policy).allowed;
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
  operations = 0;
}
