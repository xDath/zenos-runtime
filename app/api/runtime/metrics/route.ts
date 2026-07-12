import { metricsAsPrometheus, metricsSnapshot } from '@/app/lib/metrics';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.metrics';

export async function GET(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:metrics', rateLimit: RATE_LIMITS.read, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const accept = req.headers.get('accept') || '';
    if (accept.includes('text/plain') || new URL(req.url).searchParams.get('format') === 'prometheus') {
      return new Response(metricsAsPrometheus(), {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Request-Id': secured.context.requestId,
        },
      });
    }
    return routeSuccessResponse({ ok: true, metrics: metricsSnapshot() }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
