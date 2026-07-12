import { z } from 'zod';
import { appendOutcomeFeedback, buildOutcomeAnalytics, OutcomePassportSchema } from '@/app/lib/outcome-ledger';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';
import { getRuntimeStore } from '@/app/lib/zenos-runtime-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.outcomes';
const FeedbackSchema = z.object({
  runId: z.string().trim().min(1).max(220),
  score: z.number().min(0).max(1).optional(),
  accepted: z.boolean().optional(),
  note: z.string().trim().max(4_000).optional(),
}).refine((value) => value.score !== undefined || value.accepted !== undefined || Boolean(value.note), {
  message: 'At least one feedback field is required',
});

export async function GET(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:read',
    rateLimit: RATE_LIMITS.read,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || '100'), 1), 500);
    const outcomes = getRuntimeStore().listOutcomes(limit, {
      runId: url.searchParams.get('runId') || undefined,
      sessionId: url.searchParams.get('sessionId') || undefined,
      taskType: url.searchParams.get('taskType') || undefined,
      verdict: url.searchParams.get('verdict') || undefined,
    }).map((item) => ({ ...item, record: OutcomePassportSchema.parse(item.record) }));
    return routeSuccessResponse({
      ok: true,
      ledgerVersion: 'etla-outcome-passport-v1',
      analytics: buildOutcomeAnalytics(),
      outcomes,
    }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:admin',
    rateLimit: RATE_LIMITS.write,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const feedback = FeedbackSchema.parse(await req.json());
    const outcome = appendOutcomeFeedback(feedback);
    return routeSuccessResponse({ ok: true, outcome }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
