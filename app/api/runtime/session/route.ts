import { NextRequest, NextResponse } from 'next/server';
import { createRuntimeSession, listRuntimeSessions } from '@/app/lib/zenos-runtime-three-agent';
import { RuntimeContextSchema } from '@/app/lib/zenos-runtime';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const body = RuntimeContextSchema.parse(await req.json());
    return NextResponse.json({ ok: true, session: createRuntimeSession(body) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime session request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  return NextResponse.json({ ok: true, sessions: listRuntimeSessions() });
}
