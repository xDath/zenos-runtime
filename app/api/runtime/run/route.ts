import { NextRequest, NextResponse } from 'next/server';
import { runZenosPipeline, RuntimeRunRequestSchema } from '@/app/lib/zenos-runtime-executor';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }
  if (!validateApiKey(req)) {
    return unauthorizedResponse();
  }

  try {
    const body = await req.json();
    const parsed = RuntimeRunRequestSchema.parse(body);
    const result = await runZenosPipeline(parsed);
    return NextResponse.json({ ok: result.ok, result }, { status: result.ok ? 200 : 502 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime run request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/runtime/run',
    method: 'POST',
    description: 'Run the Host/Worker/Verifier pipeline. Use dryRun=true to test routing without model calls.',
  });
}
