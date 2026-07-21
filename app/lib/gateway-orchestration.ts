import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  RouteDecision,
  RouteDecisionSchema,
  VerifierResult,
  WorkerResult,
  choosePipeline,
} from './zenos-runtime';
import {
  RuntimeModelResult,
  RuntimeRunRequestSchema,
  getRuntimeRoleIdentity,
  runBossReviewModel,
  runHostRevision,
  runVerifier,
  runWorkerCompression,
} from './zenos-runtime-executor';
import {
  completeRuntimeSession,
  createRuntimeSession,
  getRuntimeSession,
  reconcileStaleRuntimeSessions,
  updateRuntimeSession,
} from './zenos-runtime-three-agent';
import { BossDecision, BossDecisionSchema } from './zenos-runtime-state';
import { getRuntimeStore } from './zenos-runtime-store';
import { createTokenBudgetPlan, estimateTokenCount } from './token-economy';
import { authorizeTokenSpend, completeTokenBudget, settleTokenSpend, tokenGovernorSnapshot } from './token-governor';
import {
  GatewayExecutionReceipt,
  GatewayMemoryBrief,
  GatewayTurnPostflightInput,
  GatewayTurnPostflightRequestSchema,
  GatewayTurnPreflightInput,
  GatewayTurnPreflightRequest,
  GatewayTurnPreflightRequestSchema,
  GatewayTurnReceipt,
  StoredGatewayPreflight,
  StoredGatewayPreflightSchema,
} from './gateway-contracts';
import { accountGatewayModelUsage, callIdentity, gatewayHostCallCount } from './gateway-accounting';
import { hostWorkingSetForDecision, prepareGatewayContexts } from './gateway-continuity';
import {
  compactHostPlan,
  hostLedDecision,
  hostLedRuntimeEnabled,
  runGatewayHostPlanning,
} from './gateway-planning';
import { compileCognitivePacket, renderCognitivePacket } from './cognitive-kernel';
import { persistCognitiveOutcome, persistRecallFeedback } from './zenos-memory-client';
import {
  AcceptanceCheck,
  ContinuationCapsule,
  ContinuationCapsuleSchema,
  prepareCognitiveTask,
  renderContinuationCapsule,
  scheduleCognitiveContinuation,
  updateCognitiveTask,
} from './cognitive-task';
import { askUserAnswer, blockedAnswer, renderHostContext } from './gateway-rendering';
import {
  LatencyObservation,
  createLatencyBudgetPlan,
  observeLatency,
  roleLatencyTimeout,
} from './latency-budget';
import { recordOutcomePassport } from './outcome-ledger';
import { normalizeWorkspacePath } from './execution-boundary';
import {
  CodingTaskState,
  prepareCodexExecution,
  recordCodexPatch,
  recordCodingValidation,
  transitionCodingTask,
  updateCodingTask,
} from './codex-execution-core';

export { GatewayTurnPostflightRequestSchema, GatewayTurnPreflightRequestSchema } from './gateway-contracts';

function now(): string {
  return new Date().toISOString();
}

function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ensureGatewaySession(
  input: z.infer<typeof RuntimeRunRequestSchema>,
  decision: RouteDecision,
  runId: string,
  metadata: Record<string, unknown>,
): void {
  const current = getRuntimeSession(input.sessionId || '');
  if (!current) {
    createRuntimeSession(input, {
      sessionId: input.sessionId,
      modelOverrides: input.modelOverrides,
      metadata: { createdBy: 'hermes-native-gateway', ...metadata },
    });
  }
  const session = getRuntimeSession(input.sessionId || '');
  if (!session) throw new Error('Failed to create Runtime gateway session');
  getRuntimeStore().saveSession({
    ...session,
    userGoal: input.request,
    status: 'working',
    routeDecision: decision,
    activeRunId: runId,
    finalAnswer: undefined,
    lastError: undefined,
    metadata: { ...session.metadata, createdBy: 'hermes-native-gateway', ...metadata },
    version: session.version + 1,
    updatedAt: now(),
  });
}

function recordActivity(
  sessionId: string,
  role: 'host' | 'worker' | 'verifier' | 'boss' | 'tool',
  summary: string,
  metadata: Record<string, unknown>,
  outcome: 'queued' | 'started' | 'success' | 'failed' | 'skipped' = 'success',
): void {
  getRuntimeStore().insertEvent({
    sessionId,
    workerId: `gateway-${role}`,
    type: outcome === 'failed' ? 'error' : 'progress',
    summary,
    evidence: [],
    severity: 'low',
    confidence: outcome === 'failed' ? 0 : 1,
    needsBoss: false,
    metadata: { role, outcome, ...metadata },
    createdAt: now(),
  });
}

function safeBossDecision(call: RuntimeModelResult): BossDecision | undefined {
  if (!call.ok || !call.parsed) return undefined;
  const parsed = BossDecisionSchema.safeParse(call.parsed);
  return parsed.success ? parsed.data : undefined;
}

function mandatoryBossFallback(reason: string): BossDecision {
  return BossDecisionSchema.parse({
    verdict: 'block',
    confidence: 1,
    reasoningSummary: `Mandatory Boss authority was unavailable or invalid: ${String(reason || 'unknown failure').slice(0, 2_000)}`,
    requiredChanges: [
      'Restore the configured Boss model or explicitly choose a lower-authority route before retrying.',
      'Do not execute, deploy, restart, or release a high-risk answer while mandatory authority is unavailable.',
    ],
    allowedActions: ['Report the authority failure and preserve the current safe state.'],
    forbiddenActions: ['Execute privileged or destructive actions.', 'Claim that Boss approval was obtained.'],
  });
}

function memoryCoverageScore(memory: GatewayMemoryBrief): number | undefined {
  if (!memory.coverage) return undefined;
  const checks = [
    memory.coverage.goal,
    memory.coverage.decisions,
    memory.coverage.pendingWork,
    memory.coverage.questions,
    memory.coverage.artifacts,
  ];
  return checks.filter(Boolean).length / checks.length;
}

function deterministicValidationState(
  toolSummary: string,
  receipts: GatewayExecutionReceipt[] = [],
): 'passed' | 'failed' | 'unknown' {
  const validationReceipts = receipts.filter(receipt => (
    receipt.kind === 'validation' || Boolean(receipt.validationKind)
  ));
  if (validationReceipts.length) {
    if (validationReceipts.some(receipt => receipt.status === 'failed' || receipt.status === 'blocked')) return 'failed';
    if (validationReceipts.every(receipt => receipt.status === 'passed')) return 'passed';
    return 'unknown';
  }

  // Compatibility fallback for older Hermes gateways. New gateways must send
  // structured receipts; prose is not authoritative execution evidence.
  const text = String(toolSummary || '').toLowerCase();
  if (!text.trim()) return 'unknown';
  const hasValidation = /\b(test|tests|lint|typecheck|build|compile|validation|pytest|vitest|jest|py_compile)\b/.test(text);
  if (!hasValidation) return 'unknown';
  if (/\b(fail(?:ed|ure)?|error|errors|non[- ]?zero|exit\s+(?:code\s*)?[1-9]|timed out|timeout)\b/.test(text)) return 'failed';
  if (/\b(pass(?:ed)?|success(?:ful)?|completed|green|exit\s+(?:code\s*)?0|0\s+errors?)\b/.test(text)) return 'passed';
  return 'unknown';
}

const CODE_ARTIFACT_PATTERN = /(?:\/[A-Za-z0-9._/-]+|\b[A-Za-z0-9._-]+)\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|sql|sh)\b/i;
const CODING_ACTIVITY_PATTERN = /\b(?:read(?:ing)?|edit(?:ing|ed)?|patch(?:ing|ed)?|write|wrote|modified|changed|implement(?:ing|ed)?|refactor(?:ing|ed)?|test(?:ing|ed)?|lint(?:ing|ed)?|build(?:ing|ed)?|compil(?:e|ing|ed)|traceback)\b/i;
const CODING_MUTATION_PATTERN = /\b(?:edit(?:ing|ed)?|patch(?:ing|ed)?|write|wrote|modified|changed|implement(?:ing|ed)?|refactor(?:ing|ed)?|repair(?:ing|ed)?|fix(?:ing|ed)?)\b/i;
const CODING_UNFINISHED_PATTERN = /\b(?:indentationerror|syntaxerror|compile\s+error|typecheck\s+error|test(?:s)?\s+failed|lint\s+failed|build\s+failed|patch\s+failed|mid[- ]patch|belum\s+(?:selesai|beres|ke-?apply|di-?apply)|unfinished|pending|blocker|next\s+turn|remaining\s+work|rollback|rusak|broken|partial|sisa\s+\d+|tinggal\s+(?:restart|test|verify|patch|fix)|maximum\s+number\s+of\s+tool|tool[- ]calling\s+iterations?|active\s+task\s+list)\b/i;
const CODING_COMPLETED_PATTERN = /\b(?:all\s+tests?\s+passed|tests?\s+passed|validation\s+passed|typecheck\s+passed|lint\s+passed|build\s+passed|compile\s+passed|working\s+tree\s+clean|completed\s+successfully|selesai\s+dan\s+tervalidasi)\b/i;
const CODING_FOLLOW_UP_PATTERN = /^\s*(?:tapi|dan|terus|juga|sekalian|lanjut(?:kan)?|nah|yang\s+tadi|itu|ini|gas+|soalnya|fix(?:in|kan)?|tolong\s+(?:fix|lanjut|terusin|beresin|kerjain)|beresin|kerjain|terusin|continue|resume)\b/i;
const WORKSPACE_ROOT_PATTERN = /(?:\/srv\/etla\/workspaces|\/root\/openclaw-projects)\/[A-Za-z0-9._-]+/g;
const HOST_CONFIRMATION_PATTERN = /(?:\b(?:gas|lanjut|continue|proceed)\??\s*$|\b(?:mau|boleh)\s+(?:gue|aku|saya)\s+(?:lanjut|fix|kerjain|restart|test)|\bwant\s+me\s+to\s+(?:continue|proceed)|\bshall\s+i\s+(?:continue|proceed))/i;
const TOOL_EXHAUSTION_PATTERN = /(?:maximum\s+number\s+of\s+tool[- ]calling\s+iterations|tool[- ]calling\s+limit|context\s+compaction|output\s+length\s+limit|continue\s+exactly\s+where\s+you\s+left\s+off)/i;
const COGNITIVE_CONTINUATION_PATTERN = /continue the same root task as an internal zenos cognitive runtime cycle/i;
const GENUINE_USER_INPUT_PATTERN = /(?:\b(?:missing|need|requires?)\s+(?:an?\s+)?(?:api\s+key|credential|secret|token|password|wallet\s+key|email\s+address|recipient|destination|nomor\s+tujuan|alamat\s+email)|\b(?:butuh|perlu)\s+(?:alamat\s+email|email\s+tujuan|nomor\s+tujuan|penerima|credential|api\s+key)\b|\b(?:pilih|choose|which\s+option)\b|\bexplicit\s+approval\b|\bauthori[sz]ation\s+required\b)/i;
const MUTATING_TOOL_PATTERN = /\b(?:apply_patch|patch|edit_file|write_file|replace_in_file|str_replace|create_file|delete_file|editing|updated|modified|wrote|applied\s+patch)\b/i;
const BROKEN_CODE_PATTERN = /\b(?:indentationerror|syntaxerror|compileerror|compile\s+error|typecheck\s+error|traceback|test(?:s)?\s+failed|lint\s+failed|build\s+failed|patch\s+failed|exit\s+(?:code\s*)?[1-9])\b/i;

function lastPatternIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  let index = -1;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    index = match.index ?? index;
  }
  return index;
}

function activeCodingContinuationDecision(
  decision: RouteDecision,
  request: GatewayTurnPreflightRequest,
): RouteDecision {
  const bossRequested = request.userRequestedBoss;
  const continuation = RouteDecisionSchema.parse({
    ...decision,
    taskType: 'coding_change',
    pipelineMode: bossRequested ? 'escalated_deep_path' : 'grounded_path',
    risk: 'high',
    hostTier: 'premium',
    workerTier: 'none',
    verifierTier: request.userRequestedVerification ? 'cheap' : 'none',
    useMemory: true,
    useTools: true,
    useWorker: false,
    useVerifier: request.userRequestedVerification,
    useBoss: bossRequested,
    allowEscalation: bossRequested,
    requiresApproval: false,
    requiresSourceContext: true,
    maxMemoryItems: Math.max(decision.maxMemoryItems, 4),
    maxWorkerCalls: 0,
    maxContextTokens: Math.max(decision.maxContextTokens, 12_000),
    maxRevisionAttempts: request.userRequestedVerification ? Math.max(decision.maxRevisionAttempts, 1) : 0,
    reasons: [
      ...decision.reasons.filter((reason) => !/^task:|^risk:|deploy_or_destructive_action/i.test(reason)),
      'task:coding_change',
      'risk:high',
      'active durable coding task overrides lexical classification of the internal continuation prompt',
      'Host continues with native Hermes tools/delegation and deterministic validation; Runtime Worker/Verifier are not mandatory',
    ],
  });
  return hostLedRuntimeEnabled() ? hostLedDecision(continuation, request) : continuation;
}

function inferWorkspaceRootFromContinuity(continuity: string): string | undefined {
  const matches = [...continuity.matchAll(WORKSPACE_ROOT_PATTERN)];
  const latest = matches.at(-1)?.[0];
  return latest ? normalizeWorkspacePath(latest) : undefined;
}

function preserveUnfinishedCodingContinuity(
  request: GatewayTurnPreflightRequest,
): { request: GatewayTurnPreflightRequest; recovered: boolean } {
  if (request.hasCodeChangeIntent || !CODING_FOLLOW_UP_PATTERN.test(request.request)) {
    return { request, recovered: false };
  }
  const previous = getRuntimeSession(request.sessionId);
  const continuity = [
    request.context,
    ...request.handoffMessages.map((message) => message.content),
    previous?.finalAnswer || '',
    previous?.lastError || '',
  ].filter(Boolean).join('\n');
  const inferredWorkspaceRoot = request.workspaceRoot || inferWorkspaceRootFromContinuity(continuity);
  const hasRepositoryEvidence = Boolean(inferredWorkspaceRoot) || CODE_ARTIFACT_PATTERN.test(continuity);
  const hasCodingActivity = CODE_ARTIFACT_PATTERN.test(continuity)
    && CODING_ACTIVITY_PATTERN.test(continuity)
    && CODING_MUTATION_PATTERN.test(continuity);
  const lastUnfinished = lastPatternIndex(continuity, CODING_UNFINISHED_PATTERN);
  const lastCompleted = lastPatternIndex(continuity, CODING_COMPLETED_PATTERN);
  if (!hasRepositoryEvidence || !hasCodingActivity || lastUnfinished < 0 || lastUnfinished < lastCompleted) {
    return { request, recovered: false };
  }

  return {
    recovered: true,
    request: GatewayTurnPreflightRequestSchema.parse({
      ...request,
      workspaceRoot: inferredWorkspaceRoot,
      hasFiles: true,
      hasCodeChangeIntent: true,
      userRequestedVerification: true,
      intent: request.intent === 'execute' ? 'execute' : 'mutate',
      confidence: Math.max(request.confidence, 0.9),
    }),
  };
}

function workspaceMutationObserved(
  before: GatewayTurnPreflightRequest['workspaceState'],
  after: GatewayTurnPreflightRequest['workspaceState'],
): boolean {
  if (!before || !after) return false;
  if (before.dirtyDiffSha256 !== after.dirtyDiffSha256) return true;
  const beforeFiles = new Map(before.changedFiles.map((file) => [file.path, `${file.exists}:${file.sha256 || ''}`]));
  return after.changedFiles.some((file) => beforeFiles.get(file.path) !== `${file.exists}:${file.sha256 || ''}`)
    || before.changedFiles.some((file) => !after.changedFiles.some((candidate) => candidate.path === file.path));
}

function observedCodingState(
  toolSummary: string,
  receipts: GatewayExecutionReceipt[] = [],
): { mutated: boolean; broken: boolean } {
  const text = String(toolSummary || '');
  const hasCodeArtifact = CODE_ARTIFACT_PATTERN.test(text);
  const receiptMutation = receipts.some(receipt => (
    receipt.changedFiles.length > 0
    || (receipt.kind === 'workspace'
      && Boolean(receipt.workspaceRevisionBefore)
      && receipt.workspaceRevisionBefore !== receipt.workspaceRevisionAfter)
    || receipt.metadata.mutating === true
  ));
  const textMutation = MUTATING_TOOL_PATTERN.test(text)
    || (hasCodeArtifact && CODING_MUTATION_PATTERN.test(text));
  const mutated = receiptMutation || textMutation;
  const receiptBroken = receipts.some(receipt => (
    (receipt.kind === 'validation' || receipt.kind === 'workspace')
    && (receipt.status === 'failed' || receipt.status === 'blocked')
  ));
  return {
    mutated,
    broken: mutated && (receiptBroken || BROKEN_CODE_PATTERN.test(text)),
  };
}

function acceptanceChecksFromEvidence(input: {
  capsule: ContinuationCapsule;
  decision: RouteDecision;
  receipts: GatewayExecutionReceipt[];
  deterministicValidation: 'passed' | 'failed' | 'unknown';
  observedCoding: { mutated: boolean; broken: boolean };
  workspaceMutated: boolean;
  draft: string;
  failed: boolean;
}): AcceptanceCheck[] {
  const receiptIds = input.receipts.map(receipt => receipt.receiptId);
  const failedReceipts = input.receipts.filter(receipt => receipt.status === 'failed' || receipt.status === 'blocked');
  const allReceiptsPassed = input.receipts.length > 0
    && input.receipts.every(receipt => receipt.status === 'passed');
  const artifactReceiptIds = input.receipts
    .filter(receipt => receipt.kind === 'artifact' || receipt.artifactIds.length > 0 || receipt.changedFiles.length > 0)
    .map(receipt => receipt.receiptId);
  const validationReceiptIds = input.receipts
    .filter(receipt => receipt.kind === 'validation' || Boolean(receipt.validationKind))
    .map(receipt => receipt.receiptId);
  const mutationReceiptIds = input.receipts
    .filter(receipt => receipt.changedFiles.length > 0 || receipt.kind === 'workspace' || receipt.metadata.mutating === true)
    .map(receipt => receipt.receiptId);
  const codingTask = ['coding_change', 'debugging'].includes(input.decision.taskType);
  const timestamp = now();

  return input.capsule.acceptanceChecks.map((check) => {
    let status = check.status;
    let evidenceIds = check.evidenceIds;
    let detail = check.detail;
    if (input.failed) {
      status = 'failed';
      detail = 'Hermes Host reported a failed cycle.';
    } else if (check.kind === 'validation') {
      status = input.deterministicValidation === 'passed'
        ? 'passed'
        : input.deterministicValidation === 'failed'
          ? 'failed'
          : 'pending';
      evidenceIds = [...new Set([...evidenceIds, ...validationReceiptIds])];
      detail = `deterministic_validation=${input.deterministicValidation}`;
    } else if (check.kind === 'implementation') {
      if (input.observedCoding.broken) {
        status = 'failed';
        detail = 'Structured or compatibility evidence reports broken code.';
      } else if (codingTask) {
        status = input.observedCoding.mutated || input.workspaceMutated ? 'passed' : 'pending';
        detail = status === 'passed'
          ? 'Workspace mutation was observed.'
          : 'No workspace mutation evidence was supplied.';
      } else if (allReceiptsPassed) {
        status = 'passed';
        detail = 'All structured execution receipts passed.';
      }
      evidenceIds = [...new Set([...evidenceIds, ...mutationReceiptIds])];
    } else if (check.kind === 'artifact') {
      if (artifactReceiptIds.length || input.workspaceMutated) {
        status = 'passed';
        evidenceIds = [...new Set([...evidenceIds, ...artifactReceiptIds])];
        detail = 'Artifact or changed-file evidence was supplied.';
      } else if (failedReceipts.some(receipt => receipt.kind === 'artifact')) {
        status = 'failed';
        detail = 'Artifact production failed.';
      } else {
        status = 'pending';
      }
    } else if (check.kind === 'response') {
      status = input.draft.trim() ? 'passed' : 'pending';
      detail = status === 'passed' ? 'A terminal response candidate exists.' : 'No response candidate exists.';
    } else if (input.decision.useTools) {
      if (failedReceipts.length) {
        status = 'failed';
        evidenceIds = [...new Set([...evidenceIds, ...failedReceipts.map(receipt => receipt.receiptId)])];
        detail = 'At least one structured execution receipt failed.';
      } else if (allReceiptsPassed || (codingTask && input.deterministicValidation === 'passed' && (input.observedCoding.mutated || input.workspaceMutated))) {
        status = 'passed';
        evidenceIds = [...new Set([...evidenceIds, ...receiptIds])];
        detail = allReceiptsPassed
          ? 'All structured execution receipts passed.'
          : 'Compatibility workspace and deterministic validation evidence passed.';
      } else {
        status = 'pending';
      }
    } else {
      status = input.draft.trim() ? 'passed' : 'pending';
      detail = status === 'passed' ? 'Direct Host response completed the non-tool criterion.' : detail;
    }
    return {
      ...check,
      status,
      evidenceIds: evidenceIds.slice(0, 100),
      detail,
      updatedAt: timestamp,
    };
  });
}

function acceptanceCriteriaSatisfied(capsule: ContinuationCapsule | undefined): boolean {
  if (!capsule) return true;
  const required = capsule.acceptanceChecks.filter(check => check.required);
  return required.length === 0 || required.every(check => check.status === 'passed');
}

function hostStoppedBeforeTerminalWork(draft: string, toolSummary: string): boolean {
  const evidence = `${String(draft || '')}\n${String(toolSummary || '')}`;
  if (GENUINE_USER_INPUT_PATTERN.test(evidence)) return false;
  return TOOL_EXHAUSTION_PATTERN.test(evidence) || HOST_CONFIRMATION_PATTERN.test(String(draft || ''));
}

function postflightDecisionForObservedMutation(
  current: RouteDecision,
  input: z.infer<typeof RuntimeRunRequestSchema>,
): RouteDecision {
  const upgraded = choosePipeline(input);
  if (hostLedRuntimeEnabled()) {
    return hostLedDecision(RouteDecisionSchema.parse({
      ...upgraded,
      useTools: true,
      useMemory: current.useMemory || upgraded.useMemory,
      reasons: [
        ...upgraded.reasons,
        'postflight observed an actual code mutation from Hermes tool evidence',
        'deterministic validation, not a mandatory independent LLM judge, governs completion',
      ],
    }), input);
  }
  const useWorker = current.useWorker;
  const useVerifier = upgraded.useVerifier;
  const useBoss = upgraded.useBoss;
  return RouteDecisionSchema.parse({
    ...upgraded,
    useWorker,
    workerTier: useWorker ? current.workerTier : 'none',
    maxWorkerCalls: useWorker ? current.maxWorkerCalls : 0,
    useVerifier,
    useBoss,
    pipelineMode: useBoss
      ? 'escalated_deep_path'
      : useVerifier
        ? 'verified_path'
        : upgraded.useTools || upgraded.useMemory
          ? 'grounded_path'
          : 'direct_fast_path',
    reasons: [
      ...upgraded.reasons,
      'postflight observed an actual code mutation from Hermes tool evidence',
    ],
  });
}

export async function preflightGatewayTurn(raw: GatewayTurnPreflightInput) {
  const turnStartedAtMs = Date.now();
  const store = getRuntimeStore();
  const continuity = preserveUnfinishedCodingContinuity(GatewayTurnPreflightRequestSchema.parse(raw));
  let request = continuity.request;
  const gatewayReportedHost = request.host;
  const configuredHost = getRuntimeRoleIdentity('host', request.sessionId, request.modelOverrides);
  const authoritativeHostEnabled = process.env.ZENOS_RUNTIME_AUTHORITATIVE_HOST !== 'false';
  if (authoritativeHostEnabled && configuredHost.model && configuredHost.provider) {
    request = GatewayTurnPreflightRequestSchema.parse({
      ...request,
      host: configuredHost,
    });
  }
  const activeCodingRecord = store.findActiveCodingTaskBySession(request.sessionId);
  if (activeCodingRecord && request.workspaceRoot) {
    request = GatewayTurnPreflightRequestSchema.parse({
      ...request,
      hasFiles: true,
      hasCodeChangeIntent: true,
      userRequestedVerification: true,
      intent: request.intent === 'execute' ? 'execute' : 'mutate',
      confidence: Math.max(request.confidence, 0.95),
    });
  }
  reconcileStaleRuntimeSessions({ excludeSessionId: request.sessionId });
  store.reconcileExpiredRuns(now());
  const runId = `gateway_${crypto.randomUUID()}`;
  let baselineDecision = choosePipeline(request);
  const deterministicContinuation = Boolean(request.workspaceRoot && (activeCodingRecord || continuity.recovered));
  if (deterministicContinuation) {
    baselineDecision = activeCodingContinuationDecision(baselineDecision, request);
    if (continuity.recovered && !activeCodingRecord) {
      baselineDecision = RouteDecisionSchema.parse({
        ...baselineDecision,
        reasons: [
          ...baselineDecision.reasons,
          'unfinished coding context recovered from compacted session evidence',
          'terse continuation request is executed autonomously without another confirmation turn',
        ],
      });
    }
  }
  const latencyPlan = createLatencyBudgetPlan(baselineDecision);
  let decision = baselineDecision;
  const existingSession = Boolean(getRuntimeSession(request.sessionId));
  const preparedContexts = await prepareGatewayContexts({
    request,
    decision: baselineDecision,
    existingSession,
    latencyPlan,
  });
  const { repositoryContext, memoryBrief } = preparedContexts;
  const preflightLatency: LatencyObservation[] = [...preparedContexts.observations];
  let codingTask: CodingTaskState | undefined;
  let codingContext = '';
  if (
    request.workspaceRoot
    && ['coding_change', 'debugging'].includes(baselineDecision.taskType)
  ) {
    const preparedCoding = await prepareCodexExecution({
      taskId: activeCodingRecord?.taskId,
      runId,
      sessionId: request.sessionId,
      request: request.request,
      workspaceRoot: request.workspaceRoot,
      acceptanceCriteria: ['Requested behavior is implemented.', 'Affected deterministic validation passes.', 'No unrelated files are modified.'],
    }, store);
    codingTask = preparedCoding.state;
    codingContext = preparedCoding.context;
  }
  const input = RuntimeRunRequestSchema.parse({
    ...request,
    sessionId: request.sessionId,
    persistSession: true,
    context: [request.context, repositoryContext, codingContext].filter(Boolean).join('\n\n'),
    memoryContext: memoryBrief.context,
    toolContext: repositoryContext,
    namespace: 'zenos',
    autoRecallMemory: false,
    persistRouteEvent: false,
    tokenPriority: 'economy',
    approvalGranted: request.approvalGranted,
    dryRun: false,
    modelOverrides: request.modelOverrides,
    codingTaskId: codingTask?.taskId,
    autonomousCoding: false,
    includeExecutionReceipt: false,
  });
  // Host planning is an optional auxiliary call. Give it an isolated budget so
  // a slow or verbose planner can never consume the mandatory Hermes Host
  // reservation for the actual user-facing turn.
  const planningBudget = createTokenBudgetPlan(baselineDecision, input, {
    userPriority: input.tokenPriority,
    budgetId: `${runId}:planning`,
  });

  ensureGatewaySession(input, baselineDecision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
    gatewayReportedHostModel: gatewayReportedHost.model,
    gatewayReportedHostProvider: gatewayReportedHost.provider,
    hostAuthority: authoritativeHostEnabled ? 'runtime' : 'gateway',
    memorySource: memoryBrief.source,
    memoryCoverageComplete: memoryBrief.coverage?.complete,
  });
  recordActivity(
    request.sessionId,
    'tool',
    memoryBrief.source === 'none'
      ? 'Zenos Memory context was not required or was unavailable for this turn.'
      : `Zenos Memory supplied bounded ${memoryBrief.source} context.`,
    {
      subsystem: 'zenos-memory',
      runId,
      turnId: request.turnId,
      source: memoryBrief.source,
      coverage: memoryBrief.coverage,
      degraded: memoryBrief.degraded,
      cacheHit: memoryBrief.cacheHit,
      latencyMs: memoryBrief.latencyMs,
    },
    memoryBrief.source === 'none' ? 'skipped' : 'success',
  );
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    errors: [],
    startedAt: now(),
  });
  recordActivity(
    request.sessionId,
    'host',
    `Hermes Host ${request.host.model} owns the turn and is preparing orchestration.`,
    {
      lifecycle: 'role_state',
      runId,
      turnId: request.turnId,
      role: 'host',
      status: 'queued',
      model: request.host.model,
      provider: request.host.provider,
    },
    'queued',
  );

  const hostPlanning = deterministicContinuation
    ? { decision: hostLedRuntimeEnabled() ? hostLedDecision(baselineDecision, request) : baselineDecision }
    : await runGatewayHostPlanning(
        request,
        input,
        baselineDecision,
        repositoryContext,
        memoryBrief,
        runId,
        latencyPlan,
        planningBudget,
      );
  if (hostPlanning.call) {
    preflightLatency.push(observeLatency('host', hostPlanning.call.latencyMs, latencyPlan.hostMs));
  }
  const hostPlan = hostPlanning.plan;
  const hostPlanCall = hostPlanning.call;
  completeTokenBudget(planningBudget.budgetId);
  decision = hostPlanning.decision;
  const cognitivePacket = compileCognitivePacket({
    request,
    decision,
    memory: memoryBrief,
    repositoryContext,
  });
  const cognitiveCapsule = prepareCognitiveTask({
    sessionId: request.sessionId,
    runId,
    packet: cognitivePacket,
    workspaceRevision: codingTask?.workspaceRevision || request.workspaceState?.dirtyDiffSha256,
    reuseActive: deterministicContinuation || COGNITIVE_CONTINUATION_PATTERN.test(request.request),
    store,
  });
  ensureGatewaySession(input, decision, runId, {
    turnId: request.turnId,
    platform: request.platform,
    hostModel: request.host.model,
    hostProvider: request.host.provider,
    orchestration: hostLedRuntimeEnabled()
      ? 'cognitive-host-led'
      : deterministicContinuation
        ? 'deterministic-continuation'
        : hostPlan
          ? 'host-led'
          : 'deterministic-fallback',
    cognitivePhase: cognitivePacket.phase,
    cognitiveTaskId: cognitiveCapsule.taskId,
    cognitiveCycle: cognitiveCapsule.cycle,
    cognitiveWorkerModelPolicy: cognitivePacket.workerModelPolicy,
    hostPlanConfidence: hostPlan?.confidence,
  });
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    errors: hostPlanCall && !hostPlan ? ['Host planning failed; deterministic safety route retained'] : [],
    startedAt: now(),
  });
  const baseBudget = createTokenBudgetPlan(decision, input, {
    userPriority: input.tokenPriority,
    budgetId: cognitiveCapsule.rootRunId,
  });
  const budget = {
    ...baseBudget,
    host: { ...baseBudget.host, timeoutMs: roleLatencyTimeout(latencyPlan, 'host') },
    worker: { ...baseBudget.worker, timeoutMs: roleLatencyTimeout(latencyPlan, 'worker') },
    verifier: { ...baseBudget.verifier, timeoutMs: roleLatencyTimeout(latencyPlan, 'verifier') },
    boss: { ...baseBudget.boss, timeoutMs: roleLatencyTimeout(latencyPlan, 'boss') },
  };
  const hostCallId = `${runId}:hermes-host`;
  const hostReservationTokens = Math.min(
    budget.host.inputTokens + budget.host.outputTokens,
    estimateTokenCount([
      request.request,
      repositoryContext,
      memoryBrief.context,
    ].filter(Boolean).join('\n\n'), request.host.model) + budget.host.outputTokens,
  );
  const hostAuthorization = authorizeTokenSpend({
    plan: budget,
    requestId: hostCallId,
    role: 'host',
    estimatedTokens: hostReservationTokens,
    mandatory: true,
  });
  if (!hostAuthorization.allowed) {
    throw new Error(hostAuthorization.reason || 'Unable to reserve the mandatory Hermes Host token budget');
  }

  let workerResult: WorkerResult | undefined;
  let workerCall: RuntimeModelResult | undefined;
  if (decision.useWorker) {
    const worker = await runWorkerCompression(input, undefined, {
      pass: 1,
      totalPasses: 1,
      requestId: `${runId}:gateway-worker:1`,
      budget,
      delegationTask: hostPlan?.workerTask,
      acceptanceCriteria: hostPlan?.acceptanceCriteria,
      constraints: hostPlan?.constraints,
    });
    workerResult = worker.result;
    workerCall = worker.call;
    preflightLatency.push(observeLatency('worker', worker.call.latencyMs, latencyPlan.workerMs));
    recordActivity(
      request.sessionId,
      'worker',
      worker.result
        ? `Worker ${worker.call.model} produced a bounded execution brief.`
        : `Worker ${worker.call.model || 'unknown'} failed to produce a valid brief.`,
      {
        runId,
        turnId: request.turnId,
        model: worker.call.model,
        provider: worker.call.provider,
        modelUsage: worker.call.usage,
      },
      worker.result ? 'success' : 'failed',
    );
  } else {
    recordActivity(
      request.sessionId,
      'worker',
      'Worker skipped by Host orchestration and safety policy.',
      { runId, turnId: request.turnId },
      'skipped',
    );
  }

  let bossPreflight: BossDecision | undefined;
  let bossCall: RuntimeModelResult | undefined;
  if (decision.useBoss || decision.requiresApproval) {
    bossCall = await runBossReviewModel({
      stage: 'preflight',
      runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      userGoal: input.request,
      decision,
      approvalGranted: request.approvalGranted,
      hostPlan,
      workerResult,
      host: request.host,
    }, {
      sessionId: request.sessionId,
      modelOverrides: input.modelOverrides,
      requestId: `${runId}:gateway-boss-preflight`,
      maxInputTokens: budget.boss.inputTokens,
      maxOutputTokens: budget.boss.outputTokens,
      timeoutMs: roleLatencyTimeout(latencyPlan, 'boss'),
      trigger: request.userRequestedBoss ? 'user_requested_boss' : 'host_or_safety_escalation',
      tokenBudgetPlan: budget,
      mandatory: request.userRequestedBoss || decision.requiresApproval,
    });
    bossPreflight = safeBossDecision(bossCall);
    if (!bossPreflight && (request.userRequestedBoss || decision.requiresApproval)) {
      bossPreflight = mandatoryBossFallback(bossCall.error || 'Boss preflight returned no valid decision');
    }
    preflightLatency.push(observeLatency('boss', bossCall.latencyMs, latencyPlan.bossMs));
    recordActivity(
      request.sessionId,
      'boss',
      bossPreflight
        ? `Boss ${bossCall.model} returned preflight verdict ${bossPreflight.verdict}.`
        : `Boss ${bossCall.model || 'unknown'} preflight failed.`,
      {
        runId,
        turnId: request.turnId,
        model: bossCall.model,
        provider: bossCall.provider,
        verdict: bossPreflight?.verdict,
        modelUsage: bossCall.usage,
      },
      bossPreflight ? 'success' : 'failed',
    );
  } else {
    recordActivity(
      request.sessionId,
      'boss',
      'Boss skipped because Host and safety policy did not require highest-authority review.',
      { runId, turnId: request.turnId },
      'skipped',
    );
  }

  recordActivity(
    request.sessionId,
    'host',
    `Hermes Host ${request.host.model} started the user-facing turn.`,
    {
      lifecycle: 'model_call',
      runId,
      turnId: request.turnId,
      callId: hostCallId,
      role: 'host',
      status: 'calling',
      model: request.host.model,
      provider: request.host.provider,
      trigger: 'host_final_synthesis',
    },
    'started',
  );

  const holdFinalDelivery = decision.useVerifier || decision.useBoss || decision.requiresApproval;
  const stored: StoredGatewayPreflight = {
    kind: 'gateway_preflight_v2',
    input,
    turnId: request.turnId,
    platform: request.platform,
    host: request.host,
    hostPlan,
    cognitivePacket,
    cognitiveTaskId: cognitiveCapsule.taskId,
    continuationCapsule: cognitiveCapsule,
    hostPlanCall,
    workerResult,
    workerCall,
    bossPreflight,
    bossCall,
    repositoryContext: repositoryContext || undefined,
    memorySource: memoryBrief.source,
    memoryEvidenceRefs: memoryBrief.evidenceRefs || [],
    memoryCoverage: memoryCoverageScore(memoryBrief),
    latencyPlan,
    preflightLatency,
    turnStartedAtMs,
    holdFinalDelivery,
    codingTaskId: codingTask?.taskId,
    codingPhase: codingTask?.currentPhase,
    workspaceState: request.workspaceState,
  };
  store.saveRun({
    runId,
    sessionId: request.sessionId,
    requestHash: hashRequest({ request: input.request, context: input.context, turnId: request.turnId }),
    status: 'running',
    decision,
    result: stored,
    errors: [],
    startedAt: now(),
  });

  return {
    ok: true,
    runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    decision,
    holdFinalDelivery,
    hostAuthority: authoritativeHostEnabled ? 'runtime' : 'gateway',
    hostOverride: request.host,
    cognitiveTaskId: cognitiveCapsule.taskId,
    cognitivePhase: cognitiveCapsule.phase,
    codingTaskId: codingTask?.taskId,
    codingPhase: codingTask?.currentPhase,
    hostContext: [
      renderHostContext(decision, hostPlan, workerResult, bossPreflight, memoryBrief, runId),
      renderCognitivePacket(cognitivePacket),
      renderContinuationCapsule(cognitiveCapsule),
      authoritativeHostEnabled
        ? `Runtime Host authority:\n- selected_model: ${request.host.model}\n- selected_provider: ${request.host.provider}\n- gateway_reported_model: ${gatewayReportedHost.model}\n- gateway_reported_provider: ${gatewayReportedHost.provider}\n- The selected Runtime Host is authoritative for this turn and must be applied before Hermes creates or reuses its agent.`
        : '',
      request.workspaceRoot
        ? `Canonical workspace root: ${request.workspaceRoot}\n- Use this path for every repository and terminal operation.\n- Treat /root/openclaw-projects as a legacy alias only; never send it to Hermes tools inside the hardened service sandbox.`
        : '',
      codingTask
        ? `Transactional coding state:\n- task_id: ${codingTask.taskId}\n- phase: ${codingTask.currentPhase}\n- checkpoint: ${codingTask.checkpoints.at(-1)?.checkpointId || 'pending'}\n- workspace_revision: ${codingTask.workspaceRevision}\n- Rule: before any new mutation after compaction or interruption, reconcile Git HEAD, dirty diff hash, and changed-file hashes. Never deploy or restart before deterministic validation passes.\n- Autonomy rule: do not ask the user to reply \"gas\", \"lanjut\", or confirm ordinary implementation steps. Continue through inspect, patch, targeted validation, and safe non-privileged recovery in the same visible request. Ask only for genuinely missing user-owned input or explicit approval required by a privileged/destructive boundary.`
        : '',
    ].filter(Boolean).join('\n\n'),
    hostWorkingSetTokens: hostWorkingSetForDecision(decision),
    hostBudget: {
      budgetId: budget.budgetId,
      reservationId: hostCallId,
      reservedTokens: hostReservationTokens,
      maxCalls: budget.host.maxCalls,
      maxOutputTokens: budget.host.outputTokens,
      accounting: 'uncached-input-plus-cache-write-plus-output' as const,
    },
    receipt: {
      pipeline: decision.pipelineMode,
      host: {
        ...request.host,
        invoked: true,
        plannerInvoked: Boolean(hostPlanCall),
        calls: hostPlanCall ? 2 : 1,
      },
      worker: callIdentity(workerCall),
      verifier: { invoked: false },
      boss: { ...callIdentity(bossCall), verdict: bossPreflight?.verdict },
      transformed: false,
    } satisfies GatewayTurnReceipt,
  };
}

export async function postflightGatewayTurn(raw: GatewayTurnPostflightInput) {
  const request = GatewayTurnPostflightRequestSchema.parse(raw);
  const store = getRuntimeStore();
  const run = store.getRun(request.runId);
  if (!run || run.sessionId !== request.sessionId) throw new Error('Gateway Runtime run was not found for this session');
  const storedDecision = RouteDecisionSchema.parse(run.decision);
  const stored = StoredGatewayPreflightSchema.parse(run.result);
  const storedCognitiveRecord = stored.cognitiveTaskId
    ? store.getCognitiveTask(stored.cognitiveTaskId)
    : undefined;
  const parsedCognitiveCapsule = ContinuationCapsuleSchema.safeParse(
    storedCognitiveRecord?.capsule || stored.continuationCapsule,
  );
  let cognitiveCapsule = parsedCognitiveCapsule.success ? parsedCognitiveCapsule.data : undefined;
  const rootBudgetId = cognitiveCapsule?.rootRunId || request.runId;
  const turnStartedAtMs = stored.turnStartedAtMs || Date.parse(run.startedAt) || Date.now();
  const deterministicValidation = deterministicValidationState(request.toolSummary, request.executionReceipts);
  const textObservedCoding = observedCodingState(request.toolSummary, request.executionReceipts);
  const workspaceMutated = workspaceMutationObserved(stored.workspaceState, request.workspaceState);
  const observedCoding = {
    mutated: textObservedCoding.mutated || workspaceMutated,
    broken: textObservedCoding.broken,
  };
  const missingWorkspaceEvidence = Boolean(stored.codingTaskId && observedCoding.mutated && !request.workspaceState);
  const unresolvedCodingMutation = observedCoding.mutated
    && (observedCoding.broken || deterministicValidation !== 'passed' || missingWorkspaceEvidence);
  const baseInput = RuntimeRunRequestSchema.parse({
    ...stored.input,
    sessionId: request.sessionId,
    toolContext: [
      stored.input.toolContext,
      stored.hostPlan ? `Host orchestration plan:\n${compactHostPlan(stored.hostPlan)}` : '',
      request.toolSummary,
    ].filter(Boolean).join('\n\n'),
  });
  const input = observedCoding.mutated
    ? RuntimeRunRequestSchema.parse({
        ...baseInput,
        hasFiles: true,
        hasCodeChangeIntent: true,
        userRequestedVerification: hostLedRuntimeEnabled()
          ? baseInput.userRequestedVerification
          : baseInput.userRequestedVerification || unresolvedCodingMutation,
        intent: baseInput.intent === 'execute' ? 'execute' : 'mutate',
        confidence: Math.max(baseInput.confidence, 0.9),
      })
    : baseInput;
  const decision = observedCoding.mutated
    ? postflightDecisionForObservedMutation(storedDecision, input)
    : storedDecision;

  let codingTaskState: CodingTaskState | undefined;
  if (stored.codingTaskId) {
    let codingTask = store.getCodingTask(stored.codingTaskId)?.state as CodingTaskState | undefined;
    if (codingTask && observedCoding.mutated && !request.workspaceState) {
      codingTask = updateCodingTask(codingTask.taskId, {
        status: 'blocked',
        unresolvedRisks: [
          ...codingTask.unresolvedRisks,
          'Postflight workspace state was missing after a reported code mutation; reconcile hashes before any further write.',
        ],
      }, store);
    } else if (codingTask && observedCoding.mutated && request.workspaceState) {
      const changedFiles = request.workspaceState.changedFiles.map((file) => file.path);
      const patch = await recordCodexPatch({
        taskId: codingTask.taskId,
        changedFiles,
        allowedFiles: [...new Set([...codingTask.filesInspected, ...codingTask.filesChanged])],
      }, store);
      codingTask = patch.state;
      if (deterministicValidation === 'passed' && codingTask.status === 'active') {
        codingTask = recordCodingValidation(codingTask.taskId, {
          kind: 'targeted_test',
          status: 'passed',
          summary: 'Hermes postflight tool evidence reported deterministic validation passed.',
        }, store);
        if (codingTask.currentPhase === 'patch' || codingTask.currentPhase === 'revise') {
          codingTask = transitionCodingTask(codingTask.taskId, 'targeted_validation', {
            summary: 'Recorded deterministic postflight validation evidence.',
          }, store);
        }
        if (codingTask.currentPhase === 'targeted_validation') {
          codingTask = transitionCodingTask(codingTask.taskId, 'summarize', {
            summary: 'Workspace hashes were reconciled and deterministic validation passed.',
            status: 'completed',
          }, store);
        }
      } else if (codingTask.status === 'active') {
        codingTask = updateCodingTask(codingTask.taskId, {
          unresolvedRisks: [
            ...codingTask.unresolvedRisks,
            missingWorkspaceEvidence
              ? 'Postflight workspace state was missing after a code mutation.'
              : 'Code mutation remains pending deterministic validation.',
          ],
        }, store);
      }
    }
    codingTaskState = codingTask;
  }

  if (cognitiveCapsule) {
    const fallbackEvidenceId = `tool:${hashRequest({
      runId: request.runId,
      toolSummary: request.toolSummary,
      workspaceRevision: request.workspaceState?.dirtyDiffSha256,
    }).slice(0, 24)}`;
    const completed: string[] = [];
    const failures: string[] = [];
    if (deterministicValidation === 'passed') completed.push('Relevant deterministic validation passed in this Host cycle.');
    if (observedCoding.broken) failures.push('This cycle produced broken-code evidence; repair before deployment or completion.');
    if (request.executionReceipts.length) {
      completed.push(`Hermes supplied ${request.executionReceipts.length} structured execution receipt(s).`);
    }
    const receiptEvidence = request.executionReceipts.map((receipt) => ({
      id: receipt.receiptId,
      kind: receipt.kind === 'validation'
        ? 'test' as const
        : receipt.kind === 'workspace'
          ? 'workspace' as const
          : receipt.kind === 'artifact'
            ? 'file' as const
            : 'tool' as const,
      claim: [
        receipt.tool ? `tool=${receipt.tool}` : '',
        receipt.command ? `command=${receipt.command}` : '',
        `status=${receipt.status}`,
        receipt.exitCode !== undefined && receipt.exitCode !== null ? `exit_code=${receipt.exitCode}` : '',
        receipt.summary,
      ].filter(Boolean).join('; ').slice(0, 4_000),
      confidence: receipt.status === 'passed' || receipt.status === 'failed' ? 0.99 : 0.8,
    }));
    const fallbackEvidence = request.executionReceipts.length === 0 && request.toolSummary.trim()
      ? [{
          id: fallbackEvidenceId,
          kind: 'tool' as const,
          claim: request.toolSummary.slice(0, 4_000),
          confidence: deterministicValidation === 'passed' ? 0.8 : 0.6,
        }]
      : [];
    const acceptanceChecks = acceptanceChecksFromEvidence({
      capsule: cognitiveCapsule,
      decision,
      receipts: request.executionReceipts,
      deterministicValidation,
      observedCoding,
      workspaceMutated,
      draft: request.draft,
      failed: request.failed,
    });
    cognitiveCapsule = updateCognitiveTask({
      taskId: cognitiveCapsule.taskId,
      runId: request.runId,
      phase: observedCoding.broken
        ? 'repair'
        : unresolvedCodingMutation
          ? 'validate'
          : request.executionReceipts.length || request.toolSummary.trim()
            ? 'validate'
            : cognitiveCapsule.phase,
      completed,
      failures,
      acceptanceChecks,
      evidence: [...receiptEvidence, ...fallbackEvidence],
      workspaceRevision: request.workspaceState?.dirtyDiffSha256 || cognitiveCapsule.workspaceRevision,
      store,
    });
  }

  const latencyPlan = decision.pipelineMode === storedDecision.pipelineMode
    ? stored.latencyPlan || createLatencyBudgetPlan(decision)
    : createLatencyBudgetPlan(decision);
  const baseBudget = createTokenBudgetPlan(decision, input, {
    userPriority: input.tokenPriority,
    budgetId: rootBudgetId,
  });
  const budget = {
    ...baseBudget,
    host: { ...baseBudget.host, timeoutMs: roleLatencyTimeout(latencyPlan, 'host') },
    worker: { ...baseBudget.worker, timeoutMs: roleLatencyTimeout(latencyPlan, 'worker') },
    verifier: { ...baseBudget.verifier, timeoutMs: roleLatencyTimeout(latencyPlan, 'verifier') },
    boss: { ...baseBudget.boss, timeoutMs: roleLatencyTimeout(latencyPlan, 'boss') },
  };
  const postflightLatency: LatencyObservation[] = [
    ...stored.preflightLatency,
    observeLatency('host', request.hostDurationMs, latencyPlan.hostMs),
  ];
  const calls: RuntimeModelResult[] = [];
  if (stored.hostPlanCall) {
    const parsed = stored.hostPlanCall as RuntimeModelResult;
    if (parsed.role === 'host') calls.push(parsed);
  }
  if (stored.workerCall) {
    const parsed = stored.workerCall as RuntimeModelResult;
    if (parsed.role === 'worker') calls.push(parsed);
  }
  if (stored.bossCall) {
    const parsed = stored.bossCall as RuntimeModelResult;
    if (parsed.role === 'boss') calls.push(parsed);
  }
  const hostGovernor = settleTokenSpend({
    plan: budget,
    requestId: `${request.runId}:hermes-host`,
    role: 'host',
    actualTokens: request.hostUsage.inputTokens
      + request.hostUsage.cacheWriteTokens
      + request.hostUsage.outputTokens,
    attempted: request.hostUsage.calls > 0,
    usageValid: request.hostUsage.valid,
    invalidReason: request.hostUsage.invalidReason,
  });

  recordActivity(
    request.sessionId,
    'host',
    request.failed
      ? `Hermes Host ${request.host.model} failed turn ${request.turnId}.`
      : `Hermes Host ${request.host.model} completed a candidate response.`,
    {
      runId: request.runId,
      turnId: request.turnId,
      model: request.host.model,
      provider: request.host.provider,
      lifecycle: 'model_call',
      callId: `${request.runId}:hermes-host`,
      status: request.failed ? 'failed' : 'completed',
      modelUsage: {
        inputTokens: request.hostUsage.inputTokens,
        cacheReadTokens: request.hostUsage.cacheReadTokens,
        cacheWriteTokens: request.hostUsage.cacheWriteTokens,
        outputTokens: request.hostUsage.outputTokens,
        reasoningTokens: request.hostUsage.reasoningTokens,
        calls: request.hostUsage.calls,
        totalTokens: request.hostUsage.inputTokens
          + request.hostUsage.cacheReadTokens
          + request.hostUsage.cacheWriteTokens
          + request.hostUsage.outputTokens,
        estimated: request.hostUsage.source === 'estimate',
        source: request.hostUsage.source,
        valid: request.hostUsage.valid,
        invalidReason: request.hostUsage.invalidReason,
        providerRequestId: request.hostUsage.providerRequestId,
      },
      latencyMs: request.hostDurationMs,
    },
    request.failed ? 'failed' : 'success',
  );

  if (request.failed) {
    if (cognitiveCapsule) {
      cognitiveCapsule = updateCognitiveTask({
        taskId: cognitiveCapsule.taskId,
        runId: request.runId,
        status: 'failed',
        failures: ['Hermes Host reported a failed internal cycle.'],
        store,
      });
    }
    accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
    recordOutcomePassport({
      runId: request.runId,
      sessionId: request.sessionId,
      request: input.request,
      decision,
      verdict: 'failed',
      transformed: false,
      calls,
      hostUsage: request.hostUsage,
      latencyObservations: [
        ...postflightLatency,
        observeLatency('total', Date.now() - turnStartedAtMs, latencyPlan.totalMs),
      ],
      bossVerdict: stored.bossPreflight?.verdict,
      bossConfidence: stored.bossPreflight?.confidence,
      evidenceCoverage: stored.memoryCoverage,
      memorySource: stored.memorySource,
      hostModel: stored.host.model,
      hostProvider: stored.host.provider,
    });
    store.saveRun({
      ...run,
      status: 'failed',
      result: { ...stored, finalAnswer: request.draft, failed: true, tokenBudget: hostGovernor },
      errors: ['Hermes Host reported a failed turn'],
      completedAt: now(),
    });
    updateRuntimeSession(request.sessionId, { status: 'failed', lastError: 'Hermes Host reported a failed turn', activeRunId: undefined });
    completeTokenBudget(rootBudgetId);
    return {
      ok: false,
      finalAnswer: request.draft,
      transformed: false,
      receipt: {
        pipeline: decision.pipelineMode,
        host: {
          ...request.host,
          invoked: true,
          plannerInvoked: Boolean(stored.hostPlanCall),
          calls: gatewayHostCallCount(calls, request.hostUsage),
        },
        worker: callIdentity(calls.find((call) => call.role === 'worker')),
        verifier: { invoked: false },
        boss: { ...callIdentity(calls.find((call) => call.role === 'boss')), verdict: stored.bossPreflight?.verdict },
        transformed: false,
      } satisfies GatewayTurnReceipt,
    };
  }

  let finalAnswer = request.draft;
  let transformed = false;
  const hostInputTokens = request.hostUsage.inputTokens + request.hostUsage.cacheWriteTokens;
  const hostInputBudget = Math.max(
    24_000,
    Number(process.env.ZENOS_GATEWAY_HOST_INPUT_BUDGET_TOKENS || 96_000),
  );
  const hostOverBudget = hostInputTokens > hostInputBudget;
  const verifierMandatory = input.userRequestedVerification
    || unresolvedCodingMutation
    || decision.risk === 'high'
    || decision.risk === 'critical';
  const verifierMayRewriteHost = verifierMandatory || decision.requiresApproval || request.failed;
  const deterministicPassReplacesOptionalVerifier = deterministicValidation === 'passed'
    && ['coding_change', 'debugging', 'repo_question'].includes(decision.taskType)
    && !verifierMandatory;
  let verifierResult: VerifierResult | undefined;
  let verifierCall: RuntimeModelResult | undefined;
  let bossDecision = stored.bossPreflight;
  let bossCall = calls.find((call) => call.role === 'boss');

  if (
    decision.useVerifier
    && (!hostOverBudget || verifierMandatory)
    && !deterministicPassReplacesOptionalVerifier
  ) {
    const verifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:1`,
      budget,
      mandatory: verifierMandatory,
    });
    verifierResult = verifier.result;
    verifierCall = verifier.call;
    calls.push(verifier.call);
    postflightLatency.push(observeLatency('verifier', verifier.call.latencyMs, latencyPlan.verifierMs));
    recordActivity(
      request.sessionId,
      'verifier',
      verifier.result
        ? `Verifier ${verifier.call.model} returned ${verifier.result.verdict}.`
        : `Verifier ${verifier.call.model || 'unknown'} failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: verifier.call.model,
        provider: verifier.call.provider,
        verdict: verifier.result?.verdict,
        modelUsage: verifier.call.usage,
      },
      verifier.result ? 'success' : 'failed',
    );

    if (verifier.result?.verdict === 'revise' && verifierMayRewriteHost) {
      const fixes = verifier.result.issues.map((issue) => issue.requiredFix || issue.issue).filter(Boolean);
      const revision = await runHostRevision(input, finalAnswer, fixes, stored.workerResult, {
        requestId: `${request.runId}:gateway-host-revision:1`,
        budget,
      });
      calls.push(revision);
      postflightLatency.push(observeLatency('host', revision.latencyMs, latencyPlan.hostMs));
      if (revision.ok && revision.content) {
        finalAnswer = revision.content;
        transformed = finalAnswer !== request.draft;
        recordActivity(
          request.sessionId,
          'host',
          `Runtime Host ${revision.model} revised the Hermes draft from mandatory verifier feedback.`,
          {
            runId: request.runId,
            turnId: request.turnId,
            model: revision.model,
            provider: revision.provider,
            revision: 1,
            modelUsage: revision.usage,
          },
        );
      }
    } else if (verifier.result?.verdict === 'revise') {
      recordActivity(
        request.sessionId,
        'verifier',
        'Optional verifier feedback was recorded as advisory; Hermes Host retained final-answer authority.',
        {
          runId: request.runId,
          turnId: request.turnId,
          verdict: verifier.result.verdict,
          advisoryIssues: verifier.result.issues.length,
        },
        'success',
      );
    } else if (verifier.result?.verdict === 'block') {
      finalAnswer = blockedAnswer(
        verifier.result.issues.map((issue) => issue.issue).join('; ') || 'verifier safety gate failed',
        verifier.result.issues.map((issue) => issue.requiredFix).filter(Boolean),
      );
      transformed = true;
    }
  } else {
    recordActivity(
      request.sessionId,
      'verifier',
      deterministicPassReplacesOptionalVerifier
        ? 'Verifier skipped because deterministic code validation passed and no high-risk review was required.'
        : hostOverBudget && decision.useVerifier
          ? `Verifier skipped because Hermes Host already consumed ${hostInputTokens} input tokens (budget ${hostInputBudget}).`
          : 'Verifier skipped by Host orchestration and safety policy.',
      {
        runId: request.runId,
        turnId: request.turnId,
        hostInputTokens,
        hostInputBudget,
        hostOverBudget,
        deterministicValidation,
      },
      'skipped',
    );
  }

  const shouldRunBoss = decision.requiresApproval
    || verifierResult?.verdict === 'escalate'
    || (decision.useBoss && decision.risk === 'critical' && !input.userRequestedBoss);
  if (shouldRunBoss) {
    const bossMandatory = decision.requiresApproval || verifierResult?.verdict === 'escalate';
    const finalBossCall = await runBossReviewModel({
      stage: 'postflight',
      runId: request.runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      userGoal: input.request,
      decision,
      currentDraft: finalAnswer,
      hostPlan: stored.hostPlan,
      workerResult: stored.workerResult,
      verifierResult,
      toolSummary: request.toolSummary,
      preflightDecision: stored.bossPreflight,
    }, {
      sessionId: request.sessionId,
      modelOverrides: input.modelOverrides,
      requestId: `${request.runId}:gateway-boss-postflight`,
      maxInputTokens: budget.boss.inputTokens,
      maxOutputTokens: budget.boss.outputTokens,
      timeoutMs: roleLatencyTimeout(latencyPlan, 'boss'),
      trigger: verifierResult?.verdict === 'escalate' ? 'verifier_escalation' : 'critical_postflight_authority',
      tokenBudgetPlan: budget,
      mandatory: bossMandatory,
    });
    calls.push(finalBossCall);
    postflightLatency.push(observeLatency('boss', finalBossCall.latencyMs, latencyPlan.bossMs));
    const parsedBoss = safeBossDecision(finalBossCall)
      || (bossMandatory ? mandatoryBossFallback(finalBossCall.error || 'Boss postflight returned no valid decision') : undefined);
    if (parsedBoss) {
      bossDecision = parsedBoss;
      bossCall = finalBossCall;
    }
    recordActivity(
      request.sessionId,
      'boss',
      parsedBoss
        ? `Boss ${finalBossCall.model} returned postflight verdict ${parsedBoss.verdict}.`
        : `Boss ${finalBossCall.model || 'unknown'} postflight failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: finalBossCall.model,
        provider: finalBossCall.provider,
        verdict: parsedBoss?.verdict,
        modelUsage: finalBossCall.usage,
      },
      parsedBoss ? 'success' : 'failed',
    );

    if (parsedBoss?.verdict === 'revise') {
      const revision = await runHostRevision(input, finalAnswer, parsedBoss.requiredChanges, stored.workerResult, {
        requestId: `${request.runId}:gateway-host-boss-revision`,
        budget,
      });
      calls.push(revision);
      postflightLatency.push(observeLatency('host', revision.latencyMs, latencyPlan.hostMs));
      if (revision.ok && revision.content) {
        finalAnswer = revision.content;
        transformed = finalAnswer !== request.draft;
        recordActivity(
          request.sessionId,
          'host',
          `Runtime Host ${revision.model} revised the draft from Boss feedback.`,
          {
            runId: request.runId,
            turnId: request.turnId,
            model: revision.model,
            provider: revision.provider,
            revision: 1,
            modelUsage: revision.usage,
          },
        );
      }
    } else if (parsedBoss?.verdict === 'block') {
      finalAnswer = blockedAnswer(parsedBoss.reasoningSummary, parsedBoss.requiredChanges);
      transformed = true;
    } else if (parsedBoss?.verdict === 'ask_user') {
      finalAnswer = askUserAnswer(parsedBoss.reasoningSummary, parsedBoss.requiredChanges);
      transformed = true;
    } else if (parsedBoss?.verdict === 'delegate') {
      finalAnswer = askUserAnswer(
        'Runtime menilai bukti yang tersedia belum cukup untuk jawaban final.',
        parsedBoss.requiredChanges,
      );
      transformed = true;
    }
  }

  if (
    transformed
    && decision.useVerifier
    && verifierResult?.verdict === 'revise'
    && (decision.risk === 'high' || decision.risk === 'critical')
  ) {
    const finalVerifier = await runVerifier(input, finalAnswer, stored.workerResult, {
      requestId: `${request.runId}:gateway-verifier:final`,
      budget,
      mandatory: decision.risk === 'critical',
    });
    calls.push(finalVerifier.call);
    postflightLatency.push(observeLatency('verifier', finalVerifier.call.latencyMs, latencyPlan.verifierMs));
    if (finalVerifier.result) verifierResult = finalVerifier.result;
    recordActivity(
      request.sessionId,
      'verifier',
      finalVerifier.result
        ? `Final Verifier ${finalVerifier.call.model} returned ${finalVerifier.result.verdict}.`
        : `Final Verifier ${finalVerifier.call.model || 'unknown'} failed.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        model: finalVerifier.call.model,
        provider: finalVerifier.call.provider,
        verdict: finalVerifier.result?.verdict,
        modelUsage: finalVerifier.call.usage,
      },
      finalVerifier.result ? 'success' : 'failed',
    );
    if (finalVerifier.result?.verdict === 'block') {
      finalAnswer = blockedAnswer(
        finalVerifier.result.issues.map((issue) => issue.issue).join('; ') || 'final verification failed',
        finalVerifier.result.issues.map((issue) => issue.requiredFix).filter(Boolean),
      );
      transformed = true;
    }
  }

  const configuredContinuationLimit = Number(process.env.ZENOS_GATEWAY_MAX_AUTO_CONTINUATIONS || 6);
  const maxAutoContinuations = Math.max(
    1,
    Math.min(
      cognitiveCapsule?.maxCycles
        || (Number.isFinite(configuredContinuationLimit) ? configuredContinuationLimit : 6),
      12,
    ),
  );
  const genuineUserBlocker = GENUINE_USER_INPUT_PATTERN.test(request.draft)
    || bossDecision?.verdict === 'ask_user';
  const hostInterrupted = Boolean(cognitiveCapsule)
    && cognitiveCapsule?.status === 'active'
    && hostStoppedBeforeTerminalWork(request.draft, request.toolSummary)
    && !decision.requiresApproval
    && !genuineUserBlocker
    && verifierResult?.verdict !== 'block';
  const acceptancePending = Boolean(cognitiveCapsule)
    && cognitiveCapsule?.status === 'active'
    && !acceptanceCriteriaSatisfied(cognitiveCapsule)
    && !genuineUserBlocker
    && verifierResult?.verdict !== 'block'
    && bossDecision?.verdict !== 'block';
  const continuationReason = unresolvedCodingMutation
    ? 'coding_validation_pending' as const
    : acceptancePending
      ? 'acceptance_pending' as const
      : hostInterrupted
        ? 'host_interrupted' as const
        : undefined;
  const continuationEligible = Boolean(continuationReason)
    && Boolean(cognitiveCapsule)
    && cognitiveCapsule?.status === 'active'
    && (!unresolvedCodingMutation || Boolean(request.workspaceState))
    && !request.failed
    && (cognitiveCapsule?.cycle || 0) < maxAutoContinuations;
  let continuation: {
    required: true;
    continuationId: string;
    leaseToken: string;
    reason: 'coding_validation_pending' | 'acceptance_pending' | 'host_interrupted';
    taskId: string;
    attempt: number;
    maxAttempts: number;
    prompt: string;
  } | undefined;

  if (genuineUserBlocker && cognitiveCapsule) {
    cognitiveCapsule = updateCognitiveTask({
      taskId: cognitiveCapsule.taskId,
      runId: request.runId,
      phase: 'waiting_for_user',
      status: 'waiting_for_user',
      pending: [
        ...cognitiveCapsule.pending,
        `Blocking user input requested by Host: ${request.draft.slice(0, 1_500)}`,
      ],
      store,
    });
  }

  if (continuationEligible && cognitiveCapsule && continuationReason) {
    const continuationSummary = continuationReason === 'coding_validation_pending'
      ? `deterministic validation is ${deterministicValidation}`
      : continuationReason === 'acceptance_pending'
        ? `mandatory acceptance checks remain pending: ${cognitiveCapsule.acceptanceChecks.filter(check => check.required && check.status !== 'passed').map(check => check.criterion).join('; ').slice(0, 2_000)}`
        : 'the Host stopped at a confirmation, context, output, or tool-iteration boundary before the root task completed';
    if (codingTaskState) {
      const nextCodingAttempt = codingTaskState.continuationAttempts + 1;
      codingTaskState = updateCodingTask(codingTaskState.taskId, {
        continuationAttempts: nextCodingAttempt,
        lastContinuationAt: now(),
        unresolvedRisks: [
          ...codingTaskState.unresolvedRisks.filter((risk) => !/pending deterministic validation|did not pass deterministic validation|host stopped before terminal work/i.test(risk)),
          `Automatic continuation ${nextCodingAttempt}/${maxAutoContinuations}: ${continuationSummary}.`,
        ],
      }, store);
    }
    cognitiveCapsule = updateCognitiveTask({
      taskId: cognitiveCapsule.taskId,
      runId: request.runId,
      phase: unresolvedCodingMutation ? (observedCoding.broken ? 'repair' : 'validate') : cognitiveCapsule.phase,
      pending: [
        ...cognitiveCapsule.pending,
        continuationSummary,
        ...(codingTaskState
          ? [
              `Coding phase: ${codingTaskState.currentPhase}`,
              `Changed files: ${codingTaskState.filesChanged.join(', ') || 'reconcile from current Git diff'}`,
            ]
          : []),
      ],
      failures: observedCoding.broken ? ['Broken-code evidence remains unresolved.'] : [],
      workspaceRevision: request.workspaceState?.dirtyDiffSha256 || cognitiveCapsule.workspaceRevision,
      store,
    });
    scheduleCognitiveContinuation({
      capsule: cognitiveCapsule,
      runId: request.runId,
      reason: continuationSummary,
      store,
    });
    const leased = store.claimContinuationForSession(
      request.sessionId,
      30 * 60_000,
      undefined,
      'hermes-gateway-inband',
    );
    if (!leased?.leaseToken) throw new Error('Durable continuation could not be leased to Hermes');
    continuation = {
      required: true,
      continuationId: leased.continuationId,
      leaseToken: leased.leaseToken,
      reason: continuationReason,
      taskId: cognitiveCapsule.taskId,
      attempt: leased.attempt,
      maxAttempts: leased.maxAttempts,
      prompt: leased.prompt,
    };
    finalAnswer = request.draft;
    transformed = false;
    recordActivity(
      request.sessionId,
      'host',
      `Runtime scheduled durable cognitive continuation ${leased.attempt}/${leased.maxAttempts} (${continuationReason}) instead of exposing an incomplete draft.`,
      {
        runId: request.runId,
        turnId: request.turnId,
        taskId: cognitiveCapsule.taskId,
        continuationId: leased.continuationId,
        deterministicValidation,
        brokenCodeEvidence: observedCoding.broken,
        continuationReason,
        continuationAttempt: leased.attempt,
      },
      'success',
    );
  }

  const terminalCodingFailure = unresolvedCodingMutation && !continuation;
  const terminalAcceptanceFailure = acceptancePending && !continuation;
  const terminalAutonomyFailure = hostInterrupted && !continuation;
  if (terminalCodingFailure) {
    finalAnswer = blockedAnswer(
      observedCoding.broken
        ? 'Hermes mengubah source code, tetapi bukti tool menunjukkan file berada dalam kondisi rusak atau validasi gagal.'
        : 'Hermes mengubah source code, tetapi tidak ada bukti deterministic validation yang lulus.',
      [
        continuationEligible
          ? 'Automatic continuation could not be scheduled safely; reconcile the durable task state before retrying.'
          : `Perbaiki atau rollback perubahan sampai syntax, typecheck, lint, atau targeted test yang relevan lulus. Automatic continuation limit: ${maxAutoContinuations}.`,
        'Jangan restart, deploy, atau menandai pekerjaan selesai saat working tree masih broken atau belum tervalidasi.',
      ],
    );
    transformed = true;
    recordActivity(
      request.sessionId,
      'verifier',
      'Runtime failed closed because a code mutation did not pass deterministic validation and no safe automatic continuation remained.',
      {
        runId: request.runId,
        turnId: request.turnId,
        deterministicValidation,
        brokenCodeEvidence: observedCoding.broken,
        continuationAttempts: codingTaskState?.continuationAttempts || 0,
        maxAutoContinuations,
      },
      'failed',
    );
  } else if (terminalAcceptanceFailure || terminalAutonomyFailure) {
    finalAnswer = blockedAnswer(
      terminalAcceptanceFailure
        ? 'Mandatory acceptance criteria belum memiliki bukti terstruktur yang cukup, dan batas automatic continuation sudah habis.'
        : 'Hermes berhenti pada batas internal sebelum acceptance criteria selesai, dan batas automatic continuation sudah habis.',
      [
        'Tidak perlu membalas “gas” atau “lanjut”. Runtime harus membuka run baru hanya setelah state task direkonsiliasi.',
        `Automatic continuation limit: ${maxAutoContinuations}.`,
      ],
    );
    transformed = true;
    recordActivity(
      request.sessionId,
      'host',
      terminalAcceptanceFailure
        ? 'Runtime failed closed because mandatory acceptance checks remained unresolved after the continuation budget ended.'
        : 'Runtime failed closed after the Host repeatedly stopped at an internal confirmation/tool-limit boundary.',
      {
        runId: request.runId,
        turnId: request.turnId,
        continuationAttempts: codingTaskState?.continuationAttempts || 0,
        maxAutoContinuations,
      },
      'failed',
    );
  }

  const terminalFailure = terminalCodingFailure || terminalAcceptanceFailure || terminalAutonomyFailure;

  if (cognitiveCapsule) {
    if (terminalFailure || bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block') {
      cognitiveCapsule = updateCognitiveTask({
        taskId: cognitiveCapsule.taskId,
        runId: request.runId,
        phase: observedCoding.broken ? 'repair' : cognitiveCapsule.phase,
        status: 'failed',
        failures: [
          terminalCodingFailure
            ? 'Code mutation did not pass deterministic validation before the continuation budget ended.'
            : terminalAcceptanceFailure
              ? 'Mandatory acceptance checks remained unresolved until the continuation budget ended.'
              : terminalAutonomyFailure
                ? 'Host repeatedly stopped at an internal boundary until the continuation budget ended.'
              : bossDecision?.verdict === 'block'
                ? `Boss blocked completion: ${bossDecision.reasoningSummary}`
                : 'Verifier blocked completion.',
        ],
        store,
      });
    } else if (!continuation && !genuineUserBlocker) {
      cognitiveCapsule = updateCognitiveTask({
        taskId: cognitiveCapsule.taskId,
        runId: request.runId,
        phase: 'complete',
        status: 'completed',
        completed: ['Host delivered the terminal response for the root task.'],
        pending: [],
        store,
      });
    }
  }

  const receipt: GatewayTurnReceipt = {
    pipeline: decision.pipelineMode,
    host: {
      ...request.host,
      invoked: true,
      plannerInvoked: Boolean(stored.hostPlanCall),
      calls: gatewayHostCallCount(calls, request.hostUsage),
    },
    worker: callIdentity(calls.find((call) => call.role === 'worker')),
    verifier: {
      ...callIdentity(verifierCall || [...calls].reverse().find((call) => call.role === 'verifier')),
      verdict: verifierResult?.verdict,
    },
    boss: {
      ...callIdentity(bossCall || [...calls].reverse().find((call) => call.role === 'boss')),
      verdict: bossDecision?.verdict,
    },
    transformed,
  };

  const finalTokenBudget = tokenGovernorSnapshot(budget);
  store.saveRun({
    ...run,
    decision,
    status: terminalFailure
      ? 'failed'
      : bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block'
        ? 'blocked'
        : 'done',
    result: {
      preflight: stored,
      finalAnswer,
      verifierResult,
      bossDecision,
      receipt,
      modelCalls: calls,
      tokenBudget: finalTokenBudget,
      executionReceipts: request.executionReceipts,
      acceptanceChecks: cognitiveCapsule?.acceptanceChecks,
      codingValidation: observedCoding.mutated
        ? { deterministic: deterministicValidation, broken: observedCoding.broken }
        : undefined,
      continuation,
      cognitiveCapsule,
    },
    errors: terminalCodingFailure
      ? ['Code mutation did not pass deterministic validation']
      : terminalAcceptanceFailure
        ? ['Mandatory acceptance checks remained unresolved']
        : terminalAutonomyFailure
          ? ['Host stopped before terminal work and automatic continuation was exhausted']
          : [],
    completedAt: now(),
  });
  accountGatewayModelUsage(request.sessionId, calls, request.hostUsage);
  const outcomeVerdict = terminalFailure
    ? 'failed'
    : bossDecision?.verdict === 'block' || verifierResult?.verdict === 'block'
      ? 'blocked'
      : continuation || transformed || verifierResult?.verdict === 'revise' || bossDecision?.verdict === 'revise'
        ? 'revised'
        : 'success';
  recordOutcomePassport({
    runId: request.runId,
    sessionId: request.sessionId,
    request: input.request,
    decision,
    verdict: outcomeVerdict,
    transformed,
    calls,
    hostUsage: request.hostUsage,
    latencyObservations: [
      ...postflightLatency,
      observeLatency('total', Date.now() - turnStartedAtMs, latencyPlan.totalMs),
    ],
    verifierVerdict: verifierResult?.verdict,
    verifierConfidence: verifierResult?.confidence,
    bossVerdict: bossDecision?.verdict,
    bossConfidence: bossDecision?.confidence,
    evidenceCoverage: stored.memoryCoverage,
    memorySource: stored.memorySource,
    hostModel: stored.host.model,
    hostProvider: stored.host.provider,
  });

  // Learning is deliberately off the response critical path. Runtime stores
  // the local task/capsule synchronously, then sends only a bounded validated
  // outcome to cloud Memory so future low-tier Hosts can reuse procedures and
  // avoid known failed attempts.
  void persistCognitiveOutcome({
    runId: request.runId,
    sessionId: request.sessionId,
    objective: input.request,
    taskType: decision.taskType,
    verdict: outcomeVerdict,
    phase: cognitiveCapsule?.phase,
    model: stored.host.model,
    provider: stored.host.provider,
    toolSummary: request.toolSummary,
    deterministicValidation,
    decisions: cognitiveCapsule?.decisions,
    failures: cognitiveCapsule?.failures,
    artifacts: [
      ...(cognitiveCapsule?.artifacts || []).map((artifact) => artifact.path || artifact.id),
      ...(request.workspaceState?.changedFiles || []).map((file) => file.path),
    ],
    tokenUsage: {
      input: request.hostUsage.inputTokens + request.hostUsage.cacheWriteTokens,
      output: request.hostUsage.outputTokens,
      calls: request.hostUsage.calls,
    },
  }).catch(() => undefined);

  if (!continuation && stored.memoryEvidenceRefs.length) {
    const feedbackOutcome = outcomeVerdict === 'success'
      ? 'helpful' as const
      : outcomeVerdict === 'failed' || outcomeVerdict === 'blocked'
        ? 'not_helpful' as const
        : 'unused' as const;
    void persistRecallFeedback({
      runId: request.runId,
      sessionId: request.sessionId,
      outcome: feedbackOutcome,
      evidenceRefs: stored.memoryEvidenceRefs,
    }).catch(() => undefined);
  }

  if (terminalFailure) {
    updateRuntimeSession(request.sessionId, {
      status: 'failed',
      finalAnswer,
      lastError: terminalCodingFailure
        ? 'Code mutation did not pass deterministic validation'
        : terminalAcceptanceFailure
          ? 'Mandatory acceptance checks remained unresolved'
          : 'Host stopped before terminal work and automatic continuation was exhausted',
      activeRunId: undefined,
    });
  } else if (continuation) {
    updateRuntimeSession(request.sessionId, {
      status: 'working',
      finalAnswer: undefined,
      lastError: undefined,
      activeRunId: undefined,
      metadata: {
        continuationRequired: true,
        continuationId: continuation.continuationId,
        continuationTaskId: continuation.taskId,
        continuationAttempt: continuation.attempt,
        continuationMaxAttempts: continuation.maxAttempts,
      },
    });
  } else if (genuineUserBlocker) {
    updateRuntimeSession(request.sessionId, {
      status: 'paused',
      finalAnswer,
      lastError: undefined,
      activeRunId: undefined,
      metadata: {
        waitingForUser: true,
        cognitiveTaskId: cognitiveCapsule?.taskId,
      },
    });
  } else {
    completeRuntimeSession(request.sessionId, finalAnswer);
  }
  if (!continuation) completeTokenBudget(rootBudgetId);

  return {
    ok: !terminalFailure,
    failed: terminalFailure,
    finalAnswer,
    transformed,
    receipt,
    verifier: verifierResult,
    boss: bossDecision,
    tokenBudget: finalTokenBudget,
    continuation,
    cognitiveTaskId: cognitiveCapsule?.taskId,
    cognitivePhase: cognitiveCapsule?.phase,
  };
}
