import { z } from 'zod';
import { buildEscalationPacket, updateRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.escalate';
const EscalateSchema = z.object({
  sessionId: z.string().min(1).max(220),
  hostAssessment: z.string().max(20_000).optional(),
  currentDraft: z.string().max(200_000).optional(),
  runId: z.string().max(220).optional(),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.write, maxBodyBytes: 512_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, EscalateSchema, 512_000);
    updateRuntimeSession(parsed.sessionId, { status: 'boss_review' });
    const packet = buildEscalationPacket(parsed.sessionId, parsed.hostAssessment, { currentDraft: parsed.currentDraft, runId: parsed.runId });
    return routeSuccessResponse({ ok: true, packet }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
