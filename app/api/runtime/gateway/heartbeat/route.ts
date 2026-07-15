import { z } from 'zod';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.gateway.heartbeat';
const HeartbeatSchema = z.object({
  sessionId: z.string().trim().min(1).max(220),
  runId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220).optional(),
  leaseMs: z.number().int().min(60_000).max(60 * 60_000).default(10 * 60_000),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.write,
    maxBodyBytes: 16_000,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, HeartbeatSchema, 16_000);
    const store = getRuntimeStore();
    const run = store.getRun(body.runId);
    if (!run || run.sessionId !== body.sessionId) {
      return routeSuccessResponse({ ok: false, error: 'Runtime run not found for this session' }, secured.context, ROUTE, 404);
    }
    const heartbeat = store.heartbeatRun(body.runId, body.leaseMs);
    return routeSuccessResponse({ ok: true, run: heartbeat }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
