import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED_KEY]'],
  [/\b(?:ghp|github_pat|vcp|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, 'Bearer [REDACTED]'],
  [/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]'],
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactText(value).slice(0, 4_000);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: process.env.NODE_ENV === 'production' ? undefined : redactText(value.stack || ''),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/secret|password|token|api.?key|authorization|cookie/i.test(key)) {
        result[key] = nested ? '[REDACTED]' : nested;
      } else {
        result[key] = sanitize(nested, depth + 1);
      }
    }
    return result;
  }
  return value;
}

function shouldLog(level: LogLevel): boolean {
  const configured = (process.env.ZENOS_LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')) as LogLevel;
  const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return ranks[level] >= (ranks[configured] || ranks.info);
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (!shouldLog(level)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'zenos-runtime',
    message: redactText(message),
    ...sanitize(fields) as LogFields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function requestIdFromHeaders(headers: Headers): string {
  const candidate = headers.get('x-request-id')?.trim();
  return candidate && /^[A-Za-z0-9._:-]{8,128}$/.test(candidate) ? candidate : randomUUID();
}

export function hashForLog(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
