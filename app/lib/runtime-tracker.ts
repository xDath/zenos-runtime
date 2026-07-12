import * as crypto from 'node:crypto';
import { getRuntimeModelConfigSummary } from './zenos-runtime-executor';
import { getRuntimeStore } from './zenos-runtime-store';
import { RuntimeModelRole } from './zenos-runtime-executor';
import { RuntimeSessionState, WorkerEvent } from './zenos-runtime-state';

const ACTIVE_STATUSES = new Set(['routing', 'working', 'paused', 'boss_review', 'revising', 'finalizing']);
const TRACKED_ROLES: RuntimeModelRole[] = ['host', 'worker', 'verifier', 'boss'];

export type TrackerRange = 'today' | '24h' | '7d' | '30d' | '60d';

export type RuntimeCallRecord = {
  callId: string;
  runId?: string;
  turnId?: string;
  sessionId: string;
  role: RuntimeModelRole;
  model: string;
  provider: string;
  transport?: string;
  status: 'calling' | 'completed' | 'failed';
  trigger?: string;
  startedAt: string;
  completedAt?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedTokens: boolean;
  latencyMs?: number;
  attempts?: number;
  error?: string;
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function trackerRangeStart(range: TrackerRange, now = new Date()): string {
  const start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else if (range === '24h') start.setTime(now.getTime() - 24 * 60 * 60 * 1000);
  else if (range === '7d') start.setTime(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  else if (range === '30d') start.setTime(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  else start.setTime(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

function shortSessionId(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 6).toUpperCase();
}

function sessionLabel(session: RuntimeSessionState): string {
  const goal = session.userGoal.replace(/\s+/g, ' ').trim();
  return `#${shortSessionId(session.sessionId)} · ${goal.slice(0, 76) || 'Untitled Runtime session'}`;
}

function lifecycleCallRecords(events: WorkerEvent[]): RuntimeCallRecord[] {
  const calls = new Map<string, RuntimeCallRecord>();
  const ordered = [...events].sort((left, right) => (left.eventId || 0) - (right.eventId || 0));
  for (const event of ordered) {
    const metadata = event.metadata || {};
    if (metadata.lifecycle !== 'model_call') continue;
    const role = asString(metadata.role) as RuntimeModelRole;
    if (!TRACKED_ROLES.includes(role)) continue;
    const callId = asString(metadata.callId, `${event.sessionId}:${event.eventId || event.createdAt}`);
    const usage = asObject(metadata.modelUsage);
    const status = asString(metadata.status);
    const existing = calls.get(callId);
    const base: RuntimeCallRecord = existing || {
      callId,
      runId: asString(metadata.runId) || undefined,
      turnId: asString(metadata.turnId) || undefined,
      sessionId: event.sessionId,
      role,
      model: asString(metadata.model, 'unknown'),
      provider: asString(metadata.provider, 'unknown'),
      transport: asString(metadata.transport) || undefined,
      status: 'calling',
      trigger: asString(metadata.trigger) || undefined,
      startedAt: event.createdAt || new Date(0).toISOString(),
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedTokens: false,
    };
    base.runId = asString(metadata.runId, base.runId || '') || undefined;
    base.turnId = asString(metadata.turnId, base.turnId || '') || undefined;
    base.model = asString(metadata.model, base.model);
    base.provider = asString(metadata.provider, base.provider);
    base.transport = asString(metadata.transport, base.transport || '') || undefined;
    base.trigger = asString(metadata.trigger, base.trigger || '') || undefined;
    if (status === 'calling' || metadata.outcome === 'started') {
      base.status = 'calling';
      base.startedAt = event.createdAt || base.startedAt;
      base.inputTokens = asNumber(metadata.inputTokensEstimate, base.inputTokens);
    } else {
      base.status = status === 'failed' || metadata.outcome === 'failed' ? 'failed' : 'completed';
      base.completedAt = event.createdAt || base.completedAt;
      base.inputTokens = asNumber(usage.inputTokens, base.inputTokens);
      base.cacheReadTokens = asNumber(usage.cacheReadTokens, base.cacheReadTokens);
      base.cacheWriteTokens = asNumber(usage.cacheWriteTokens, base.cacheWriteTokens);
      base.outputTokens = asNumber(usage.outputTokens, base.outputTokens);
      base.reasoningTokens = asNumber(usage.reasoningTokens, base.reasoningTokens);
      base.totalTokens = asNumber(
        usage.totalTokens,
        base.inputTokens + base.cacheReadTokens + base.cacheWriteTokens + base.outputTokens,
      );
      base.estimatedTokens = Boolean(usage.estimated);
      base.latencyMs = asNumber(metadata.latencyMs, base.latencyMs || 0) || undefined;
      base.attempts = asNumber(metadata.attempts, base.attempts || 0) || undefined;
      base.error = asString(metadata.error) || undefined;
    }
    calls.set(callId, base);
  }
  return [...calls.values()].sort((left, right) => {
    const leftTime = new Date(left.completedAt || left.startedAt).getTime();
    const rightTime = new Date(right.completedAt || right.startedAt).getTime();
    return rightTime - leftTime;
  });
}

function roleStateForSession(
  session: RuntimeSessionState,
  calls: RuntimeCallRecord[],
  role: RuntimeModelRole,
) {
  const configured = getRuntimeModelConfigSummary(session.sessionId).roles[role];
  const latest = calls.find((call) => call.sessionId === session.sessionId && call.role === role);
  return {
    role,
    configuredModel: configured.model,
    configuredProvider: configured.provider,
    model: latest?.model || configured.model,
    provider: latest?.provider || configured.provider,
    observed: Boolean(latest),
    status: latest?.status || 'idle',
    callId: latest?.callId || null,
    runId: latest?.runId || null,
    startedAt: latest?.startedAt || null,
    completedAt: latest?.completedAt || null,
    inputTokens: latest?.inputTokens || 0,
    cacheReadTokens: latest?.cacheReadTokens || 0,
    cacheWriteTokens: latest?.cacheWriteTokens || 0,
    outputTokens: latest?.outputTokens || 0,
    reasoningTokens: latest?.reasoningTokens || 0,
    totalTokens: latest?.totalTokens || 0,
    latencyMs: latest?.latencyMs || null,
    trigger: latest?.trigger || null,
    error: latest?.error || null,
  };
}

export function buildRuntimeTracker(options: {
  range?: TrackerRange;
  sessionLimit?: number;
  callLimit?: number;
  sessionId?: string;
} = {}) {
  const range = options.range || 'today';
  const since = trackerRangeStart(range);
  const store = getRuntimeStore();
  const sessions = store.listSessions(options.sessionLimit || 80);
  const events = store.listEvents({
    limit: Math.max(options.callLimit || 1_000, 2_000),
    since,
    sessionId: options.sessionId,
  });
  const calls = lifecycleCallRecords(events)
    .filter((call) => !options.sessionId || call.sessionId === options.sessionId)
    .slice(0, Math.min(Math.max(options.callLimit || 1_000, 1), 5_000));
  const selectedSessions = options.sessionId
    ? sessions.filter((session) => session.sessionId === options.sessionId)
    : sessions;
  const sessionRows = selectedSessions.map((session) => {
    const metadata = session.metadata || {};
    const latestSessionEvent = events.find((event) => event.sessionId === session.sessionId);
    const latestActivityAt = latestSessionEvent?.createdAt || session.updatedAt;
    const activityFresh = Date.now() - new Date(latestActivityAt).getTime() <= 30_000;
    const roleStates = Object.fromEntries(TRACKED_ROLES.map((role) => [
      role,
      roleStateForSession(session, calls, role),
    ]));
    const sessionCalls = calls.filter((call) => call.sessionId === session.sessionId);
    const activeCalls = sessionCalls.filter((call) => call.status === 'calling');
    return {
      sessionId: session.sessionId,
      shortId: `#${shortSessionId(session.sessionId)}`,
      label: sessionLabel(session),
      title: session.userGoal.replace(/\s+/g, ' ').trim().slice(0, 120),
      platform: asString(metadata.platform, 'unknown'),
      status: session.status,
      active: activeCalls.length > 0 || (ACTIVE_STATUSES.has(session.status) && activityFresh),
      activeRunId: session.activeRunId || null,
      pipeline: session.routeDecision?.pipelineMode || null,
      risk: session.routeDecision?.risk || null,
      roles: roleStates,
      callCount: sessionCalls.filter((call) => call.status !== 'calling').length,
      activeCallCount: activeCalls.length,
      totalTokens: sessionCalls.reduce((sum, call) => sum + call.totalTokens, 0),
      createdAt: session.createdAt,
      updatedAt: latestActivityAt,
    };
  });

  const completedCalls = calls.filter((call) => call.status !== 'calling');
  const totalInputTokens = completedCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const totalCacheReadTokens = completedCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0);
  const totalCacheWriteTokens = completedCalls.reduce((sum, call) => sum + call.cacheWriteTokens, 0);
  const totalOutputTokens = completedCalls.reduce((sum, call) => sum + call.outputTokens, 0);
  const totalReasoningTokens = completedCalls.reduce((sum, call) => sum + call.reasoningTokens, 0);
  const bossCalls = completedCalls.filter((call) => call.role === 'boss').length;
  const failedCalls = completedCalls.filter((call) => call.status === 'failed').length;
  const latencyValues = completedCalls.map((call) => call.latencyMs || 0).filter((value) => value > 0);
  const byRole = Object.fromEntries(TRACKED_ROLES.map((role) => {
    const roleCalls = completedCalls.filter((call) => call.role === role);
    return [role, {
      calls: roleCalls.length,
      failures: roleCalls.filter((call) => call.status === 'failed').length,
      inputTokens: roleCalls.reduce((sum, call) => sum + call.inputTokens, 0),
      cacheReadTokens: roleCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0),
      cacheWriteTokens: roleCalls.reduce((sum, call) => sum + call.cacheWriteTokens, 0),
      outputTokens: roleCalls.reduce((sum, call) => sum + call.outputTokens, 0),
      reasoningTokens: roleCalls.reduce((sum, call) => sum + call.reasoningTokens, 0),
      totalTokens: roleCalls.reduce((sum, call) => sum + call.totalTokens, 0),
      averageLatencyMs: roleCalls.length
        ? Math.round(roleCalls.reduce((sum, call) => sum + (call.latencyMs || 0), 0) / roleCalls.length)
        : 0,
    }];
  }));

  return {
    ok: true,
    range,
    since,
    generatedAt: new Date().toISOString(),
    latestEventId: events.reduce((max, event) => Math.max(max, event.eventId || 0), 0),
    defaults: getRuntimeModelConfigSummary(),
    stats: {
      activeSessions: sessionRows.filter((session) => session.active).length,
      totalSessions: sessionRows.length,
      activeCalls: calls.filter((call) => call.status === 'calling').length,
      modelCalls: completedCalls.length,
      failedCalls,
      totalInputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalOutputTokens,
      totalReasoningTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalCacheWriteTokens + totalOutputTokens,
      bossCallRate: completedCalls.length ? bossCalls / completedCalls.length : 0,
      averageLatencyMs: latencyValues.length
        ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
        : 0,
      byRole,
    },
    sessions: sessionRows,
    activeSessions: sessionRows.filter((session) => session.active),
    calls,
    recentEvents: events.slice(0, 250),
  };
}
