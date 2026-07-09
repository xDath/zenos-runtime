import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyBossDecision, BossDecisionSchema, buildEscalationPacket } from '@/app/lib/zenos-runtime-three-agent';
import { runBossReviewModel } from '@/app/lib/zenos-runtime-executor';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

const BossReviewSchema = z.object({
  sessionId: z.string().min(1),
  decision: BossDecisionSchema.optional(),
  hostAssessment: z.string().optional(),
  auto: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const parsed = BossReviewSchema.parse(await req.json());

    if (parsed.decision) {
      return NextResponse.json({ ok: true, source: 'provided', session: applyBossDecision(parsed.sessionId, parsed.decision) });
    }

    if (!parsed.auto) {
      return NextResponse.json({ ok: false, error: 'Provide decision or set auto=true' }, { status: 400 });
    }

    const packet = buildEscalationPacket(parsed.sessionId, parsed.hostAssessment);
    const call = await runBossReviewModel(packet);
    if (!call.ok || !call.parsed) {
      return NextResponse.json({ ok: false, packet, call }, { status: 502 });
    }

    const decision = BossDecisionSchema.parse(call.parsed);
    return NextResponse.json({ ok: true, source: 'model', packet, decision, call, session: applyBossDecision(parsed.sessionId, decision) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid boss review request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
