import { z } from 'zod';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.gateway.continuation';

const ContinuationActionSchema = z.object({
  continuationId: z.string().trim().min(1).max(220),
  action: z.enum(['complete', 'cancel']),
});

export async function GET(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.read,
    routeName: `${ROUTE}.claim`,
  });
  if (!secured.ok) return secured.response;
  try {
    const url = new URL(req.url);
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    if (!sessionId) throw new Error('sessionId is required');
    const continuation = getRuntimeStore().claimContinuationForSession(sessionId);
    return routeSuccessResponse({ ok: true, continuation: continuation || null }, secured.context, `${ROUTE}.claim`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.claim`);
  }
}

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.write,
    maxBodyBytes: 32_000,
    routeName: `${ROUTE}.complete`,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, ContinuationActionSchema, 32_000);
    const continuation = getRuntimeStore().completeContinuation(body.continuationId, body.action === 'cancel');
    return routeSuccessResponse({ ok: true, continuation: continuation || null }, secured.context, `${ROUTE}.complete`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.complete`);
  }
}
