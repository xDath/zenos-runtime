import { NextRequest, NextResponse } from 'next/server';
import { runRuntimeEval } from '@/app/lib/zenos-runtime';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }
  if (!validateApiKey(req)) {
    return unauthorizedResponse();
  }

  const report = runRuntimeEval();
  return NextResponse.json({
    ok: report.status === 'pass',
    productionReady: report.status === 'pass',
    report,
  });
}
