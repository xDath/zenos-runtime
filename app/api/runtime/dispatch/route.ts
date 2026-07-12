import { z } from 'zod';
import { dispatchWorker, getRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { WorkerTemplateName, workerTemplates } from '@/app/lib/zenos-runtime-state';
import { executeManagedWorker } from '@/app/lib/zenos-runtime-executor';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = 'runtime.dispatch';
const templateNames = Object.keys(workerTemplates) as [WorkerTemplateName, ...WorkerTemplateName[]];
const DispatchSchema = z.object({
  sessionId: z.string().min(1).max(220),
  template: z.enum(templateNames),
  task: z.string().trim().min(1).max(20_000),
  mode: z.enum(['managed', 'external']).optional().default('managed'),
  context: z.string().max(500_000).optional().default(''),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.model, maxBodyBytes: 1_000_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, DispatchSchema, 1_000_000);
    const before = getRuntimeSession(parsed.sessionId);
    if (!before) return routeSuccessResponse({ ok: false, error: 'Runtime session not found' }, secured.context, ROUTE, 404);
    const queued = dispatchWorker(parsed.sessionId, parsed.template, parsed.task);
    const worker = queued.workers.find((item) => !before.workers.some((existing) => existing.workerId === item.workerId));
    if (!worker) throw new Error('Worker lease was not created');

    if (parsed.mode === 'external') {
      return routeSuccessResponse({ ok: true, mode: 'external', worker, session: queued }, secured.context, ROUTE, 202);
    }

    const execution = await executeManagedWorker({
      sessionId: parsed.sessionId,
      workerId: worker.workerId,
      context: parsed.context,
      requestId: `${secured.context.requestId}:worker`,
    });
    return routeSuccessResponse({
      ok: execution.ok,
      mode: 'managed',
      worker: execution.worker,
      call: execution.call,
      session: getRuntimeSession(parsed.sessionId),
    }, secured.context, ROUTE, execution.ok ? 200 : 502);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
