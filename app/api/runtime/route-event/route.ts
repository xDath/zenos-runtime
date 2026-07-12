import { z } from 'zod';
import { RouteEventSchema, routeEventMemoryContent } from '@/app/lib/zenos-runtime';
import { persistRouteEventToMemory } from '@/app/lib/zenos-memory-client';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.route-event';
const RouteEventRequestSchema = z.object({
  namespace: z.string().trim().min(1).max(120).optional().default('zenos'),
  runId: z.string().max(220).optional(),
  sessionId: z.string().max(220).optional(),
  event: RouteEventSchema,
  persistToMemory: z.boolean().optional().default(true),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.write, maxBodyBytes: 512_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, RouteEventRequestSchema, 512_000);
    const event = RouteEventSchema.parse(parsed.event);
    const namespace = parsed.namespace || 'zenos';
    const content = routeEventMemoryContent(event);
    const memory = parsed.persistToMemory !== false
      ? await persistRouteEventToMemory({ namespace, event, runId: parsed.runId, sessionId: parsed.sessionId })
      : { ok: false, skipped: true, error: 'Memory persistence disabled by request' };
    const localEventId = getRuntimeStore().saveRouteEvent({
      runId: parsed.runId,
      sessionId: parsed.sessionId,
      namespace,
      event,
      memoryStatus: memory.ok ? 'persisted' : memory.skipped ? 'skipped' : 'failed',
      memoryResponse: memory.value || memory.error,
    });
    return routeSuccessResponse({
      ok: true,
      localEventId,
      content,
      memory: { ok: memory.ok, skipped: memory.skipped, status: memory.status, latencyMs: memory.latencyMs, error: memory.error },
    }, secured.context, ROUTE, memory.ok || memory.skipped ? 201 : 202);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
