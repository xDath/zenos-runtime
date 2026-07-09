import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeModels } from '@/app/lib/zenos-runtime-three-agent';
import { getRuntimeModelConfigSummary } from '@/app/lib/zenos-runtime-executor';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  return NextResponse.json({ ok: true, config: getRuntimeModelConfigSummary(), runtime: getRuntimeModels() });
}
