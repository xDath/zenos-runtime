import { dispatchRemoteValidation, RemoteValidationRequestSchema } from '@/app/lib/github-remote-validation';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.remote-validation';

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:admin',
    rateLimit: RATE_LIMITS.expensive,
    maxBodyBytes: 256_000,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, RemoteValidationRequestSchema, 256_000);
    const result = await dispatchRemoteValidation(body);
    return routeSuccessResponse(result, secured.context, ROUTE, result.passed ? 200 : 422);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
