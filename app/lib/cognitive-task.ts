import * as crypto from 'node:crypto';
import { z } from 'zod';
import { CognitivePacket, CognitivePacketSchema, CognitivePhaseSchema } from './cognitive-kernel';
import { CognitiveTaskRecord, ContinuationQueueRecord, RuntimeStore, getRuntimeStore } from './zenos-runtime-store';

const BoundedString = z.string().trim().min(1).max(8_000);

export const TaskNodeSchema = z.object({
  id: z.string().trim().min(1).max(220),
  goal: z.string().trim().min(1).max(4_000),
  owner: z.enum(['host', 'worker']),
  profile: z.enum([
    'browser-research',
    'repo-inspector',
    'coding-worker',
    'validation-worker',
    'ops-observer',
    'data-extractor',
  ]).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']),
  dependencies: z.array(z.string().trim().min(1).max(220)).max(20).default([]),
  parallelSafe: z.boolean(),
  mutating: z.boolean(),
  evidenceRequired: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  evidenceIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  attempts: z.number().int().min(0).max(20).default(0),
});

export const EvidenceReferenceSchema = z.object({
  id: z.string().trim().min(1).max(500),
  kind: z.enum(['tool', 'file', 'log', 'url', 'test', 'memory', 'worker', 'workspace']),
  claim: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1).default(0.8),
});

export const AcceptanceCheckSchema = z.object({
  id: z.string().trim().min(1).max(220),
  criterion: BoundedString,
  kind: z.enum(['implementation', 'validation', 'artifact', 'response', 'general']),
  status: z.enum(['pending', 'passed', 'failed', 'blocked']),
  required: z.boolean().default(true),
  evidenceIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  detail: z.string().trim().max(4_000).optional(),
  updatedAt: z.string().datetime(),
});

export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const ContinuationCapsuleSchema = z.object({
  version: z.literal('zenos-continuation-capsule-v1'),
  taskId: z.string().trim().min(1).max(220),
  sessionId: z.string().trim().min(1).max(220),
  rootRunId: z.string().trim().min(1).max(220),
  activeRunId: z.string().trim().min(1).max(220),
  rootObjective: z.string().trim().min(1).max(12_000),
  phase: CognitivePhaseSchema,
  status: z.enum(['active', 'waiting_for_user', 'completed', 'failed', 'cancelled']),
  acceptanceCriteria: z.array(BoundedString).max(20),
  acceptanceChecks: z.array(AcceptanceCheckSchema).max(20).default([]),
  constraints: z.array(BoundedString).max(20),
  completed: z.array(BoundedString).max(80),
  pending: z.array(BoundedString).max(80),
  decisions: z.array(BoundedString).max(80),
  failures: z.array(BoundedString).max(80),
  taskGraph: z.array(TaskNodeSchema).max(40),
  evidence: z.array(EvidenceReferenceSchema).max(200),
  artifacts: z.array(z.object({
    id: z.string().trim().min(1).max(500),
    path: z.string().trim().min(1).max(4_096).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    description: z.string().trim().min(1).max(2_000),
  })).max(200),
  fields: CognitivePacketSchema.shape.fields,
  nextAction: CognitivePacketSchema.shape.nextAction,
  cycle: z.number().int().min(0).max(100),
  maxCycles: z.number().int().min(1).max(100),
  workspaceRevision: z.string().max(500).optional(),
  contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ContinuationCapsule = z.infer<typeof ContinuationCapsuleSchema>;

function now(): string {
  return new Date().toISOString();
}

function uniqueBounded(values: string[], limit = 80): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 8_000);
    if (!value) continue;
    const key = value.toLowerCase().slice(0, 500);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function acceptanceKind(criterion: string): AcceptanceCheck['kind'] {
  if (/\b(?:test|tests|lint|typecheck|build|compile|validation|validate|syntax|smoke)\b/i.test(criterion)) return 'validation';
  if (/\b(?:artifact|file|document|report|output|deliverable|exists|created)\b/i.test(criterion)) return 'artifact';
  if (/\b(?:implement|behavior|change|fix|repair|modify|mutation|requested)\b/i.test(criterion)) return 'implementation';
  if (/\b(?:answer|response|explain|summary|recommendation)\b/i.test(criterion)) return 'response';
  return 'general';
}

function mergeAcceptanceChecks(
  criteria: string[],
  existing: AcceptanceCheck[],
  timestamp: string,
): AcceptanceCheck[] {
  const byCriterion = new Map(
    existing.map(check => [check.criterion.toLowerCase().replace(/\s+/g, ' ').trim(), check]),
  );
  return uniqueBounded(criteria, 20).map((criterion) => {
    const key = criterion.toLowerCase().replace(/\s+/g, ' ').trim();
    const current = byCriterion.get(key);
    if (current) return AcceptanceCheckSchema.parse(current);
    return AcceptanceCheckSchema.parse({
      id: `acceptance_${fingerprint(criterion).slice(0, 24)}`,
      criterion,
      kind: acceptanceKind(criterion),
      status: 'pending',
      required: true,
      evidenceIds: [],
      updatedAt: timestamp,
    });
  });
}

function recordFromCapsule(capsule: ContinuationCapsule): CognitiveTaskRecord {
  return {
    taskId: capsule.taskId,
    rootRunId: capsule.rootRunId,
    activeRunId: capsule.activeRunId,
    sessionId: capsule.sessionId,
    status: capsule.status,
    phase: capsule.phase,
    capsule,
    createdAt: capsule.createdAt,
    updatedAt: capsule.updatedAt,
  };
}

export function prepareCognitiveTask(input: {
  sessionId: string;
  runId: string;
  packet: CognitivePacket;
  workspaceRevision?: string;
  reuseActive?: boolean;
  store?: RuntimeStore;
}): ContinuationCapsule {
  const store = input.store || getRuntimeStore();
  const existingRecord = store.findActiveCognitiveTaskBySession(input.sessionId);
  const existing = existingRecord
    ? ContinuationCapsuleSchema.safeParse(existingRecord.capsule)
    : undefined;
  const timestamp = now();
  if (existing?.success && (input.reuseActive || existing.data.status === 'waiting_for_user')) {
    const previous = existing.data;
    const acceptanceCriteria = uniqueBounded([...previous.acceptanceCriteria, ...input.packet.acceptanceCriteria], 20);
    const capsule = ContinuationCapsuleSchema.parse({
      ...previous,
      activeRunId: input.runId,
      phase: previous.status === 'waiting_for_user' && !input.packet.fields.some((field) => field.status === 'blocking')
        ? input.packet.phase
        : previous.phase,
      status: previous.status === 'waiting_for_user' && !input.packet.fields.some((field) => field.status === 'blocking')
        ? 'active'
        : previous.status,
      acceptanceCriteria,
      acceptanceChecks: mergeAcceptanceChecks(acceptanceCriteria, previous.acceptanceChecks, timestamp),
      constraints: uniqueBounded([...previous.constraints, ...input.packet.constraints], 20),
      fields: input.packet.fields,
      nextAction: input.packet.nextAction,
      maxCycles: Math.max(previous.maxCycles, input.packet.continuation.maxCycles),
      workspaceRevision: input.workspaceRevision || previous.workspaceRevision,
      contextFingerprint: fingerprint({
        objective: previous.rootObjective,
        phase: previous.phase,
        pending: previous.pending,
        decisions: previous.decisions,
        evidence: previous.evidence.map((item) => item.id),
        workspaceRevision: input.workspaceRevision || previous.workspaceRevision,
      }),
      updatedAt: timestamp,
    });
    store.saveCognitiveTask(recordFromCapsule(capsule));
    return capsule;
  }

  if (existing?.success) {
    const previous = existing.data;
    store.saveCognitiveTask(recordFromCapsule(ContinuationCapsuleSchema.parse({
      ...previous,
      status: 'cancelled',
      updatedAt: timestamp,
    })));
  }

  const taskId = `cognitive_${crypto.randomUUID()}`;
  const pending = uniqueBounded(input.packet.acceptanceCriteria.map((criterion) => `Satisfy: ${criterion}`), 80);
  const capsule = ContinuationCapsuleSchema.parse({
    version: 'zenos-continuation-capsule-v1',
    taskId,
    sessionId: input.sessionId,
    rootRunId: input.runId,
    activeRunId: input.runId,
    rootObjective: input.packet.rootObjective,
    phase: input.packet.phase,
    status: input.packet.phase === 'waiting_for_user' ? 'waiting_for_user' : 'active',
    acceptanceCriteria: input.packet.acceptanceCriteria,
    acceptanceChecks: mergeAcceptanceChecks(input.packet.acceptanceCriteria, [], timestamp),
    constraints: input.packet.constraints,
    completed: [],
    pending,
    decisions: [],
    failures: [],
    taskGraph: [
      {
        id: 'host-synthesis',
        goal: input.packet.rootObjective,
        owner: 'host',
        status: 'running',
        dependencies: input.packet.capabilities.map((_, index) => `worker-${index + 1}`),
        parallelSafe: false,
        mutating: false,
        evidenceRequired: input.packet.acceptanceCriteria,
        evidenceIds: [],
        attempts: 0,
      },
      ...input.packet.capabilities.map((capability, index) => ({
        id: `worker-${index + 1}`,
        goal: capability.goal,
        owner: 'worker' as const,
        profile: capability.profile,
        status: 'queued' as const,
        dependencies: [],
        parallelSafe: capability.parallelSafe,
        mutating: capability.mutating,
        evidenceRequired: capability.evidenceRequired,
        evidenceIds: [],
        attempts: 0,
      })),
    ],
    evidence: [],
    artifacts: [],
    fields: input.packet.fields,
    nextAction: input.packet.nextAction,
    cycle: 0,
    maxCycles: input.packet.continuation.maxCycles,
    workspaceRevision: input.workspaceRevision,
    contextFingerprint: fingerprint({ objective: input.packet.rootObjective, pending, workspaceRevision: input.workspaceRevision }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.saveCognitiveTask(recordFromCapsule(capsule));
  return capsule;
}

export function updateCognitiveTask(input: {
  taskId: string;
  runId: string;
  phase?: ContinuationCapsule['phase'];
  status?: ContinuationCapsule['status'];
  completed?: string[];
  pending?: string[];
  acceptanceChecks?: Array<z.input<typeof AcceptanceCheckSchema>>;
  decisions?: string[];
  failures?: string[];
  evidence?: Array<z.input<typeof EvidenceReferenceSchema>>;
  workspaceRevision?: string;
  nextAction?: ContinuationCapsule['nextAction'];
  incrementCycle?: boolean;
  store?: RuntimeStore;
}): ContinuationCapsule {
  const store = input.store || getRuntimeStore();
  const record = store.getCognitiveTask(input.taskId);
  if (!record) throw new Error(`Cognitive task not found: ${input.taskId}`);
  const current = ContinuationCapsuleSchema.parse(record.capsule);
  const timestamp = now();
  const evidence = [
    ...current.evidence,
    ...(input.evidence || []).map((item) => EvidenceReferenceSchema.parse(item)),
  ];
  const dedupedEvidence = [...new Map(evidence.map((item) => [item.id, item])).values()].slice(-200);
  const acceptanceChecks = input.acceptanceChecks
    ? input.acceptanceChecks.map(check => AcceptanceCheckSchema.parse(check))
    : current.acceptanceChecks;
  const capsule = ContinuationCapsuleSchema.parse({
    ...current,
    activeRunId: input.runId,
    phase: input.phase || current.phase,
    status: input.status || current.status,
    completed: uniqueBounded([...current.completed, ...(input.completed || [])], 80),
    pending: input.pending ? uniqueBounded(input.pending, 80) : current.pending,
    acceptanceChecks,
    decisions: uniqueBounded([...current.decisions, ...(input.decisions || [])], 80),
    failures: uniqueBounded([...current.failures, ...(input.failures || [])], 80),
    evidence: dedupedEvidence,
    workspaceRevision: input.workspaceRevision || current.workspaceRevision,
    nextAction: input.nextAction || current.nextAction,
    cycle: current.cycle + (input.incrementCycle ? 1 : 0),
    contextFingerprint: fingerprint({
      objective: current.rootObjective,
      phase: input.phase || current.phase,
      completed: uniqueBounded([...current.completed, ...(input.completed || [])], 80),
      pending: input.pending ? uniqueBounded(input.pending, 80) : current.pending,
      acceptanceChecks: acceptanceChecks.map(check => ({ id: check.id, status: check.status, evidenceIds: check.evidenceIds })),
      decisions: uniqueBounded([...current.decisions, ...(input.decisions || [])], 80),
      evidence: dedupedEvidence.map((item) => item.id),
      workspaceRevision: input.workspaceRevision || current.workspaceRevision,
    }),
    updatedAt: timestamp,
  });
  store.saveCognitiveTask(recordFromCapsule(capsule));
  return capsule;
}

export function renderContinuationCapsule(capsule: ContinuationCapsule, maxChars = 18_000): string {
  const sections = [
    '# ZENOS ACTIVE TASK CAPSULE',
    `Task ID: ${capsule.taskId}`,
    `Objective: ${capsule.rootObjective}`,
    `Phase: ${capsule.phase}`,
    `Cycle: ${capsule.cycle}/${capsule.maxCycles}`,
    capsule.workspaceRevision ? `Workspace revision: ${capsule.workspaceRevision}` : '',
    '',
    '## Acceptance criteria',
    ...capsule.acceptanceChecks.map((check) => (
      `- [${check.status}] ${check.criterion}`
      + `${check.evidenceIds.length ? ` evidence=${check.evidenceIds.join(',')}` : ''}`
      + `${check.detail ? ` :: ${check.detail}` : ''}`
    )),
    capsule.completed.length ? `\n## Completed\n${capsule.completed.map((item) => `- ${item}`).join('\n')}` : '',
    capsule.pending.length ? `\n## Pending\n${capsule.pending.map((item) => `- ${item}`).join('\n')}` : '',
    capsule.decisions.length ? `\n## Decisions\n${capsule.decisions.map((item) => `- ${item}`).join('\n')}` : '',
    capsule.failures.length ? `\n## Failed attempts — do not repeat without new evidence\n${capsule.failures.map((item) => `- ${item}`).join('\n')}` : '',
    capsule.taskGraph.length ? `\n## Task graph\n${capsule.taskGraph.map((node) => `- ${node.id} [${node.status}] owner=${node.owner}${node.profile ? ` profile=${node.profile}` : ''} parallel=${node.parallelSafe} mutating=${node.mutating} deps=${node.dependencies.join(',') || 'none'} :: ${node.goal}`).join('\n')}` : '',
    capsule.evidence.length ? `\n## Evidence references\n${capsule.evidence.slice(-40).map((item) => `- [${item.kind}] ${item.id}: ${item.claim} (${item.confidence.toFixed(2)})`).join('\n')}` : '',
    '',
    '## Exact next action',
    `${capsule.nextAction.owner}${capsule.nextAction.profile ? `/${capsule.nextAction.profile}` : ''}: ${capsule.nextAction.instruction}`,
    `Stop condition: ${capsule.nextAction.stopCondition}`,
    '',
    'This capsule is authoritative active state. Continue from it; do not reconstruct the task from historical prose summaries.',
  ].filter(Boolean).join('\n');
  return sections.slice(0, maxChars);
}

export function scheduleCognitiveContinuation(input: {
  capsule: ContinuationCapsule;
  runId: string;
  reason: string;
  promptPrefix?: string;
  store?: RuntimeStore;
}): ContinuationQueueRecord {
  const store = input.store || getRuntimeStore();
  const nextAttempt = input.capsule.cycle + 1;
  if (nextAttempt > input.capsule.maxCycles) throw new Error('Cognitive continuation budget exhausted');
  const timestamp = now();
  const continuationId = `continuation_${crypto.randomUUID()}`;
  const prompt = [
    input.promptPrefix || 'Continue the same root task as an internal Zenos Cognitive Runtime cycle. This is not a new user request.',
    `Continuation reason: ${input.reason}`,
    renderContinuationCapsule(input.capsule),
    'Use the smallest sufficient context and tools. Delegate only independent bounded work. Do not produce a user-facing final answer until the acceptance criteria pass or a genuine blocking field requires one concise question.',
  ].join('\n\n').slice(0, 24_000);
  const record: ContinuationQueueRecord = {
    continuationId,
    taskId: input.capsule.taskId,
    runId: input.runId,
    sessionId: input.capsule.sessionId,
    status: 'queued',
    prompt,
    reason: input.reason,
    attempt: nextAttempt,
    maxAttempts: input.capsule.maxCycles,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.enqueueContinuation(record);
  updateCognitiveTask({
    taskId: input.capsule.taskId,
    runId: input.runId,
    incrementCycle: true,
    store,
  });
  return record;
}
