import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeModels, getRuntimeSession, updateSessionModelOverrides } from '@/app/lib/zenos-runtime-three-agent';
import { getRuntimeModelConfigSummary } from '@/app/lib/zenos-runtime-executor';
import { mergeModelSlots, readSessionModelSlots, RuntimeModelSlotsSchema, writeRuntimeModelSlots, writeSessionModelSlots } from '@/app/lib/zenos-runtime-model-config';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

function sessionIdFrom(req: NextRequest): string {
  return req.nextUrl.searchParams.get('sessionId') || req.headers.get('x-runtime-session') || '';
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();

  const sessionId = sessionIdFrom(req);
  const session = sessionId ? getRuntimeSession(sessionId) : undefined;
  const sessionConfig = session?.modelOverrides || readSessionModelSlots(sessionId);
  const globalConfig = getRuntimeModelConfigSummary();
  const config = sessionId ? mergeModelSlots(globalConfig, sessionConfig) : globalConfig;

  return NextResponse.json({ ok: true, sessionId: sessionId || null, config, sessionConfig, runtime: getRuntimeModels() });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();

  try {
    const sessionId = sessionIdFrom(req);
    const body = RuntimeModelSlotsSchema.parse(await req.json());

    if (sessionId) {
      const saved = writeSessionModelSlots(sessionId, body);
      const session = getRuntimeSession(sessionId) ? updateSessionModelOverrides(sessionId, saved) : null;
      return NextResponse.json({ ok: true, scope: 'session', sessionId, saved, session, config: mergeModelSlots(getRuntimeModelConfigSummary(), saved) });
    }

    const saved = writeRuntimeModelSlots(body);
    return NextResponse.json({ ok: true, scope: 'global', saved, config: getRuntimeModelConfigSummary() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime model config';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
