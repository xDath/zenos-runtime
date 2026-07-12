import { runQualityGate } from '@/app/lib/zenos-runtime-three-agent';
import { QualityGateInputSchema } from '@/app/lib/zenos-runtime-state';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.quality-gate';

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.write, maxBodyBytes: 1_000_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, QualityGateInputSchema, 1_000_000);
    return routeSuccessResponse({ ok: true, result: runQualityGate(parsed) }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
