import { z } from 'zod';
import { issueScopedToken } from '@/app/lib/auth';
import { HttpError, parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.token';
const ScopeSchema = z.enum(['runtime:read', 'runtime:route', 'runtime:run', 'runtime:session', 'runtime:worker', 'runtime:models', 'runtime:admin', 'runtime:metrics', '*']);
const TokenRequestSchema = z.object({
  subject: z.string().trim().min(1).max(120).optional(),
  scopes: z.array(ScopeSchema).min(1).max(20).optional(),
  ttlSeconds: z.number().int().min(30).max(86_400).optional().default(900),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:admin', rateLimit: RATE_LIMITS.write, maxBodyBytes: 64_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, TokenRequestSchema, 64_000);
    const secret = process.env.ETLA_MASTER_SECRET || '';
    if (!secret) throw new HttpError(503, 'ETLA_MASTER_SECRET is required to issue scoped tokens');
    const ttlSeconds = parsed.ttlSeconds ?? 900;
    const token = issueScopedToken(secret, {
      subject: parsed.subject || secured.context.auth.clientId,
      scopes: parsed.scopes,
      ttlMs: ttlSeconds * 1000,
    });
    return routeSuccessResponse({
      ok: true,
      token,
      tokenType: 'Bearer',
      expiresIn: ttlSeconds,
      scopes: parsed.scopes || ['runtime:read'],
    }, secured.context, ROUTE, 201);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
