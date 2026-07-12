import { runRuntimeEval } from '@/app/lib/zenos-runtime';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.eval';

export async function GET(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const report = runRuntimeEval();
    return routeSuccessResponse({ ok: report.status === 'pass', report }, secured.context, ROUTE, report.status === 'pass' ? 200 : 503);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
