import { ZodError, ZodType } from 'zod';
import { authorizeRequest, AuthContext, RuntimeScope } from './auth';
import { clientIp, checkRateLimit, RateLimitPolicy, RateLimitResult } from './rate-limit';
import { incrementMetric, observeDuration } from './metrics';
import { log, requestIdFromHeaders } from './logger';

export type RequestContext = {
  requestId: string;
  ip: string;
  auth: AuthContext;
  startedAt: number;
  rateLimit: RateLimitResult;
};

export type SecureRequestResult =
  | { ok: true; context: RequestContext }
  | { ok: false; response: Response };

function commonHeaders(requestId: string): HeadersInit {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Request-Id': requestId,
  };
}

export function jsonResponse(
  data: unknown,
  options: { status?: number; requestId?: string; headers?: HeadersInit } = {},
): Response {
  const requestId = options.requestId || 'untracked';
  return Response.json(data, {
    status: options.status || 200,
    headers: { ...commonHeaders(requestId), ...(options.headers || {}) },
  });
}

export async function secureRequest(
  request: Request,
  options: {
    scope: RuntimeScope;
    rateLimit: RateLimitPolicy;
    maxBodyBytes?: number;
    routeName: string;
  },
): Promise<SecureRequestResult> {
  const requestId = requestIdFromHeaders(request.headers);
  const ip = clientIp(request.headers);
  const startedAt = Date.now();
  const preAuthLimit = checkRateLimit(`preauth:${ip}:${options.routeName}`, {
    capacity: Math.max(options.rateLimit.capacity * 2, 20),
    refillPerSecond: Math.max(options.rateLimit.refillPerSecond * 2, 0.2),
  });
  if (!preAuthLimit.allowed) {
    incrementMetric('http_requests_total', { route: options.routeName, status: 429 });
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, error: 'Rate limit exceeded', requestId },
        {
          status: 429,
          requestId,
          headers: {
            'Retry-After': String(preAuthLimit.retryAfterSeconds),
            'X-RateLimit-Limit': String(preAuthLimit.limit),
            'X-RateLimit-Remaining': String(preAuthLimit.remaining),
          },
        },
      ),
    };
  }

  const authorization = await authorizeRequest(request, options.scope, { maxBodyBytes: options.maxBodyBytes });
  if (!authorization.ok) {
    incrementMetric('http_requests_total', { route: options.routeName, status: authorization.status });
    log('warn', 'Request authorization rejected', {
      requestId,
      route: options.routeName,
      status: authorization.status,
      ip,
      reason: authorization.error,
    });
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, error: authorization.error, requestId },
        { status: authorization.status, requestId },
      ),
    };
  }

  const limit = checkRateLimit(`${authorization.context.clientId}:${ip}:${options.routeName}`, options.rateLimit);
  if (!limit.allowed) {
    incrementMetric('http_requests_total', { route: options.routeName, status: 429 });
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, error: 'Rate limit exceeded', requestId },
        {
          status: 429,
          requestId,
          headers: {
            'Retry-After': String(limit.retryAfterSeconds),
            'X-RateLimit-Limit': String(limit.limit),
            'X-RateLimit-Remaining': String(limit.remaining),
          },
        },
      ),
    };
  }

  incrementMetric('http_requests_total', { route: options.routeName, method: request.method, auth: authorization.context.method });
  return {
    ok: true,
    context: { requestId, ip, auth: authorization.context, startedAt, rateLimit: limit },
  };
}

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  maxBodyBytes = 1_048_576,
): Promise<T> {
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > maxBodyBytes) throw new HttpError(413, 'Request body is too large');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) throw new HttpError(413, 'Request body is too large');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  return schema.parse(parsed);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function routeErrorResponse(error: unknown, context: RequestContext, routeName: string): Response {
  const durationMs = observeDuration('http_request_duration', context.startedAt, { route: routeName });
  if (error instanceof HttpError) {
    incrementMetric('http_responses_total', { route: routeName, status: error.status });
    return jsonResponse({ ok: false, error: error.message, requestId: context.requestId }, { status: error.status, requestId: context.requestId });
  }
  if (error instanceof ZodError) {
    incrementMetric('http_responses_total', { route: routeName, status: 400 });
    return jsonResponse({
      ok: false,
      error: 'Request validation failed',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      requestId: context.requestId,
    }, { status: 400, requestId: context.requestId });
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  incrementMetric('http_responses_total', { route: routeName, status: 500 });
  log('error', 'Route failed', { requestId: context.requestId, route: routeName, durationMs, error });
  return jsonResponse({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
    requestId: context.requestId,
  }, { status: 500, requestId: context.requestId });
}

export function routeSuccessResponse(
  data: unknown,
  context: RequestContext,
  routeName: string,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const durationMs = observeDuration('http_request_duration', context.startedAt, { route: routeName });
  incrementMetric('http_responses_total', { route: routeName, status });
  return jsonResponse(data, {
    status,
    requestId: context.requestId,
    headers: {
      'X-RateLimit-Limit': String(context.rateLimit.limit),
      'X-RateLimit-Remaining': String(context.rateLimit.remaining),
      'Server-Timing': `app;dur=${durationMs}`,
      ...headers,
    },
  });
}
