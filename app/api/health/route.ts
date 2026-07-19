import { ZENOS_RUNTIME_VERSION } from '@/app/lib/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    status: 'alive',
    service: 'zenos-runtime',
    version: ZENOS_RUNTIME_VERSION,
    architecture: 'host-led-cognitive-runtime-v1',
    orchestrationMode: 'host-led',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
