import { pauseCommandJob } from './command-job';
import {
  ContinuityPacketV2,
  continuityPacketToCompactMessages,
  parseContinuityPacketV2,
} from './continuity-packet';
import {
  ContinuityCheckpointDecision,
  ContinuityPressure,
  decideContinuityCheckpoint,
  evaluateContinuityPressure,
  recordContinuityCheckpoint,
} from './continuity-coordinator';
import { RuntimeFeatureFlags } from './feature-flags';
import { getRuntimeStore } from './zenos-runtime-store';
import { compactMemoryHandoff } from './zenos-memory-client';

export type CoordinatedContinuityCheckpoint = {
  action: 'skip' | 'reuse' | 'checkpoint' | 'fallback';
  reason: string;
  pressure: ContinuityPressure;
  context: string;
  checkpointId?: string;
  sourceCursor?: string;
  previousCheckpointId?: string;
  strategy?: string;
  coverage?: unknown;
  checkpointValidated?: boolean;
  faithfulness?: Record<string, unknown>;
  degraded: boolean;
  cacheHit?: boolean;
  latencyMs?: number;
};

function forcedCompressionPressure(estimatedTokens: number, softLimit: number): ContinuityPressure {
  const capacity = Math.max(softLimit + 1, Math.round(softLimit / 0.75));
  const forcedTokens = Math.max(estimatedTokens, Math.ceil(capacity * 0.82));
  return {
    level: 'compression',
    estimatedTokens: forcedTokens,
    contextCapacityTokens: capacity,
    ratio: Number((forcedTokens / capacity).toFixed(4)),
    shouldPrepare: true,
    shouldCheckpoint: true,
    shouldCompress: true,
  };
}

function deterministicPacketBrief(packet: ContinuityPacketV2, maxChars: number): string {
  const messages = continuityPacketToCompactMessages(packet, Math.max(20_000, Math.min(maxChars * 10, 120_000)));
  const rendered = messages.map((message) => {
    const label = message.role === 'tool' && message.name ? `${message.role}:${message.name}` : message.role;
    return `[${label}] ${message.content}`;
  }).join('\n\n');
  return [
    'Zenos Runtime deterministic emergency continuity brief:',
    rendered,
    'Recovery rule: continue the same root task from the first uncommitted step. Reconcile workspace hashes before mutation and never ask the user to repeat the original command.',
  ].join('\n\n').slice(0, maxChars);
}

export async function coordinateContinuityCheckpoint(input: {
  sessionId: string;
  turnId?: string;
  namespace: string;
  estimatedTokens: number;
  checkpointSoftLimitTokens: number;
  packet?: ContinuityPacketV2;
  messages?: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>;
  maxChars?: number;
  inputMaxChars?: number;
  reason: string;
  forceCheckpoint?: boolean;
}): Promise<CoordinatedContinuityCheckpoint> {
  const packet = input.packet ? parseContinuityPacketV2(input.packet) : undefined;
  const coordinatorEnabled = RuntimeFeatureFlags.continuityCoordinator();
  const baseDecision: ContinuityCheckpointDecision = coordinatorEnabled
    ? decideContinuityCheckpoint({
        sessionId: input.sessionId,
        packet,
        estimatedTokens: input.estimatedTokens,
        checkpointSoftLimitTokens: input.checkpointSoftLimitTokens,
      })
    : {
        action: 'checkpoint',
        reason: 'ContinuityCoordinator disabled by rollback flag; using legacy compact behavior',
        pressure: evaluateContinuityPressure(input.estimatedTokens, input.checkpointSoftLimitTokens),
      };
  const decision = input.forceCheckpoint && baseDecision.action === 'skip'
    ? {
        ...baseDecision,
        action: 'checkpoint' as const,
        reason: 'Hermes compression boundary forced a Runtime-owned checkpoint',
        pressure: forcedCompressionPressure(input.estimatedTokens, input.checkpointSoftLimitTokens),
      }
    : baseDecision;
  const maxChars = Math.max(1_000, Math.min(input.maxChars || 8_000, 24_000));
  const pauseForCompression = (checkpointId?: string) => {
    if (!input.forceCheckpoint || !RuntimeFeatureFlags.commandJobs()) return;
    const store = getRuntimeStore();
    const active = store.findActiveCommandJobBySession(input.sessionId);
    if (!active || active.status === 'waiting_for_approval') return;
    pauseCommandJob({
      jobId: active.jobId,
      reason: 'Hermes entered a verified context compression boundary',
      checkpointId,
      retryPending: false,
      store,
    });
  };

  if (decision.action === 'skip') {
    return {
      action: 'skip',
      reason: decision.reason,
      pressure: decision.pressure,
      context: '',
      degraded: false,
    };
  }
  if (decision.action === 'reuse' && decision.latest?.context) {
    return {
      action: 'reuse',
      reason: decision.reason,
      pressure: decision.pressure,
      context: decision.latest.context.slice(0, maxChars),
      checkpointId: decision.latest.checkpointId,
      sourceCursor: decision.latest.sourceCursor,
      previousCheckpointId: decision.latest.previousCheckpointId,
      strategy: decision.latest.strategy,
      coverage: decision.latest.coverage,
      checkpointValidated: true,
      degraded: false,
      cacheHit: true,
      latencyMs: 0,
    };
  }

  const compact = await compactMemoryHandoff({
    messages: input.messages,
    packet,
    namespace: input.namespace,
    sessionId: input.sessionId,
    conversationId: input.turnId,
    approxTokens: input.estimatedTokens,
    maxChars,
    inputMaxChars: input.inputMaxChars || 120_000,
    reason: input.reason,
  });
  if (compact.ok && compact.value?.context) {
    const evidenceReceiptAccepted = RuntimeFeatureFlags.evidenceFaithfulness()
      ? compact.value.checkpointValidated === true
      : compact.value.checkpointValidated !== false;
    if (
      coordinatorEnabled
      && packet
      && compact.value.memoryId
      && evidenceReceiptAccepted
    ) {
      recordContinuityCheckpoint({
        sessionId: input.sessionId,
        packet,
        checkpointId: compact.value.memoryId,
        previousCheckpointId: compact.value.previousCheckpointId,
        pressure: decision.pressure.shouldCheckpoint
          ? decision.pressure
          : forcedCompressionPressure(input.estimatedTokens, input.checkpointSoftLimitTokens),
        strategy: compact.value.strategy,
        coverage: compact.value.coverage,
        context: compact.value.context,
        signalHash: decision.signalHash,
      });
    }
    pauseForCompression(compact.value.memoryId);
    return {
      action: 'checkpoint',
      reason: decision.reason,
      pressure: decision.pressure,
      context: compact.value.context.slice(0, maxChars),
      checkpointId: compact.value.memoryId,
      sourceCursor: compact.value.sourceCursor,
      previousCheckpointId: compact.value.previousCheckpointId,
      strategy: compact.value.strategy,
      coverage: compact.value.coverage,
      checkpointValidated: compact.value.checkpointValidated,
      faithfulness: compact.value.faithfulness,
      degraded: Boolean(compact.degraded),
      cacheHit: compact.cacheHit,
      latencyMs: compact.latencyMs,
    };
  }

  if (decision.latest?.context) {
    pauseForCompression(decision.latest.checkpointId);
    return {
      action: 'reuse',
      reason: `Memory checkpoint failed; reused last verified Runtime checkpoint: ${compact.error || 'unknown Memory error'}`,
      pressure: decision.pressure,
      context: decision.latest.context.slice(0, maxChars),
      checkpointId: decision.latest.checkpointId,
      sourceCursor: decision.latest.sourceCursor,
      previousCheckpointId: decision.latest.previousCheckpointId,
      strategy: decision.latest.strategy,
      coverage: decision.latest.coverage,
      checkpointValidated: true,
      degraded: true,
      cacheHit: true,
      latencyMs: compact.latencyMs,
    };
  }
  if (packet) {
    pauseForCompression(packet.previousCheckpointId);
    return {
      action: 'fallback',
      reason: `Memory checkpoint failed; emitted deterministic Runtime recovery packet: ${compact.error || 'unknown Memory error'}`,
      pressure: decision.pressure,
      context: deterministicPacketBrief(packet, maxChars),
      sourceCursor: packet.sourceCursor,
      previousCheckpointId: packet.previousCheckpointId,
      strategy: 'runtime-deterministic-emergency-v1',
      checkpointValidated: false,
      degraded: true,
      latencyMs: compact.latencyMs,
    };
  }
  return {
    action: 'fallback',
    reason: `Memory checkpoint failed and no structured packet was available: ${compact.error || 'unknown Memory error'}`,
    pressure: decision.pressure,
    context: '',
    degraded: true,
    latencyMs: compact.latencyMs,
  };
}
