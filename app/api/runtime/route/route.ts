import { applyHostLedPolicy, hostLedRuntimeEnabled } from '@/app/lib/host-led-policy';
import { buildRouteEvent, choosePipeline, RuntimeContextSchema } from '@/app/lib/zenos-runtime';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.route';

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:route', rateLimit: RATE_LIMITS.write, maxBodyBytes: 256_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const context = await parseJsonBody(req, RuntimeContextSchema, 256_000);
    const baseline = choosePipeline(context);
    const decision = hostLedRuntimeEnabled()
      ? applyHostLedPolicy(baseline, {
          request: context.request,
          userRequestedVerification: Boolean(context.userRequestedVerification),
          userRequestedBoss: Boolean(context.userRequestedBoss),
        })
      : baseline;
    return routeSuccessResponse({ ok: true, decision, routeEvent: buildRouteEvent(decision, context) }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}

export async function GET() {
  return Response.json({
    endpoint: '/api/runtime/route',
    method: 'POST',
    description: 'Classify a request using the deterministic Zenos routing and risk policy.',
    auth: 'runtime:route',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
