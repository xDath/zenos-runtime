import {
  GatewayTurnPreflightRequestSchema,
  preflightGatewayTurn,
} from '@/app/lib/gateway-orchestration';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.gateway.preflight';

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.write,
    maxBodyBytes: 750_000,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, GatewayTurnPreflightRequestSchema, 750_000);
    const result = await preflightGatewayTurn(body);
    return routeSuccessResponse(result, secured.context, ROUTE, 201);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
