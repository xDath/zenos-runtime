import { getRuntimeModelConfigSummary } from '@/app/lib/zenos-runtime-executor';
import { listRuntimeSessions } from '@/app/lib/zenos-runtime-three-agent';
import { routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.overview';
const ACTIVE_STATUSES = new Set(['routing', 'working', 'paused', 'boss_review', 'revising', 'finalizing']);
const ROLE_NAMES = ['host', 'worker', 'boss', 'verifier'] as const;
type RuntimeRole = typeof ROLE_NAMES[number];

type RoleActivity = {
  model?: string;
  provider?: string;
  summary?: string;
  outcome?: string;
  timestamp?: string;
};

function latestRoleActivity(events: ReturnType<typeof listRuntimeSessions>[number]['events']): Partial<Record<RuntimeRole, RoleActivity>> {
  const activities: Partial<Record<RuntimeRole, RoleActivity>> = {};
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const role = typeof event.metadata.role === 'string' ? event.metadata.role : '';
    if (!ROLE_NAMES.includes(role as RuntimeRole) || activities[role as RuntimeRole]) continue;
    activities[role as RuntimeRole] = {
      model: typeof event.metadata.model === 'string' ? event.metadata.model : undefined,
      provider: typeof event.metadata.provider === 'string' ? event.metadata.provider : undefined,
      summary: event.summary,
      outcome: typeof event.metadata.outcome === 'string' ? event.metadata.outcome : event.type,
      timestamp: event.createdAt,
    };
  }
  return activities;
}

export async function GET(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:read',
    rateLimit: RATE_LIMITS.read,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;

  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || '30'), 1), 100);
    const sessions = listRuntimeSessions(limit).map((session) => {
      const configured = getRuntimeModelConfigSummary(session.sessionId);
      const activity = latestRoleActivity(session.events);
      const roles = Object.fromEntries(ROLE_NAMES.map((role) => {
        const fallback = configured.roles[role];
        const observed = activity[role];
        return [role, {
          model: observed?.model || fallback.model,
          provider: observed?.provider || fallback.provider,
          configuredModel: fallback.model,
          configuredProvider: fallback.provider,
          invoked: Boolean(observed),
          summary: observed?.summary || null,
          outcome: observed?.outcome || null,
          timestamp: observed?.timestamp || null,
        }];
      }));
      return {
        sessionId: session.sessionId,
        status: session.status,
        active: ACTIVE_STATUSES.has(session.status),
        userGoal: session.userGoal,
        activeRunId: session.activeRunId || null,
        roles,
        budget: session.budget,
        recentEvents: session.events.slice(-30),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    });

    return routeSuccessResponse({
      ok: true,
      defaults: getRuntimeModelConfigSummary(),
      activeSessions: sessions.filter((session) => session.active),
      sessions,
    }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
