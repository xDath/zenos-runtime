import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { dispatchWorker, workerTemplates } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

const DispatchSchema = z.object({
  sessionId: z.string().min(1),
  template: z.enum(Object.keys(workerTemplates) as [keyof typeof workerTemplates, ...(keyof typeof workerTemplates)[]]),
  task: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(req)) return unauthorizedResponse();
  try {
    const parsed = DispatchSchema.parse(await req.json());
    return NextResponse.json({ ok: true, session: dispatchWorker(parsed.sessionId, parsed.template, parsed.task) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime dispatch request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
