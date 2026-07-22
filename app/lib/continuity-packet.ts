import * as crypto from 'node:crypto';
import { z } from 'zod';

export const ContinuityMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().max(32_000),
  name: z.string().trim().max(200).optional(),
  tool_call_id: z.string().trim().max(500).optional(),
  message_id: z.string().trim().max(500).optional(),
});

export const ContextMilestoneSchema = z.object({
  kind: z.enum(['goal', 'decision', 'constraint', 'tool_result', 'patch', 'validation', 'blocker']),
  text: z.string().trim().min(1).max(8_000),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
});

export const ContinuityToolStateSchema = z.object({
  id: z.string().trim().min(1).max(500),
  tool: z.string().trim().min(1).max(200),
  status: z.enum(['queued', 'running', 'passed', 'failed', 'blocked', 'unknown']),
  summary: z.string().trim().max(8_000).default(''),
  changedFiles: z.array(z.string().trim().min(1).max(4_096)).max(200).default([]),
  artifactIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
});

export const ContinuityOpenWorkSchema = z.object({
  id: z.string().trim().min(1).max(500),
  kind: z.enum(['inspect', 'plan', 'patch', 'validate', 'verify', 'deliver', 'approval', 'other']),
  text: z.string().trim().min(1).max(8_000),
  status: z.enum(['queued', 'running', 'blocked', 'retry_pending']).default('queued'),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  blockers: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  sourceMessageIds: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ContinuityPacketV2Schema = z.object({
  version: z.literal('continuity-v2'),
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220),
  sourceCursor: z.string().trim().min(1).max(500),
  estimatedTokens: z.number().int().nonnegative().max(10_000_000),
  head: z.array(ContinuityMessageSchema).max(20).default([]),
  milestones: z.array(ContextMilestoneSchema).max(100).default([]),
  recentTail: z.array(ContinuityMessageSchema).max(160).default([]),
  activeToolState: z.array(ContinuityToolStateSchema).max(80).default([]),
  openWork: z.array(ContinuityOpenWorkSchema).max(80).default([]),
  previousCheckpointId: z.string().trim().min(1).max(500).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ContinuityPacketV2PayloadSchema = ContinuityPacketV2Schema.omit({ contentHash: true });

export type ContinuityMessage = z.infer<typeof ContinuityMessageSchema>;
export type ContextMilestone = z.infer<typeof ContextMilestoneSchema>;
export type ContinuityToolState = z.infer<typeof ContinuityToolStateSchema>;
export type ContinuityOpenWork = z.infer<typeof ContinuityOpenWorkSchema>;
export type ContinuityPacketV2 = z.infer<typeof ContinuityPacketV2Schema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalContinuityJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeContinuityPacketHash(
  packet: Omit<ContinuityPacketV2, 'contentHash'> | ContinuityPacketV2,
): string {
  const rawHashable = Object.fromEntries(
    Object.entries(packet as ContinuityPacketV2).filter(([key]) => key !== 'contentHash'),
  );
  const hashable = ContinuityPacketV2PayloadSchema.parse(rawHashable);
  return crypto.createHash('sha256').update(canonicalContinuityJson(hashable)).digest('hex');
}

export function parseContinuityPacketV2(value: unknown): ContinuityPacketV2 {
  const packet = ContinuityPacketV2Schema.parse(value);
  const expected = computeContinuityPacketHash(packet);
  if (packet.contentHash !== expected) {
    throw new Error('ContinuityPacket v2 contentHash does not match the canonical packet content');
  }
  return packet;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function messageSize(message: ContinuityMessage): number {
  return message.content.length + (message.name?.length || 0) + (message.tool_call_id?.length || 0) + 32;
}

function selectMessages(
  messages: ContinuityMessage[],
  maxChars: number,
  direction: 'head' | 'tail',
): ContinuityMessage[] {
  if (maxChars <= 0 || !messages.length) return [];
  const source = direction === 'head' ? messages : [...messages].reverse();
  const kept: ContinuityMessage[] = [];
  let used = 0;
  for (const message of source) {
    const remaining = maxChars - used;
    if (remaining <= 64) break;
    const bounded = {
      ...message,
      content: clip(message.content, Math.min(24_000, Math.max(64, remaining - 32))),
    };
    const size = messageSize(bounded);
    if (size > remaining && kept.length) continue;
    kept.push(bounded);
    used += Math.min(size, remaining);
  }
  return direction === 'head' ? kept : kept.reverse();
}

function evidenceLabel(ids: string[], hash: string): string {
  const refs = ids.length ? ids.join(',') : 'none';
  return `source_ids=${refs} source_hash=${hash}`;
}

function milestoneMessages(packet: ContinuityPacketV2): ContinuityMessage[] {
  return packet.milestones.map((milestone, index) => ({
    role: 'system' as const,
    message_id: `milestone:${index}:${milestone.sourceHash.slice(0, 16)}`,
    content: clip(
      `[continuity-v2 milestone kind=${milestone.kind} occurred_at=${milestone.occurredAt} ${evidenceLabel(milestone.sourceMessageIds, milestone.sourceHash)}]\n${milestone.text}`,
      24_000,
    ),
  }));
}

function toolStateMessages(packet: ContinuityPacketV2): ContinuityMessage[] {
  return packet.activeToolState.map((tool) => ({
    role: 'tool' as const,
    name: tool.tool,
    message_id: `tool-state:${tool.id}`,
    content: clip([
      `[continuity-v2 tool-state id=${tool.id} status=${tool.status} occurred_at=${tool.occurredAt} ${evidenceLabel(tool.sourceMessageIds, tool.sourceHash)}]`,
      tool.summary,
      tool.changedFiles.length ? `changed_files=${tool.changedFiles.join(',')}` : '',
      tool.artifactIds.length ? `artifact_ids=${tool.artifactIds.join(',')}` : '',
    ].filter(Boolean).join('\n'), 24_000),
  }));
}

function openWorkMessages(packet: ContinuityPacketV2): ContinuityMessage[] {
  return packet.openWork.map((work) => ({
    role: 'system' as const,
    message_id: `open-work:${work.id}`,
    content: clip([
      `[continuity-v2 open-work id=${work.id} kind=${work.kind} status=${work.status} ${evidenceLabel(work.sourceMessageIds, work.sourceHash)}]`,
      work.text,
      work.acceptanceCriteria.length ? `acceptance_criteria=${work.acceptanceCriteria.join(' | ')}` : '',
      work.blockers.length ? `blockers=${work.blockers.join(' | ')}` : '',
    ].filter(Boolean).join('\n'), 24_000),
  }));
}

export function continuityPacketToCompactMessages(
  rawPacket: ContinuityPacketV2,
  inputMaxChars = 120_000,
): ContinuityMessage[] {
  const packet = parseContinuityPacketV2(rawPacket);
  const total = Math.max(20_000, Math.min(inputMaxChars, 500_000));
  const headBudget = Math.floor(total * 0.12);
  const milestoneBudget = Math.floor(total * 0.33);
  const toolBudget = Math.floor(total * 0.20);
  const tailBudget = total - headBudget - milestoneBudget - toolBudget;

  const packetHeader: ContinuityMessage = {
    role: 'system',
    message_id: `continuity:${packet.sourceCursor}`,
    content: [
      '[continuity-v2 packet]',
      `session_id=${packet.sessionId}`,
      `turn_id=${packet.turnId}`,
      `source_cursor=${packet.sourceCursor}`,
      `estimated_tokens=${packet.estimatedTokens}`,
      `previous_checkpoint_id=${packet.previousCheckpointId || ''}`,
      `content_hash=${packet.contentHash}`,
    ].join('\n'),
  };

  const head = selectMessages(packet.head, Math.max(0, headBudget - messageSize(packetHeader)), 'head');
  const milestones = selectMessages(milestoneMessages(packet), milestoneBudget, 'head');
  const toolAndWork = [
    ...toolStateMessages(packet),
    ...openWorkMessages(packet),
  ];
  const boundedToolAndWork = selectMessages(toolAndWork, toolBudget, 'tail');
  const tail = selectMessages(packet.recentTail, tailBudget, 'tail');

  return [packetHeader, ...head, ...milestones, ...boundedToolAndWork, ...tail].slice(0, 400);
}

const GOAL_PATTERN = /\b(?:goal|objective|tujuan|buat|bikin|implement|upgrade|audit|fix|perbaiki|selesaikan|kerjakan|pengen|mau)\b/i;
const DECISION_PATTERN = /\b(?:decision|decided|final|approved|confirmed|keputusan|diputuskan|pilih|pakai|gunakan)\b/i;
const CONSTRAINT_PATTERN = /\b(?:must|must not|do not|never|always|jangan|harus|wajib|tanpa|only|hanya|acceptance criteria)\b/i;
const PATCH_PATTERN = /\b(?:patch|patched|edit|edited|changed|modified|write|replace|mutation|diff|commit)\b/i;
const VALIDATION_PATTERN = /\b(?:test|tested|typecheck|lint|build|compile|validation|validate|verified|passed|failed)\b/i;
const BLOCKER_PATTERN = /\b(?:blocker|blocked|error|failed|failure|timeout|denied|broken|invalid|regression|crash|ngadat|gagal)\b/i;
const PENDING_PATTERN = /\b(?:todo|pending|next|remaining|lanjut|belum|unfinished|retry|approval|required|needs? to)\b/i;
const PATH_PATTERN = /(?:\/srv\/etla\/workspaces\/|\/usr\/local\/lib\/hermes-agent\/|app\/|gateway\/|tests\/|scripts\/)[A-Za-z0-9_./-]+/g;

function rawContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return canonicalContinuityJson(content);
}

function rawOccurredAt(message: Record<string, unknown>): string {
  for (const key of ['occurred_at', 'created_at', 'timestamp', 'time']) {
    const raw = typeof message[key] === 'string' ? String(message[key]) : '';
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

export function compileContinuityPacketFromMessages(input: {
  messages: Array<Record<string, unknown>>;
  sessionId: string;
  turnId: string;
  estimatedTokens: number;
  previousCheckpointId?: string;
}): ContinuityPacketV2 {
  const entries = input.messages.slice(-400).map((message, index) => {
    const roleCandidate = String(message.role || '').trim().toLowerCase();
    const role: ContinuityMessage['role'] = ['user', 'assistant', 'tool', 'system'].includes(roleCandidate)
      ? roleCandidate as ContinuityMessage['role']
      : 'system';
    const content = rawContentText(message.content).trim().slice(0, 32_000);
    const sourceHash = crypto.createHash('sha256').update(`${role}\n${content}`).digest('hex');
    return {
      index,
      role,
      content,
      name: typeof message.name === 'string' ? message.name.slice(0, 200) : undefined,
      toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id.slice(0, 500) : undefined,
      messageId: typeof message.message_id === 'string' || typeof message.id === 'string'
        ? String(message.message_id || message.id).slice(0, 500)
        : `m${index}:${role}:${sourceHash.slice(0, 16)}`,
      sourceHash,
      occurredAt: rawOccurredAt(message),
    };
  }).filter((entry) => entry.content);
  if (!entries.length) throw new Error('Cannot compile a ContinuityPacket from empty messages');

  const headCandidates = entries.slice(0, 40).filter((entry) => (
    ['user', 'system'].includes(entry.role)
    && (GOAL_PATTERN.test(entry.content) || DECISION_PATTERN.test(entry.content) || CONSTRAINT_PATTERN.test(entry.content))
  ));
  const headSource = headCandidates.length ? headCandidates : entries.filter((entry) => ['user', 'system'].includes(entry.role)).slice(0, 8);
  const head = headSource.slice(0, 8).map((entry): ContinuityMessage => ({
    role: entry.role,
    content: entry.content,
    message_id: entry.messageId,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.toolCallId ? { tool_call_id: entry.toolCallId } : {}),
  }));

  const milestones: ContextMilestone[] = [];
  const activeToolState: ContinuityToolState[] = [];
  const openWork: ContinuityOpenWork[] = [];
  for (const entry of entries) {
    const changedFiles = [...new Set(entry.content.match(PATH_PATTERN) || [])].slice(0, 200);
    const meaningfulToolResult = entry.role === 'tool' && (
      BLOCKER_PATTERN.test(entry.content)
      || VALIDATION_PATTERN.test(entry.content)
      || PATCH_PATTERN.test(entry.content)
      || PENDING_PATTERN.test(entry.content)
      || changedFiles.length > 0
      || !/^routine (?:transcript )?message \d+$/i.test(entry.content)
    );
    let kind: ContextMilestone['kind'] | undefined;
    if (BLOCKER_PATTERN.test(entry.content)) kind = 'blocker';
    else if (entry.role === 'user' && GOAL_PATTERN.test(entry.content)) kind = 'goal';
    else if (VALIDATION_PATTERN.test(entry.content)) kind = 'validation';
    else if (PATCH_PATTERN.test(entry.content)) kind = 'patch';
    else if (DECISION_PATTERN.test(entry.content)) kind = 'decision';
    else if (CONSTRAINT_PATTERN.test(entry.content)) kind = 'constraint';
    else if (meaningfulToolResult) kind = 'tool_result';
    if (kind && milestones.length < 100) {
      milestones.push({
        kind,
        text: entry.content.slice(0, 8_000),
        sourceMessageIds: [entry.messageId],
        sourceHash: entry.sourceHash,
        occurredAt: entry.occurredAt,
      });
    }
    if (meaningfulToolResult && activeToolState.length < 80) {
      activeToolState.push({
        id: entry.messageId,
        tool: entry.name || 'tool',
        status: BLOCKER_PATTERN.test(entry.content) ? 'failed' : 'passed',
        summary: entry.content.slice(0, 8_000),
        changedFiles,
        artifactIds: [],
        sourceMessageIds: [entry.messageId],
        sourceHash: entry.sourceHash,
        occurredAt: entry.occurredAt,
      });
    }
    if ((PENDING_PATTERN.test(entry.content) || BLOCKER_PATTERN.test(entry.content)) && openWork.length < 80) {
      openWork.push({
        id: `work:${entry.messageId}`,
        kind: VALIDATION_PATTERN.test(entry.content) ? 'validate' : PATCH_PATTERN.test(entry.content) ? 'patch' : 'other',
        text: entry.content.slice(0, 8_000),
        status: BLOCKER_PATTERN.test(entry.content) ? 'blocked' : /retry/i.test(entry.content) ? 'retry_pending' : 'queued',
        acceptanceCriteria: entry.content.split(/\r?\n/)
          .filter((line) => /acceptance|criteria|must|harus|wajib/i.test(line))
          .map((line) => line.trim().slice(0, 2_000))
          .filter(Boolean)
          .slice(0, 20),
        blockers: BLOCKER_PATTERN.test(entry.content) ? [entry.content.slice(0, 2_000)] : [],
        sourceMessageIds: [entry.messageId],
        sourceHash: entry.sourceHash,
      });
    }
  }
  const recentTail = entries.slice(-160).map((entry): ContinuityMessage => ({
    role: entry.role,
    content: entry.content,
    message_id: entry.messageId,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.toolCallId ? { tool_call_id: entry.toolCallId } : {}),
  }));
  const sourceCursor = `msg:${entries.length}:${entries.at(-1)?.sourceHash.slice(0, 24)}`;
  const payload: Omit<ContinuityPacketV2, 'contentHash'> = {
    version: 'continuity-v2',
    sessionId: input.sessionId,
    turnId: input.turnId,
    sourceCursor,
    estimatedTokens: input.estimatedTokens,
    head,
    milestones,
    recentTail,
    activeToolState,
    openWork,
    previousCheckpointId: input.previousCheckpointId,
  };
  return { ...payload, contentHash: computeContinuityPacketHash(payload) };
}
