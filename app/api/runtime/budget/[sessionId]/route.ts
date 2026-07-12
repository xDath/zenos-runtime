import { getRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.budget';
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const { sessionId } = await context.params;
    const session = getRuntimeSession(sessionId);
    if (!session) return routeSuccessResponse({ ok: false, error: 'Runtime session not found' }, secured.context, ROUTE, 404);
    const budget = session.budget;
    return routeSuccessResponse({
      ok: true,
      sessionId,
      budget,
      remaining: {
        premiumTokens: Math.max(0, budget.maxPremiumTokens - budget.premiumTokensUsed),
        hostTokens: Math.max(0, budget.maxHostTokens - budget.hostTokensUsed),
        workerTokens: Math.max(0, budget.maxWorkerTokens - budget.workerTokensUsed),
        modelCalls: Math.max(0, budget.maxModelCalls - budget.modelCallsUsed),
      },
    }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
