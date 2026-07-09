import { NextRequest, NextResponse } from 'next/server';
import { recordWorkerEvent, WorkerEventSchema } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const event = WorkerEventSchema.parse(await req.json());
    return NextResponse.json({ ok: true, session: recordWorkerEvent(event) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid worker event request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
