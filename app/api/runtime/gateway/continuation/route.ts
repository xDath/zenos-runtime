import { z } from 'zod';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { HttpError, parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.gateway.continuation';

const ContinuationActionSchema = z.object({
  continuationId: z.string().trim().min(1).max(220),
  leaseToken: z.string().trim().min(16).max(500),
  action: z.enum(['heartbeat', 'complete', 'cancel']),
});

const RecoveryCutoffSchema = z.string().datetime({ offset: true }).optional();

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
    const recoverLeasedBefore = RecoveryCutoffSchema.parse(
      String(url.searchParams.get('recoverLeasedBefore') || '').trim() || undefined,
    );
    const leaseOwner = String(url.searchParams.get('leaseOwner') || 'hermes-gateway').trim().slice(0, 220);
    const store = getRuntimeStore();
    store.reconcileContinuationState();
    const continuation = store.claimContinuationForSession(
      sessionId,
      30 * 60_000,
      recoverLeasedBefore,
      leaseOwner,
    );
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
    let continuation;
    try {
      continuation = body.action === 'heartbeat'
        ? getRuntimeStore().heartbeatContinuation(body.continuationId, body.leaseToken)
        : getRuntimeStore().completeContinuation(
            body.continuationId,
            body.action === 'cancel',
            body.leaseToken,
          );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Continuation lease conflict';
      if (/lease|token|leased/i.test(message)) throw new HttpError(409, message);
      throw error;
    }
    return routeSuccessResponse({ ok: true, continuation: continuation || null }, secured.context, `${ROUTE}.complete`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.complete`);
  }
}
