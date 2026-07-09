import { NextRequest, NextResponse } from 'next/server';
import { runtimeReadinessReport } from '@/app/lib/zenos-runtime';
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

  const report = runtimeReadinessReport();
  return NextResponse.json({
    ok: report.status === 'production_ready_v1',
    report,
  });
}
