import { z } from 'zod';
import { updateCognitiveTask } from '@/app/lib/cognitive-task';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.gateway.abort';
const AbortSchema = z.object({
  sessionId: z.string().trim().min(1).max(220),
  runId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220).optional(),
  reason: z.string().trim().min(1).max(4_000),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.write,
    maxBodyBytes: 32_000,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, AbortSchema, 32_000);
    const store = getRuntimeStore();
    const run = store.getRun(body.runId);
    const activeCodingTasks = store.listCodingTasks(500, 'active')
      .filter((task) => task.runId === body.runId);
    if (run?.sessionId && run.sessionId !== body.sessionId) {
      return routeSuccessResponse({ ok: false, error: 'Runtime run not found for this session' }, secured.context, ROUTE, 404);
    }
    if (!run && !activeCodingTasks.some((task) => task.sessionId === body.sessionId)) {
      return routeSuccessResponse({ ok: false, error: 'Runtime run or coding task not found for this session' }, secured.context, ROUTE, 404);
    }
    const abortReason = `Gateway aborted the turn: ${body.reason}`;
    const abandoned = run ? store.abandonRun(body.runId, abortReason) : undefined;
    const codingTasks = store.cancelCodingTasksForRun(body.runId, abortReason);
    const continuations = store.cancelContinuationsForRun(body.runId);
    const cognitiveTasks = store.listCognitiveTasks(500)
      .filter((task) => task.rootRunId === body.runId || task.activeRunId === body.runId)
      .map((task) => updateCognitiveTask({
        taskId: task.taskId,
        runId: body.runId,
        status: 'cancelled',
        pending: [],
        failures: [abortReason],
        store,
      }));
    return routeSuccessResponse({
      ok: true,
      run: abandoned,
      codingTask: codingTasks[0]?.state,
      codingTaskRecords: codingTasks,
      cognitiveTasks,
      continuationRecords: continuations,
    }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
