import * as crypto from 'node:crypto';
import { z } from 'zod';
import { redactText } from './logger';
import { incrementMetric } from './metrics';
import { RuntimeRole, estimateTokenCount, truncateToTokenBudget } from './token-economy';
import { RiskLevelSchema, RouteDecision, TaskTypeSchema, WorkerResult } from './zenos-runtime';

export const EvidenceItemSchema = z.object({
  id: z.string().min(1).max(160),
  claim: z.string().min(1).max(8_000),
  source: z.string().max(2_000).default('supplied-context'),
  confidence: z.number().min(0).max(1).default(0.75),
  kind: z.enum(['memory', 'tool', 'source', 'session', 'worker', 'validation']).default('source'),
  freshness: z.enum(['current', 'recent', 'unknown', 'stale']).default('unknown'),
});

export const RuntimeWorkPacketSchema = z.object({
  version: z.literal('etla-work-packet-v1'),
  packetId: z.string().min(8),
  goal: z.string().min(1).max(20_000),
  taskFamily: TaskTypeSchema,
  risk: RiskLevelSchema,
  targetRole: z.enum(['worker', 'host', 'verifier', 'boss']),
  constraints: z.array(z.string().max(4_000)).max(24).default([]),
  verifiedFacts: z.array(EvidenceItemSchema).max(48).default([]),
  relevantFiles: z.array(z.string().max(1_000)).max(48).default([]),
  procedures: z.array(z.string().max(4_000)).max(32).default([]),
  previousFailures: z.array(z.string().max(4_000)).max(24).default([]),
  unknowns: z.array(z.string().max(4_000)).max(24).default([]),
  contradictions: z.array(z.string().max(4_000)).max(24).default([]),
  acceptanceCriteria: z.array(z.string().max(4_000)).max(32).default([]),
  forbiddenActions: z.array(z.string().max(4_000)).max(24).default([]),
  evidenceMap: z.array(EvidenceItemSchema).max(64).default([]),
  contextReduction: z.object({
    rawTokens: z.number().int().nonnegative(),
    compiledTokens: z.number().int().nonnegative(),
    reductionRatio: z.number().min(0).max(1),
  }),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type RuntimeWorkPacket = z.infer<typeof RuntimeWorkPacketSchema>;

export type ContextCompilerInput = {
  request: string;
  decision: RouteDecision;
  targetRole: RuntimeRole;
  tokenBudget: number;
  memoryContext?: string;
  sourceContext?: string;
  toolContext?: string;
  sessionContext?: string;
  workerResult?: WorkerResult;
  validationResults?: string[];
  selectedProcedure?: string[];
};

const SECRET_ASSIGNMENT = /\b(password|secret|token|api[_-]?key|private[_-]?key|cookie)\s*[:=]\s*\S+/gi;
const FILE_REFERENCE = /(?:^|\s)((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)/g;
const CONSTRAINT_HINT = /\b(must|must not|should not|do not|don't|jangan|harus|tanpa|only|hanya|keep|preserve|backward.compatible|approval)\b/i;
const FAILURE_HINT = /\b(fail(?:ed|ure)?|error|bug|regression|timeout|invalid|ditolak|gagal|masalah)\b/i;
const UNKNOWN_HINT = /\b(unknown|unclear|unsure|not provided|missing|belum diketahui|tidak jelas|belum ada)\b/i;
const ACCEPTANCE_HINT = /\b(pass|succeed|success|validated|verified|lulus|berhasil|acceptance|criterion|criteria|test)\b/i;
const PROCEDURE_HINT = /\b(step|procedure|workflow|first|then|after|run|inspect|check|verify|langkah|prosedur|cek|uji)\b/i;

function normalizeLine(value: string): string {
  return redactText(value)
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(/^[-*#>\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    const item = normalizeLine(raw);
    const key = item.toLowerCase().slice(0, 500);
    if (!item || item.length < 3 || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

function lines(text = ''): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.length > 2_000 ? line.match(/.{1,1800}(?:\s|$)/g) || [line] : [line])
    .map(normalizeLine)
    .filter(Boolean);
}

function evidenceId(kind: EvidenceItem['kind'], source: string, claim: string): string {
  return `${kind}_${crypto.createHash('sha256').update(`${source}\n${claim}`).digest('hex').slice(0, 16)}`;
}

function evidenceFromText(text: string | undefined, kind: EvidenceItem['kind'], defaultSource: string): EvidenceItem[] {
  if (!text) return [];
  return unique(lines(text), 80).map((claim) => {
    const sourceMatch = claim.match(FILE_REFERENCE)?.[0]?.trim();
    const source = sourceMatch || defaultSource;
    const confidence = kind === 'tool' || kind === 'validation' ? 0.92 : kind === 'memory' ? 0.8 : 0.78;
    return EvidenceItemSchema.parse({
      id: evidenceId(kind, source, claim),
      claim,
      source,
      confidence,
      kind,
      freshness: kind === 'tool' || kind === 'validation' ? 'current' : kind === 'session' ? 'recent' : 'unknown',
    });
  });
}

function scoreEvidence(item: EvidenceItem, requestTokens: Set<string>, targetRole: RuntimeRole): number {
  const tokens = item.claim.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 2);
  const overlap = tokens.filter((token) => requestTokens.has(token)).length / Math.max(1, requestTokens.size);
  const kindBoost: Record<EvidenceItem['kind'], number> = {
    validation: 1,
    tool: 0.95,
    source: 0.78,
    worker: 0.75,
    memory: 0.68,
    session: 0.55,
  };
  const roleBoost = targetRole === 'verifier' && item.kind === 'validation'
    ? 0.18
    : targetRole === 'worker' && (item.kind === 'tool' || item.kind === 'source')
      ? 0.12
      : targetRole === 'boss' && item.confidence >= 0.9
        ? 0.08
        : 0;
  const stalePenalty = item.freshness === 'stale' ? 0.3 : 0;
  return overlap * 0.45 + item.confidence * 0.28 + kindBoost[item.kind] * 0.27 + roleBoost - stalePenalty;
}

function defaultAcceptance(input: ContextCompilerInput): string[] {
  const criteria = ['The result directly satisfies the user request.'];
  if (input.decision.requiresSourceContext) criteria.push('Claims about files, tools, logs, or current state are backed by supplied evidence.');
  if (input.decision.taskType === 'coding_change' || input.decision.taskType === 'debugging') {
    criteria.push('The smallest justified change is used.');
    criteria.push('Relevant deterministic validation passes before success is claimed.');
  }
  if (input.decision.requiresApproval) criteria.push('No production-impacting or irreversible action is executed without explicit approval.');
  return criteria;
}

function defaultForbidden(decision: RouteDecision): string[] {
  const forbidden = [
    'Inventing tool calls, file inspection, tests, or evidence.',
    'Exposing credentials, tokens, cookies, private keys, or unredacted secrets.',
    'Disabling validation or deleting tests to manufacture a pass.',
  ];
  if (decision.requiresApproval) forbidden.push('Executing destructive or production-impacting actions without approval.');
  if (decision.taskType === 'coding_change' || decision.taskType === 'debugging') {
    forbidden.push('Expanding the patch beyond the evidence-backed task scope.');
  }
  return forbidden;
}

function classifyLines(all: EvidenceItem[]) {
  const constraints: string[] = [];
  const procedures: string[] = [];
  const failures: string[] = [];
  const unknowns: string[] = [];
  const acceptance: string[] = [];
  for (const item of all) {
    if (CONSTRAINT_HINT.test(item.claim)) constraints.push(item.claim);
    if (PROCEDURE_HINT.test(item.claim)) procedures.push(item.claim);
    if (FAILURE_HINT.test(item.claim)) failures.push(item.claim);
    if (UNKNOWN_HINT.test(item.claim)) unknowns.push(item.claim);
    if (ACCEPTANCE_HINT.test(item.claim)) acceptance.push(item.claim);
  }
  return {
    constraints: unique(constraints, 16),
    procedures: unique(procedures, 16),
    failures: unique(failures, 12),
    unknowns: unique(unknowns, 12),
    acceptance: unique(acceptance, 16),
  };
}

function workerEvidence(result?: WorkerResult): EvidenceItem[] {
  if (!result) return [];
  return result.findings.map((finding) => EvidenceItemSchema.parse({
    id: evidenceId('worker', finding.evidence[0] || 'worker', finding.claim),
    claim: finding.claim,
    source: finding.evidence.join(', ') || 'worker-without-source',
    confidence: finding.confidence,
    kind: 'worker',
    freshness: 'current',
  }));
}

export function compileRuntimeContext(input: ContextCompilerInput): RuntimeWorkPacket {
  const raw = [input.request, input.memoryContext, input.sourceContext, input.toolContext, input.sessionContext]
    .filter(Boolean)
    .join('\n\n');
  const allEvidence = [
    ...evidenceFromText(input.toolContext, 'tool', 'tool-context'),
    ...evidenceFromText(input.sourceContext, 'source', 'source-context'),
    ...evidenceFromText(input.validationResults?.join('\n'), 'validation', 'validation'),
    ...workerEvidence(input.workerResult),
    ...evidenceFromText(input.memoryContext, 'memory', 'zenos-memory'),
    ...evidenceFromText(input.sessionContext, 'session', 'runtime-session'),
  ];

  const requestTokens = new Set(input.request.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 2));
  const deduped = new Map<string, EvidenceItem>();
  for (const item of allEvidence) {
    const key = item.claim.toLowerCase().replace(/\s+/g, ' ').slice(0, 1_000);
    const current = deduped.get(key);
    if (!current || item.confidence > current.confidence) deduped.set(key, item);
  }
  const ranked = [...deduped.values()]
    .filter((item) => item.confidence >= 0.45 && item.freshness !== 'stale')
    .sort((left, right) => scoreEvidence(right, requestTokens, input.targetRole) - scoreEvidence(left, requestTokens, input.targetRole));

  const classified = classifyLines(ranked);
  const relevantFiles = unique(ranked.flatMap((item) => [...item.source.matchAll(FILE_REFERENCE)].map((match) => match[1])), 32);
  const contradictions = unique([
    ...(input.workerResult?.contradictions || []),
    ...ranked.filter((item) => /\bcontradict|conflict|bertentangan|konflik\b/i.test(item.claim)).map((item) => item.claim),
  ], 16);
  const unknowns = unique([...(input.workerResult?.unknowns || []), ...classified.unknowns], 16);
  const constraints = unique(classified.constraints, 16);
  const procedures = unique([...(input.selectedProcedure || []), ...classified.procedures], 16);
  const previousFailures = unique(classified.failures, 12);
  const acceptanceCriteria = unique([...defaultAcceptance(input), ...classified.acceptance], 20);
  const forbiddenActions = unique(defaultForbidden(input.decision), 16);

  const skeleton = {
    version: 'etla-work-packet-v1' as const,
    packetId: `packet_${crypto.randomUUID()}`,
    goal: normalizeLine(input.request),
    taskFamily: input.decision.taskType,
    risk: input.decision.risk,
    targetRole: input.targetRole,
    constraints,
    verifiedFacts: ranked.slice(0, input.targetRole === 'boss' ? 10 : input.targetRole === 'worker' ? 24 : 18),
    relevantFiles,
    procedures,
    previousFailures,
    unknowns,
    contradictions,
    acceptanceCriteria,
    forbiddenActions,
    evidenceMap: ranked.slice(0, 40),
  };

  const rawTokens = estimateTokenCount(raw);
  let packet = skeleton;
  let serialized = JSON.stringify(packet);
  if (estimateTokenCount(serialized) > input.tokenBudget) {
    const facts = [...packet.verifiedFacts];
    const evidence = [...packet.evidenceMap];
    while (estimateTokenCount(serialized) > input.tokenBudget && (facts.length > 4 || evidence.length > 6)) {
      if (evidence.length > facts.length && evidence.length > 6) evidence.pop();
      else if (facts.length > 4) facts.pop();
      packet = { ...packet, verifiedFacts: facts, evidenceMap: evidence };
      serialized = JSON.stringify(packet);
    }
  }
  if (estimateTokenCount(serialized) > input.tokenBudget) {
    packet = {
      ...packet,
      constraints: packet.constraints.slice(0, 8),
      procedures: packet.procedures.slice(0, 8),
      previousFailures: packet.previousFailures.slice(0, 6),
      unknowns: packet.unknowns.slice(0, 6),
      contradictions: packet.contradictions.slice(0, 6),
      acceptanceCriteria: packet.acceptanceCriteria.slice(0, 10),
      forbiddenActions: packet.forbiddenActions.slice(0, 8),
    };
    serialized = truncateToTokenBudget(JSON.stringify(packet), input.tokenBudget);
    try {
      packet = { ...packet, goal: truncateToTokenBudget(packet.goal, Math.max(64, Math.floor(input.tokenBudget * 0.12))) };
    } catch {
      // The schema-safe packet below remains the deterministic fallback.
    }
  }

  const compiledTokens = Math.min(input.tokenBudget, estimateTokenCount(JSON.stringify(packet)));
  const result = RuntimeWorkPacketSchema.parse({
    ...packet,
    contextReduction: {
      rawTokens,
      compiledTokens,
      reductionRatio: rawTokens > 0 ? Math.max(0, Math.min(1, 1 - compiledTokens / rawTokens)) : 0,
    },
  });
  incrementMetric('runtime_context_packets_total', { role: input.targetRole, task: input.decision.taskType });
  incrementMetric('runtime_context_raw_tokens_total', { role: input.targetRole }, rawTokens);
  incrementMetric('runtime_context_compiled_tokens_total', { role: input.targetRole }, compiledTokens);
  return result;
}

export function renderRolePacket(packet: RuntimeWorkPacket): string {
  const conciseEvidence = packet.verifiedFacts.map((item) => ({
    claim: item.claim,
    source: item.source,
    confidence: item.confidence,
    kind: item.kind,
  }));
  if (packet.targetRole === 'worker') {
    return JSON.stringify({
      goal: packet.goal,
      exactTask: packet.goal,
      relevantFiles: packet.relevantFiles,
      facts: conciseEvidence,
      procedure: packet.procedures.slice(0, 8),
      unknowns: packet.unknowns,
      acceptanceCriteria: packet.acceptanceCriteria,
      forbiddenActions: packet.forbiddenActions,
      requiredOutput: 'Return the bounded WorkerResult JSON contract with evidence and confidence.',
    }, null, 2);
  }
  if (packet.targetRole === 'verifier') {
    return JSON.stringify({
      originalGoal: packet.goal,
      constraints: packet.constraints,
      evidence: conciseEvidence,
      contradictions: packet.contradictions,
      unknowns: packet.unknowns,
      acceptanceCriteria: packet.acceptanceCriteria,
      forbiddenActions: packet.forbiddenActions,
    }, null, 2);
  }
  if (packet.targetRole === 'boss') {
    return JSON.stringify({
      decisionRequired: packet.goal,
      risk: packet.risk,
      criticalFacts: conciseEvidence.slice(0, 8),
      conflicts: packet.contradictions,
      unknowns: packet.unknowns,
      constraints: packet.constraints.slice(0, 8),
      forbiddenActions: packet.forbiddenActions,
    }, null, 2);
  }
  return JSON.stringify({
    userIntent: packet.goal,
    facts: conciseEvidence,
    constraints: packet.constraints,
    tradeoffsOrContradictions: packet.contradictions,
    unknowns: packet.unknowns,
    acceptanceCriteria: packet.acceptanceCriteria,
    forbiddenActions: packet.forbiddenActions,
  }, null, 2);
}
