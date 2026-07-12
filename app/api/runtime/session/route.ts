import { z } from 'zod';
import { createRuntimeSession, listRuntimeSessions } from '@/app/lib/zenos-runtime-three-agent';
import { RuntimeContextSchema } from '@/app/lib/zenos-runtime';
import { RuntimeModelSlotsSchema } from '@/app/lib/zenos-runtime-model-config';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.session';
const CreateSessionSchema = RuntimeContextSchema.extend({
  sessionId: z.string().min(1).max(220).optional(),
  modelOverrides: RuntimeModelSlotsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:session', rateLimit: RATE_LIMITS.write, maxBodyBytes: 512_000, routeName: `${ROUTE}.create` });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, CreateSessionSchema, 512_000);
    const { sessionId, modelOverrides, metadata, ...context } = body;
    const session = createRuntimeSession(context, { sessionId, modelOverrides, metadata: { ...(metadata || {}), clientId: secured.context.auth.clientId } });
    return routeSuccessResponse({ ok: true, session }, secured.context, `${ROUTE}.create`, 201);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.create`);
  }
}

export async function GET(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: `${ROUTE}.list` });
  if (!secured.ok) return secured.response;
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || '100'), 1), 500);
    return routeSuccessResponse({ ok: true, sessions: listRuntimeSessions(limit) }, secured.context, `${ROUTE}.list`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.list`);
  }
}
