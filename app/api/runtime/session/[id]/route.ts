import { z } from 'zod';
import { cancelRuntimeSession, getRuntimeSession, updateRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { RuntimeSessionStatusSchema } from '@/app/lib/zenos-runtime-state';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.session.detail';
const PatchSessionSchema = z.object({
  status: RuntimeSessionStatusSchema.optional(),
  finalAnswer: z.string().max(200_000).optional(),
  lastError: z.string().max(8_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one session field is required');

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.read, routeName: `${ROUTE}.get` });
  if (!secured.ok) return secured.response;
  try {
    const { id } = await context.params;
    const session = getRuntimeSession(id);
    if (!session) return routeSuccessResponse({ ok: false, error: 'Runtime session not found' }, secured.context, `${ROUTE}.get`, 404);
    return routeSuccessResponse({ ok: true, session }, secured.context, `${ROUTE}.get`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.get`);
  }
}

export async function PATCH(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:session', rateLimit: RATE_LIMITS.write, maxBodyBytes: 256_000, routeName: `${ROUTE}.patch` });
  if (!secured.ok) return secured.response;
  try {
    const { id } = await context.params;
    const patch = await parseJsonBody(req, PatchSessionSchema, 256_000);
    const current = getRuntimeSession(id);
    if (!current) return routeSuccessResponse({ ok: false, error: 'Runtime session not found' }, secured.context, `${ROUTE}.patch`, 404);
    const session = updateRuntimeSession(id, {
      ...patch,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    });
    return routeSuccessResponse({ ok: true, session }, secured.context, `${ROUTE}.patch`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.patch`);
  }
}

export async function DELETE(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:session', rateLimit: RATE_LIMITS.write, routeName: `${ROUTE}.cancel` });
  if (!secured.ok) return secured.response;
  try {
    const { id } = await context.params;
    const session = cancelRuntimeSession(id);
    return routeSuccessResponse({ ok: true, cancelled: true, session }, secured.context, `${ROUTE}.cancel`);
  } catch (error) {
    return routeErrorResponse(error, secured.context, `${ROUTE}.cancel`);
  }
}
