import { NextRequest } from 'next/server';
import { getRuntimeSession } from '@/app/lib/zenos-runtime-three-agent';
import { validateApiKey } from '@/app/lib/auth';

export async function GET(req: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  if (!validateApiKey(req)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { sessionId } = await context.params;
  const encoder = new TextEncoder();
  let lastEventCount = -1;
  let ticks = 0;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const interval = setInterval(() => {
        const session = getRuntimeSession(sessionId);
        ticks += 1;

        if (!session) {
          send('error', { message: 'Runtime session not found', sessionId });
          clearInterval(interval);
          controller.close();
          return;
        }

        if (session.events.length !== lastEventCount) {
          lastEventCount = session.events.length;
          send('session', session);
        } else {
          send('heartbeat', { sessionId, status: session.status, events: session.events.length });
        }

        if (['done', 'failed'].includes(session.status) || ticks >= 1800) {
          clearInterval(interval);
          controller.close();
        }
      }, 1000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
