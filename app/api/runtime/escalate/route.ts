import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildEscalationPacket } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

const EscalateSchema = z.object({ sessionId: z.string().min(1), hostAssessment: z.string().optional() });

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const parsed = EscalateSchema.parse(await req.json());
    return NextResponse.json({ ok: true, packet: buildEscalationPacket(parsed.sessionId, parsed.hostAssessment) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid escalation request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
