import { getRuntimeModels, getRuntimeSession, updateSessionModelOverrides } from '@/app/lib/zenos-runtime-three-agent';
import { getRuntimeModelConfigSummary } from '@/app/lib/zenos-runtime-executor';
import {
  publicModelSlots,
  readSessionModelSlots,
  RuntimeModelSlotsSchema,
  writeRuntimeModelSlots,
  writeSessionModelSlots,
} from '@/app/lib/zenos-runtime-model-config';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.models';

function sessionIdFrom(req: Request): string {
  const url = new URL(req.url);
  return url.searchParams.get('sessionId') || req.headers.get('x-runtime-session') || '';
}

export async function GET(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: `${ROUTE}.get` });
  if (!secured.ok) return secured.response;
  try {
    const sessionId = sessionIdFrom(req);
    const session = sessionId ? getRuntimeSession(sessionId) : undefined;
    const sessionConfig = sessionId ? readSessionModelSlots(sessionId) : {};
    return routeSuccessResponse({
      ok: true,
      sessionId: sessionId || null,
      config: getRuntimeModelConfigSummary(sessionId || undefined),
      sessionConfig: publicModelSlots(session?.modelOverrides || sessionConfig),
      runtime: getRuntimeModels(),
    }, secured.context, `${ROUTE}.get`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.get`);
  }
}

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:models', rateLimit: RATE_LIMITS.write, maxBodyBytes: 256_000, routeName: `${ROUTE}.set` });
  if (!secured.ok) return secured.response;
  try {
    const sessionId = sessionIdFrom(req);
    const body = await parseJsonBody(req, RuntimeModelSlotsSchema, 256_000);
    if (sessionId) {
      const saved = writeSessionModelSlots(sessionId, body);
      const session = getRuntimeSession(sessionId) ? updateSessionModelOverrides(sessionId, saved) : null;
      return routeSuccessResponse({
        ok: true,
        scope: 'session',
        sessionId,
        saved: publicModelSlots(saved),
        session,
        config: getRuntimeModelConfigSummary(sessionId),
      }, secured.context, `${ROUTE}.set`);
    }
    const saved = writeRuntimeModelSlots(body);
    return routeSuccessResponse({ ok: true, scope: 'global', saved: publicModelSlots(saved), config: getRuntimeModelConfigSummary() }, secured.context, `${ROUTE}.set`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.set`);
  }
}
