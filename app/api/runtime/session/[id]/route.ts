import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  const { id } = await context.params;
  const session = getRuntimeSession(id);
  return NextResponse.json({ ok: Boolean(session), session: session || null }, { status: session ? 200 : 404 });
}
