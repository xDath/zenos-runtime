import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'zenos-runtime',
    version: '0.1.0',
    phase: 'runtime-orchestration',
    timestamp: new Date().toISOString(),
  });
}
