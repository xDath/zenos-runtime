import { z } from 'zod';
import { applyBossDecision, buildEscalationPacket } from '@/app/lib/zenos-runtime-three-agent';
import { BossDecisionSchema } from '@/app/lib/zenos-runtime-state';
import { runBossReviewModel } from '@/app/lib/zenos-runtime-executor';
import { HttpError, parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = 'runtime.boss-review';
const BossReviewSchema = z.object({
  sessionId: z.string().min(1).max(220),
  decision: BossDecisionSchema.optional(),
  hostAssessment: z.string().max(20_000).optional(),
  currentDraft: z.string().max(200_000).optional(),
  runId: z.string().max(220).optional(),
  auto: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:worker', rateLimit: RATE_LIMITS.expensive, maxBodyBytes: 1_000_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  try {
    const parsed = await parseJsonBody(req, BossReviewSchema, 1_000_000);
    if (parsed.decision) {
      return routeSuccessResponse({ ok: true, source: 'provided', decision: parsed.decision, session: applyBossDecision(parsed.sessionId, parsed.decision) }, secured.context, ROUTE);
    }
    if (!parsed.auto) throw new HttpError(400, 'Provide a Boss decision or set auto=true');

    const packet = buildEscalationPacket(parsed.sessionId, parsed.hostAssessment, { currentDraft: parsed.currentDraft, runId: parsed.runId });
    const call = await runBossReviewModel(packet, { sessionId: parsed.sessionId, requestId: `${secured.context.requestId}:boss` });
    if (!call.ok || !call.parsed) {
      return routeSuccessResponse({ ok: false, packet, call }, secured.context, ROUTE, 502);
    }
    const decision = BossDecisionSchema.parse(call.parsed);
    const session = applyBossDecision(parsed.sessionId, decision, {
      modelCall: true,
      usageTokens: call.usage.totalTokens,
    });
    return routeSuccessResponse({ ok: true, source: 'model', packet, decision, call, session }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
