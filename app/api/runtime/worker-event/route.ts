import { recordWorkerEvent } from '@/app/lib/zenos-runtime-three-agent';
import { WorkerEventSchema } from '@/app/lib/zenos-runtime-state';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.worker-event';

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.write, maxBodyBytes: 512_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const event = await parseJsonBody(req, WorkerEventSchema, 512_000);
    return routeSuccessResponse({ ok: true, session: recordWorkerEvent(event) }, secured.context, ROUTE, 201);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
