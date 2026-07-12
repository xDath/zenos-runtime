import { buildRuntimeReadiness } from '@/app/lib/readiness';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ROUTE = 'runtime.readiness';

export async function GET(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const url = new URL(req.url);
    const report = await buildRuntimeReadiness({ includeDependencies: url.searchParams.get('dependencies') !== 'false' });
    return routeSuccessResponse(report, secured.context, ROUTE, report.ok ? 200 : 503);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
