import * as crypto from 'node:crypto';
import { ContinuityPacketV2, canonicalContinuityJson } from './continuity-packet';
import { ContinuityCheckpointRecord, RuntimeStore, getRuntimeStore } from './zenos-runtime-store';

export type ContinuityPressureLevel = 'none' | 'observe' | 'checkpoint' | 'compression' | 'emergency';

export type ContinuityPressure = {
  level: ContinuityPressureLevel;
  estimatedTokens: number;
  contextCapacityTokens: number;
  ratio: number;
  shouldPrepare: boolean;
  shouldCheckpoint: boolean;
  shouldCompress: boolean;
};

export type ContinuityCheckpointDecision = {
  action: 'skip' | 'reuse' | 'checkpoint';
  reason: string;
  pressure: ContinuityPressure;
  latest?: ContinuityCheckpointRecord;
  signalHash?: string;
};

const LEVEL_RATIOS = {
  observe: 0.65,
  checkpoint: 0.75,
  compression: 0.82,
  emergency: 0.92,
} as const;

export function evaluateContinuityPressure(
  estimatedTokens: number,
  checkpointSoftLimitTokens: number,
): ContinuityPressure {
  const checkpointLimit = Math.max(24_000, checkpointSoftLimitTokens);
  const capacity = Math.max(checkpointLimit + 1, Math.round(checkpointLimit / LEVEL_RATIOS.checkpoint));
  const tokens = Math.max(0, estimatedTokens);
  const ratio = tokens / capacity;
  const level: ContinuityPressureLevel = ratio >= LEVEL_RATIOS.emergency
    ? 'emergency'
    : ratio >= LEVEL_RATIOS.compression
      ? 'compression'
      : ratio >= LEVEL_RATIOS.checkpoint
        ? 'checkpoint'
        : ratio >= LEVEL_RATIOS.observe
          ? 'observe'
          : 'none';
  return {
    level,
    estimatedTokens: tokens,
    contextCapacityTokens: capacity,
    ratio: Number(ratio.toFixed(4)),
    shouldPrepare: level !== 'none',
    shouldCheckpoint: ['checkpoint', 'compression', 'emergency'].includes(level),
    shouldCompress: ['compression', 'emergency'].includes(level),
  };
}

export function continuitySignalHash(packet: ContinuityPacketV2): string {
  return crypto.createHash('sha256').update(canonicalContinuityJson({
    milestones: packet.milestones.map((item) => ({
      kind: item.kind,
      sourceHash: item.sourceHash,
    })),
    activeToolState: packet.activeToolState.map((item) => ({
      id: item.id,
      status: item.status,
      sourceHash: item.sourceHash,
      changedFiles: item.changedFiles,
      artifactIds: item.artifactIds,
    })),
    openWork: packet.openWork.map((item) => ({
      id: item.id,
      status: item.status,
      sourceHash: item.sourceHash,
      blockers: item.blockers,
      acceptanceCriteria: item.acceptanceCriteria,
    })),
  })).digest('hex');
}

export function decideContinuityCheckpoint(input: {
  sessionId: string;
  packet?: ContinuityPacketV2;
  estimatedTokens: number;
  checkpointSoftLimitTokens: number;
  minMaterialTokenDelta?: number;
  store?: RuntimeStore;
}): ContinuityCheckpointDecision {
  const pressure = evaluateContinuityPressure(input.estimatedTokens, input.checkpointSoftLimitTokens);
  if (!pressure.shouldCheckpoint) {
    return { action: 'skip', reason: `pressure level ${pressure.level} is below checkpoint threshold`, pressure };
  }
  if (!input.packet) {
    return { action: 'checkpoint', reason: 'legacy handoff source has no structured cursor', pressure };
  }
  const store = input.store || getRuntimeStore();
  const latest = store.getLatestContinuityCheckpoint(input.sessionId);
  const signalHash = continuitySignalHash(input.packet);
  if (!latest) {
    return { action: 'checkpoint', reason: 'no prior Runtime checkpoint exists', pressure, signalHash };
  }
  if (latest.sourceCursor === input.packet.sourceCursor) {
    return { action: 'reuse', reason: 'source cursor is unchanged', pressure, latest, signalHash };
  }
  const tokenDelta = Math.abs(input.estimatedTokens - latest.estimatedTokens);
  const minDelta = Math.max(250, input.minMaterialTokenDelta ?? 2_000);
  if (latest.signalHash === signalHash && tokenDelta < minDelta) {
    return {
      action: 'reuse',
      reason: `cursor changed without a material milestone/tool/work delta (${tokenDelta} tokens)`,
      pressure,
      latest,
      signalHash,
    };
  }
  return {
    action: 'checkpoint',
    reason: latest.signalHash !== signalHash
      ? 'material continuity evidence changed'
      : `token delta reached ${tokenDelta}`,
    pressure,
    latest,
    signalHash,
  };
}

export function recordContinuityCheckpoint(input: {
  sessionId: string;
  packet: ContinuityPacketV2;
  checkpointId: string;
  previousCheckpointId?: string;
  pressure: ContinuityPressure;
  strategy?: string;
  coverage?: unknown;
  context: string;
  signalHash?: string;
  store?: RuntimeStore;
}): ContinuityCheckpointRecord {
  if (!input.pressure.shouldCheckpoint || input.pressure.level === 'none') {
    throw new Error('Cannot persist a continuity checkpoint below the checkpoint threshold');
  }
  const timestamp = new Date().toISOString();
  const record: ContinuityCheckpointRecord = {
    sessionId: input.sessionId,
    sourceCursor: input.packet.sourceCursor,
    packetHash: input.packet.contentHash,
    signalHash: input.signalHash || continuitySignalHash(input.packet),
    checkpointId: input.checkpointId,
    previousCheckpointId: input.previousCheckpointId,
    pressureLevel: input.pressure.level,
    estimatedTokens: input.packet.estimatedTokens,
    strategy: input.strategy,
    coverage: input.coverage,
    context: input.context.slice(0, 24_000),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return (input.store || getRuntimeStore()).saveContinuityCheckpoint(record);
}
