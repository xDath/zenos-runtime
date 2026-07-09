import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyBossDecision, BossDecisionSchema } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

const BossReviewSchema = z.object({ sessionId: z.string().min(1), decision: BossDecisionSchema });

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const parsed = BossReviewSchema.parse(await req.json());
    return NextResponse.json({ ok: true, session: applyBossDecision(parsed.sessionId, parsed.decision) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid boss review request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
