import { buildRuntimeTracker, TrackerRange } from '@/app/lib/runtime-tracker';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.tracker';
const RANGES = new Set<TrackerRange>(['today', '24h', '7d', '30d', '60d']);

export async function GET(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:read',
    rateLimit: RATE_LIMITS.read,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;

  try {
    const url = new URL(req.url);
    const requestedRange = url.searchParams.get('range') as TrackerRange | null;
    const range = requestedRange && RANGES.has(requestedRange) ? requestedRange : 'today';
    const sessionLimit = Math.min(Math.max(Number(url.searchParams.get('sessions') || '80'), 1), 200);
    const callLimit = Math.min(Math.max(Number(url.searchParams.get('calls') || '1000'), 1), 5_000);
    const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
    return routeSuccessResponse(buildRuntimeTracker({
      range,
      sessionLimit,
      callLimit,
      sessionId,
    }), secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
