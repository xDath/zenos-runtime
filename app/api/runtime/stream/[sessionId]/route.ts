import { getRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

const ROUTE = 'runtime.stream';
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(req: Request, context: Context) {
  const secured = await secureRequest(req, { scope: 'runtime:read', rateLimit: RATE_LIMITS.stream, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  const { sessionId } = await context.params;
  const initial = getRuntimeSession(sessionId);
  if (!initial) {
    return Response.json({ ok: false, error: 'Runtime session not found', requestId: secured.context.requestId }, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': secured.context.requestId } });
  }

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        try { controller.close(); } catch { /* stream already closed */ }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let lastVersion = -1;
      let lastEventId = 0;
      let heartbeats = 0;
      send('connected', { sessionId, requestId: secured.context.requestId, timestamp: new Date().toISOString() });
      interval = setInterval(() => {
        const session = getRuntimeSession(sessionId);
        if (!session) {
          send('error', { message: 'Runtime session not found', sessionId });
          close();
          return;
        }
        const newEvents = session.events.filter((event) => (event.eventId || 0) > lastEventId);
        for (const event of newEvents) {
          lastEventId = Math.max(lastEventId, event.eventId || 0);
          send('activity', {
            ...event,
            role: typeof event.metadata.role === 'string' ? event.metadata.role : event.workerId.replace(/^runtime-/, ''),
          });
        }
        if (session.version !== lastVersion) {
          lastVersion = session.version;
          send('session', session);
        } else {
          heartbeats += 1;
          send('heartbeat', { sessionId, status: session.status, version: session.version, heartbeat: heartbeats, timestamp: new Date().toISOString() });
        }
        if (['done', 'failed', 'cancelled'].includes(session.status) || heartbeats >= 1800) close();
      }, 1000);
      req.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': secured.context.requestId,
    },
  });
}
