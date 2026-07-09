import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { RouteEventSchema, routeEventMemoryContent } from '@/app/lib/zenos-runtime';
import { validateApiKey, unauthorizedResponse } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/rate-limit';

const RuntimeRouteEventRequestSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  event: RouteEventSchema,
  persist: z.boolean().optional().default(true),
});

async function persistRouteEventToMemory(namespace: string, content: string, event: z.infer<typeof RouteEventSchema>) {
  const baseUrl = (process.env.ZENOS_MEMORY_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.ZENOS_MEMORY_API_KEY || '';

  if (!baseUrl) {
    return { ok: false, skipped: true, reason: 'ZENOS_MEMORY_BASE_URL is not configured' };
  }

  const res = await fetch(`${baseUrl}/api/memory/remember`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      content,
      namespace,
      type: 'event',
      metadata: {
        confidence: 0.9,
        importance: event.verdict === 'failed' || event.verdict === 'blocked' ? 7 : 4,
        tags: ['zenos-runtime', 'route-event', event.taskType, event.pipelineMode],
        entities: ['Zenos Runtime', event.taskType, event.pipelineMode],
        provenance: {
          created_by: 'zenos-runtime',
          evidence: JSON.stringify(event),
        },
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, skipped: false, status: res.status, error: text.slice(0, 800) };

  try {
    return { ok: true, skipped: false, response: JSON.parse(text) };
  } catch {
    return { ok: true, skipped: false, response: text };
  }
}

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
    const parsed = RuntimeRouteEventRequestSchema.parse(body);
    const content = routeEventMemoryContent(parsed.event);

    if (!parsed.persist) {
      return NextResponse.json({ ok: true, persisted: false, content });
    }

    const memory = await persistRouteEventToMemory(parsed.namespace, content, parsed.event);
    return NextResponse.json({ ok: memory.ok, persisted: memory.ok, memory, content }, { status: memory.ok ? 201 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime route event request';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
