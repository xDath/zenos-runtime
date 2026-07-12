import { secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

const ROUTE = 'runtime.tracker.stream';

export async function GET(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:read',
    rateLimit: RATE_LIMITS.stream,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        try { controller.close(); } catch { /* already closed */ }
      };
      const initial = getRuntimeStore().listEvents({ limit: 1 });
      let lastEventId = initial[0]?.eventId || 0;
      let ticks = 0;
      send('connected', {
        requestId: secured.context.requestId,
        latestEventId: lastEventId,
        timestamp: new Date().toISOString(),
      });
      interval = setInterval(() => {
        try {
          const events = getRuntimeStore().listEvents({ afterEventId: lastEventId, limit: 500 });
          for (const event of events) {
            lastEventId = Math.max(lastEventId, event.eventId || 0);
            send('activity', event);
          }
          ticks += 1;
          if (ticks % 10 === 0) {
            send('heartbeat', {
              latestEventId: lastEventId,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          send('error', {
            message: error instanceof Error ? error.message : 'Runtime tracker stream failed',
          });
        }
      }, 500);
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
