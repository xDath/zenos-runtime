import { NextRequest, NextResponse } from 'next/server';
import { buildRouteEvent, choosePipeline, RuntimeContextSchema } from '@/app/lib/zenos-runtime';
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
    const context = RuntimeContextSchema.parse(body);
    const decision = choosePipeline(context);
    const routeEvent = buildRouteEvent(decision, context);

    return NextResponse.json({
      ok: true,
      productionReady: true,
      decision,
      routeEvent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime route request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/runtime/route',
    method: 'POST',
    description: 'Classify a request and return Zenos Runtime routing policy.',
    productionReady: true,
  });
}
