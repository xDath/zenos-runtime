import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.runs.get';
type Context = { params: Promise<{ runId: string }> };

export async function GET(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const { runId } = await context.params;
    const run = getRuntimeStore().getRun(runId);
    if (!run) return routeSuccessResponse({ ok: false, error: 'Runtime run not found' }, secured.context, ROUTE, 404);
    return routeSuccessResponse({ ok: true, run }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
