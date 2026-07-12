import * as crypto from 'node:crypto';
import { runZenosPipeline, RuntimeRunRequestSchema } from '@/app/lib/zenos-runtime-executor';
import { HttpError, parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = 'runtime.run';

function requestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKey(req: Request): string {
  const value = req.headers.get('idempotency-key')?.trim() || '';
  if (!value) return '';
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new HttpError(400, 'Invalid Idempotency-Key header');
  return value;
}

export async function POST(req: Request) {
  const secured = await secureRequest(req, { scope: 'runtime:run', rateLimit: RATE_LIMITS.model, maxBodyBytes: 1_500_000, routeName: ROUTE });
  if (!secured.ok) return secured.response;
  let claimedKey = '';
  try {
    const parsed = await parseJsonBody(req, RuntimeRunRequestSchema, 1_500_000);
    const key = idempotencyKey(req);
    const hash = requestHash(parsed);
    if (key) {
      const claim = getRuntimeStore().claimIdempotency(key, ROUTE, hash);
      if (claim.state === 'conflict') throw new HttpError(409, 'Idempotency key was already used with a different request');
      if (claim.state === 'running') throw new HttpError(409, 'A request with this idempotency key is still running');
      if (claim.state === 'replay') {
        return routeSuccessResponse(claim.record?.response || { ok: false, error: 'Stored idempotent response is unavailable' }, secured.context, ROUTE, claim.record?.status === 'failed' ? 502 : 200, { 'Idempotency-Replayed': 'true' });
      }
      claimedKey = key;
    }

    const result = await runZenosPipeline(parsed);
    const payload = { ok: result.ok, result, requestId: secured.context.requestId };
    if (claimedKey) getRuntimeStore().completeIdempotency(claimedKey, ROUTE, payload, !result.ok);
    const status = result.status === 'blocked' ? 422 : result.status === 'failed' ? 502 : 200;
    return routeSuccessResponse(payload, secured.context, ROUTE, status, claimedKey ? { 'Idempotency-Key': claimedKey } : {});
  } catch (error) {
    const response = routeErrorResponse(error, secured.context, ROUTE);
    if (claimedKey) {
      getRuntimeStore().completeIdempotency(claimedKey, ROUTE, { ok: false, error: error instanceof Error ? error.message : 'Runtime run failed' }, true);
    }
    return response;
  }
}

export async function GET() {
  return Response.json({
    endpoint: '/api/runtime/run',
    method: 'POST',
    description: 'Run the complete Host/Worker/Verifier/Boss pipeline with persistence, retries, revisions, and optional memory recall.',
    idempotency: 'Send Idempotency-Key for safe retries.',
    auth: 'runtime:run',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
