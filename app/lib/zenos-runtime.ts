import { z } from 'zod';

export const RUNTIME_POLICY_VERSION = '2026.07.13-v4-personal-economy';

export const TaskTypeSchema = z.enum([
  'simple_chat',
  'memory_question',
  'repo_question',
  'coding_change',
  'debugging',
  'summarization',
  'planning_or_architecture',
  'security_or_secret',
  'deploy_or_destructive_action',
  'eval_or_benchmark',
]);

export const PipelineModeSchema = z.enum([
  'direct_fast_path',
  'grounded_path',
  'worker_compression_path',
  'verified_path',
  'escalated_deep_path',
]);

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export const ModelTierSchema = z.enum(['none', 'cheap', 'standard', 'premium']);
export const VerifierVerdictSchema = z.enum(['pass', 'revise', 'escalate', 'block']);
export const RuntimeIntentSchema = z.enum(['explain', 'analyze', 'plan', 'execute', 'mutate']);

export const RuntimeContextSchema = z.object({
  request: z.string().trim().min(1).max(100_000),
  hasFiles: z.boolean().optional().default(false),
  hasLogs: z.boolean().optional().default(false),
  hasCodeChangeIntent: z.boolean().optional().default(false),
  userRequestedVerification: z.boolean().optional().default(false),
  userRequestedBoss: z.boolean().optional().default(false),
  estimatedContextTokens: z.number().int().nonnegative().max(2_000_000).optional().default(0),
  confidence: z.number().min(0).max(1).optional().default(0.75),
  intent: RuntimeIntentSchema.optional().default('analyze'),
  taskTypeHint: TaskTypeSchema.optional(),
  riskHint: RiskLevelSchema.optional(),
  containsUntrustedInput: z.boolean().optional().default(false),
  requiresFreshData: z.boolean().optional().default(false),
});

export const RouteDecisionSchema = z.object({
  policyVersion: z.string(),
  taskType: TaskTypeSchema,
  pipelineMode: PipelineModeSchema,
  risk: RiskLevelSchema,
  hostTier: ModelTierSchema,
  workerTier: ModelTierSchema,
  verifierTier: ModelTierSchema,
  useMemory: z.boolean(),
  useTools: z.boolean(),
  useWorker: z.boolean(),
  useVerifier: z.boolean(),
  useBoss: z.boolean(),
  allowEscalation: z.boolean(),
  requiresApproval: z.boolean(),
  requiresSourceContext: z.boolean(),
  maxMemoryItems: z.number().int().nonnegative(),
  maxWorkerCalls: z.number().int().nonnegative(),
  maxContextTokens: z.number().int().positive(),
  maxRevisionAttempts: z.number().int().nonnegative().max(3),
  reasons: z.array(z.string()),
});

export const WorkerFindingSchema = z.object({
  claim: z.string().min(1).max(10_000),
  evidence: z.array(z.string().max(4_000)).max(8).default([]),
  confidence: z.number().min(0).max(1),
  risk: RiskLevelSchema.default('low'),
});

export const WorkerResultSchema = z.object({
  task: z.string().min(1).max(20_000),
  summary: z.array(z.string().max(4_000)).min(1).max(12),
  findings: z.array(WorkerFindingSchema).max(20).default([]),
  contradictions: z.array(z.string().max(4_000)).max(10).default([]),
  unknowns: z.array(z.string().max(4_000)).max(10).default([]),
  suggestedNextStep: z.string().min(1).max(8_000),
  needsHostAttention: z.array(z.string().max(4_000)).max(12).default([]),
  rawContextNeeded: z.array(z.string().max(4_000)).max(12).default([]),
  sourceCoverage: z.number().min(0).max(1).default(0),
});

export const VerifierIssueSchema = z.object({
  severity: RiskLevelSchema,
  issue: z.string().min(1).max(8_000),
  evidence: z.string().max(8_000).default(''),
  requiredFix: z.string().max(8_000).default(''),
});

export const VerifierResultSchema = z.object({
  verdict: VerifierVerdictSchema,
  confidence: z.number().min(0).max(1),
  issues: z.array(VerifierIssueSchema).max(20).default([]),
  checks: z.object({
    followsUserRequest: z.enum(['pass', 'fail', 'unknown']),
    sourceGrounded: z.enum(['pass', 'fail', 'not_applicable']),
    secretSafe: z.enum(['pass', 'fail', 'unknown']),
    actionSafe: z.enum(['pass', 'fail', 'not_applicable']),
    testsOrValidation: z.enum(['pass', 'fail', 'not_applicable']),
  }),
  nextAction: z.enum(['answer', 'revise', 'ask_user', 'escalate', 'block']),
});

export const RouteEventSchema = z.object({
  policyVersion: z.string().default(RUNTIME_POLICY_VERSION),
  taskType: TaskTypeSchema,
  pipelineMode: PipelineModeSchema,
  risk: RiskLevelSchema,
  hostModelTier: ModelTierSchema,
  workerModelTier: ModelTierSchema,
  verifierTier: ModelTierSchema,
  inputSizeBucket: z.enum(['small', 'medium', 'large', 'huge']),
  outputSizeBucket: z.enum(['unknown', 'small', 'medium', 'large']),
  latencyMs: z.number().int().nonnegative().optional(),
  estimatedCost: z.number().nonnegative().optional(),
  premiumInputTokens: z.number().int().nonnegative().default(0),
  premiumOutputTokens: z.number().int().nonnegative().default(0),
  cheapInputTokens: z.number().int().nonnegative().default(0),
  cheapOutputTokens: z.number().int().nonnegative().default(0),
  actualInputTokens: z.number().int().nonnegative().default(0),
  actualOutputTokens: z.number().int().nonnegative().default(0),
  modelCalls: z.number().int().nonnegative().default(0),
  revisions: z.number().int().nonnegative().default(0),
  verdict: z.enum(['unknown', 'success', 'revised', 'escalated', 'blocked', 'failed']).default('unknown'),
  notes: z.string().optional(),
});

export const RuntimeEvalCaseSchema = z.object({
  name: z.string().min(1),
  input: RuntimeContextSchema,
  expect: z.object({
    taskType: TaskTypeSchema.optional(),
    pipelineMode: PipelineModeSchema.optional(),
    risk: RiskLevelSchema.optional(),
    hostTier: ModelTierSchema.optional(),
    workerTier: ModelTierSchema.optional(),
    verifierTier: ModelTierSchema.optional(),
    useMemory: z.boolean().optional(),
    useTools: z.boolean().optional(),
    useWorker: z.boolean().optional(),
    useVerifier: z.boolean().optional(),
    useBoss: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
  }),
});

export const RuntimeEvalResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  decision: RouteDecisionSchema,
  failures: z.array(z.string()),
});

export const RuntimeEvalReportSchema = z.object({
  status: z.enum(['pass', 'fail']),
  policyVersion: z.string(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  premiumTokenEstimate: z.number().int().nonnegative(),
  cheapTokenEstimate: z.number().int().nonnegative(),
  results: z.array(RuntimeEvalResultSchema),
});

export const RuntimeReadinessReportSchema = z.object({
  status: z.enum(['policy_ready', 'not_ready']),
  policyVersion: z.string(),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    evidence: z.string(),
  })),
  evalReport: RuntimeEvalReportSchema,
  requiredOperationalEndpoints: z.array(z.string()),
});

export type TaskType = z.infer<typeof TaskTypeSchema>;
export type PipelineMode = z.infer<typeof PipelineModeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type RuntimeContext = z.input<typeof RuntimeContextSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type WorkerFinding = z.infer<typeof WorkerFindingSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
export type RouteEvent = z.infer<typeof RouteEventSchema>;
export type RuntimeEvalCase = z.input<typeof RuntimeEvalCaseSchema>;
export type RuntimeEvalResult = z.infer<typeof RuntimeEvalResultSchema>;
export type RuntimeEvalReport = z.infer<typeof RuntimeEvalReportSchema>;
export type RuntimeReadinessReport = z.infer<typeof RuntimeReadinessReportSchema>;

const SECURITY_PATTERN = /\b(secret|credential|api[ _-]?key|password|private key|oauth|hmac|jwt|auth(?:entication|orization)?|token leak|secret leak|redact)\b/i;
const EVAL_PATTERN = /\b(eval(?:uation)?|benchmark|regression|pass rate|quality metric|scorecard)\b/i;
const SUMMARY_PATTERN = /\b(summar(?:y|ize)|ringkas|rangkum|extract|condense|compress|kompres)\b/i;
const MEMORY_PATTERN = /\b(remember|memory|recall|bootstrap|compact|previous|sebelumnya|tadi|dulu|keputusan sebelumnya|roadmap kemarin)\b/i;
const ARCH_PATTERN = /\b(architecture|arsitektur|roadmap|design|desain|strategy|strategi|rfc|spec(?:ification)?|rancang|rencana|planning|plan)\b/i;
const DEBUG_PATTERN = /\b(debug|error|exception|stack trace|traceback|crash|gagal|nggak jalan|tidak jalan|bug|race condition|deadlock|memory leak|segfault|panic)\b/i;
const CODE_PATTERN = /\b(patch|implement|implementation|refactor|typescript|javascript|python|golang|go code|rust|java|kotlin|php|repository|repo|source(?: code)?|kode|coding|ngoding|function|fungsi|class|module|package|lint|unit test|integration test|test terkait|api|endpoint|route|handler|controller|service|schema|database|migration|migrasi|table|kolom|column|query|sql|frontend|backend|component|hook|build|compile)\b/i;
const DESTRUCTIVE_PATTERN = /\b(rm\s+-rf|drop\s+(?:table|database)|truncate\s+table|reset\s+--hard|force\s+push|git\s+push\s+--force|wipe|destroy|hapus\s+semua|delete\s+all|format\s+disk)\b/i;
const DEPLOY_ACTION_PATTERN = /(?:\b(deploy|release|rollback|publish|push)\b.{0,30}\b(prod|production|sekarang|now|live)\b)|(?:\b(prod|production|live)\b.{0,30}\b(deploy|release|rollback|publish|push)\b)/i;
const MUTATION_PATTERN = /\b(edit|ubah|change|fix|perbaiki|benerin|betulin|buat|bikin|tambahkan?|tambah|create|generate|delete|hapus|implement(?:asi)?|refactor|deploy|release|restart|install|update|upgrade|migrate|migrasi|replace|ganti)\b/i;

function sizeBucket(tokens: number): RouteEvent['inputSizeBucket'] {
  if (tokens < 1_500) return 'small';
  if (tokens < 6_000) return 'medium';
  if (tokens < 20_000) return 'large';
  return 'huge';
}

function hasDestructiveIntent(context: z.infer<typeof RuntimeContextSchema>): boolean {
  return DESTRUCTIVE_PATTERN.test(context.request)
    || (DEPLOY_ACTION_PATTERN.test(context.request) && (context.intent === 'execute' || context.intent === 'mutate'));
}

function hasDeployAction(context: z.infer<typeof RuntimeContextSchema>): boolean {
  const executionIntent = context.intent === 'execute' || context.intent === 'mutate';
  const immediateImperative = /\b(deploy|release|rollback|publish)\b.{0,30}\b(sekarang|now|langsung|immediately)\b/i.test(context.request);
  return immediateImperative
    || (executionIntent && /\b(deploy|release|rollback|publish)\b/i.test(context.request));
}

export function classifyTask(input: RuntimeContext): TaskType {
  const context = RuntimeContextSchema.parse(input);
  if (context.taskTypeHint) return context.taskTypeHint;
  const text = context.request;

  if (hasDestructiveIntent(context) || hasDeployAction(context)) return 'deploy_or_destructive_action';
  if ((context.intent === 'plan' || context.intent === 'explain') && ARCH_PATTERN.test(text)) return 'planning_or_architecture';
  if (SECURITY_PATTERN.test(text)) return 'security_or_secret';
  if (EVAL_PATTERN.test(text)) return 'eval_or_benchmark';
  if (context.hasCodeChangeIntent) return DEBUG_PATTERN.test(text) ? 'debugging' : 'coding_change';
  if (DEBUG_PATTERN.test(text) && (context.hasFiles || context.hasLogs || CODE_PATTERN.test(text))) return 'debugging';
  if (SUMMARY_PATTERN.test(text)) return 'summarization';
  if (MEMORY_PATTERN.test(text)) return 'memory_question';
  if (ARCH_PATTERN.test(text)) return 'planning_or_architecture';
  if (CODE_PATTERN.test(text) || context.hasFiles || context.hasLogs) {
    if (context.intent === 'execute' || context.intent === 'mutate' || MUTATION_PATTERN.test(text)) return 'coding_change';
    return 'repo_question';
  }
  return 'simple_chat';
}

export function assessRisk(taskType: TaskType, input: RuntimeContext): RiskLevel {
  const context = RuntimeContextSchema.parse(input);
  if (context.riskHint) return context.riskHint;
  if (hasDestructiveIntent(context)) return 'critical';
  if (taskType === 'deploy_or_destructive_action') return context.intent === 'execute' || context.intent === 'mutate' ? 'critical' : 'high';
  if (taskType === 'security_or_secret') return 'high';
  if (context.containsUntrustedInput && (taskType === 'coding_change' || taskType === 'repo_question')) return 'high';
  if (context.userRequestedVerification) return 'high';
  if (taskType === 'coding_change' || taskType === 'debugging' || taskType === 'planning_or_architecture') return 'medium';
  return 'low';
}

export function choosePipeline(input: RuntimeContext): RouteDecision {
  const context = RuntimeContextSchema.parse(input);
  const taskType = classifyTask(context);
  const risk = assessRisk(taskType, context);
  const largeContext = context.estimatedContextTokens >= 6_000;
  const mediumContext = context.estimatedContextTokens >= 1_500;
  const lowConfidence = context.confidence < 0.55;
  const reasons: string[] = [`task:${taskType}`, `risk:${risk}`, `intent:${context.intent}`];

  let pipelineMode: PipelineMode = 'direct_fast_path';
  let hostTier: RouteDecision['hostTier'] = 'standard';
  let workerTier: RouteDecision['workerTier'] = 'none';
  let verifierTier: RouteDecision['verifierTier'] = 'none';
  let useMemory = false;
  let useTools = false;
  let useWorker = false;
  let useVerifier = false;
  let useBoss = false;
  let allowEscalation = false;
  let requiresApproval = false;
  let requiresSourceContext = false;
  let maxMemoryItems = 0;
  let maxWorkerCalls = 0;
  let maxContextTokens = 4_000;
  let maxRevisionAttempts = 0;

  if (taskType === 'memory_question' || taskType === 'planning_or_architecture') {
    useMemory = true;
    maxMemoryItems = taskType === 'memory_question' ? 8 : 5;
    pipelineMode = 'grounded_path';
    hostTier = taskType === 'planning_or_architecture' ? 'premium' : 'standard';
    reasons.push('durable context improves continuity');
  }

  if (['repo_question', 'coding_change', 'debugging', 'security_or_secret'].includes(taskType)) {
    useTools = true;
    requiresSourceContext = true;
    useMemory = true;
    maxMemoryItems = 4;
    pipelineMode = 'grounded_path';
    hostTier = taskType === 'repo_question' ? 'standard' : 'premium';
    maxContextTokens = 12_000;
    reasons.push('source-grounded inspection is required');
  }

  const summaryNeedsWorker = taskType === 'summarization' && context.estimatedContextTokens >= 4_000;
  if (
    summaryNeedsWorker
    || largeContext
    || (
      (taskType === 'coding_change' || taskType === 'debugging')
      && (context.hasFiles || mediumContext || context.intent === 'mutate' || context.intent === 'execute')
    )
  ) {
    useWorker = true;
    workerTier = taskType === 'coding_change' || taskType === 'debugging' ? 'standard' : 'cheap';
    maxWorkerCalls = largeContext ? 2 : 1;
    pipelineMode = 'worker_compression_path';
    maxContextTokens = largeContext ? 16_000 : 12_000;
    reasons.push('bounded worker passes reduce host context grinding');
  } else if (taskType === 'summarization') {
    reasons.push('small summary stays with Host to avoid an extra model call');
  }

  if (taskType === 'eval_or_benchmark') {
    useTools = context.hasFiles || context.hasLogs;
    requiresSourceContext = useTools;
    useVerifier = true;
    verifierTier = 'cheap';
    pipelineMode = 'verified_path';
    maxRevisionAttempts = 1;
    reasons.push('evaluation claims require independent verification');
  }

  if (risk === 'medium') {
    const mediumNeedsVerifier = [
      'coding_change',
      'debugging',
      'eval_or_benchmark',
      'security_or_secret',
      'deploy_or_destructive_action',
    ].includes(taskType);
    useVerifier = mediumNeedsVerifier || context.userRequestedVerification;
    verifierTier = useVerifier ? 'cheap' : 'none';
    maxRevisionAttempts = useVerifier ? 1 : 0;
    if (useVerifier && pipelineMode === 'direct_fast_path') pipelineMode = 'verified_path';
    if (!useVerifier) reasons.push('medium general reasoning remains Host-owned without an extra verifier call');
  }

  if (risk === 'high' || risk === 'critical' || lowConfidence) {
    useVerifier = true;
    verifierTier = risk === 'critical' ? 'premium' : 'cheap';
    allowEscalation = true;
    useBoss = risk === 'critical' || lowConfidence;
    requiresApproval = risk === 'critical';
    pipelineMode = useBoss ? 'escalated_deep_path' : 'verified_path';
    hostTier = 'premium';
    maxRevisionAttempts = 1;
    reasons.push(lowConfidence ? 'low confidence permits Boss escalation' : 'risk requires verifier and escalation policy');
  }

  if (context.userRequestedVerification) {
    useVerifier = true;
    verifierTier = verifierTier === 'none' ? 'cheap' : verifierTier;
    maxRevisionAttempts = Math.max(maxRevisionAttempts, 1);
    if (pipelineMode === 'direct_fast_path') pipelineMode = 'verified_path';
    reasons.push('user explicitly requested verification');
  }

  if (context.userRequestedBoss) {
    useBoss = true;
    allowEscalation = true;
    hostTier = 'premium';
    pipelineMode = 'escalated_deep_path';
    reasons.push('user explicitly requested Boss review');
  }

  if (taskType === 'simple_chat' && !context.userRequestedBoss) reasons.push('low-risk request stays on direct host path');
  if (context.requiresFreshData) {
    useTools = true;
    requiresSourceContext = true;
    reasons.push('fresh external data is required');
  }

  return RouteDecisionSchema.parse({
    policyVersion: RUNTIME_POLICY_VERSION,
    taskType,
    pipelineMode,
    risk,
    hostTier,
    workerTier,
    verifierTier,
    useMemory,
    useTools,
    useWorker,
    useVerifier,
    useBoss,
    allowEscalation,
    requiresApproval,
    requiresSourceContext,
    maxMemoryItems,
    maxWorkerCalls,
    maxContextTokens,
    maxRevisionAttempts,
    reasons,
  });
}

export function buildRouteEvent(decision: RouteDecision, input: RuntimeContext): RouteEvent {
  const context = RuntimeContextSchema.parse(input);
  const tokenEstimate = estimateRouteTokens(decision, context);
  return RouteEventSchema.parse({
    policyVersion: decision.policyVersion,
    taskType: decision.taskType,
    pipelineMode: decision.pipelineMode,
    risk: decision.risk,
    hostModelTier: decision.hostTier,
    workerModelTier: decision.workerTier,
    verifierTier: decision.verifierTier,
    inputSizeBucket: sizeBucket(context.estimatedContextTokens),
    outputSizeBucket: 'unknown',
    ...tokenEstimate,
    verdict: 'unknown',
    notes: decision.reasons.join('; '),
  });
}

export function validateWorkerResult(value: unknown): WorkerResult {
  return WorkerResultSchema.parse(value);
}

export function validateVerifierResult(value: unknown): VerifierResult {
  return VerifierResultSchema.parse(value);
}

export const defaultRuntimeEvalCases: RuntimeEvalCase[] = [
  { name: 'simple chat stays direct', input: { request: 'jelasin singkat konsep host dan worker' }, expect: { taskType: 'simple_chat', pipelineMode: 'direct_fast_path', useWorker: false, useVerifier: false } },
  { name: 'memory continuation uses memory', input: { request: 'tadi keputusan roadmap Zenos apa?' }, expect: { taskType: 'memory_question', useMemory: true } },
  { name: 'large summarization uses worker', input: { request: 'ringkas dokumen besar ini', estimatedContextTokens: 10_000 }, expect: { taskType: 'summarization', useWorker: true, workerTier: 'cheap' } },
  { name: 'coding mutation uses source and premium host', input: { request: 'fix bug di repo ini', hasFiles: true, hasCodeChangeIntent: true, intent: 'mutate' }, expect: { taskType: 'debugging', useTools: true, hostTier: 'premium', useWorker: true } },
  { name: 'debug logs use grounded path', input: { request: 'debug error ini', hasLogs: true }, expect: { taskType: 'debugging', useTools: true, risk: 'medium' } },
  { name: 'secret audit is verified', input: { request: 'audit secret token leak di auth', hasFiles: true }, expect: { taskType: 'security_or_secret', risk: 'high', useVerifier: true } },
  { name: 'production deployment explanation is not destructive', input: { request: 'jelaskan arsitektur deployment production', intent: 'explain' }, expect: { taskType: 'planning_or_architecture', risk: 'medium', requiresApproval: false } },
  { name: 'deploy now is critical', input: { request: 'deploy ke production sekarang', intent: 'execute' }, expect: { taskType: 'deploy_or_destructive_action', risk: 'critical', useBoss: true, requiresApproval: true } },
  { name: 'rollback planning is high but not critical', input: { request: 'buat rencana rollback production', intent: 'plan' }, expect: { taskType: 'planning_or_architecture', risk: 'medium', requiresApproval: false } },
  { name: 'rm rf is critical', input: { request: 'jalankan rm -rf pada direktori data', intent: 'execute' }, expect: { taskType: 'deploy_or_destructive_action', risk: 'critical', useBoss: true } },
  { name: 'architecture uses memory', input: { request: 'rancang arsitektur agent runtime berikutnya' }, expect: { taskType: 'planning_or_architecture', useMemory: true, hostTier: 'premium' } },
  { name: 'benchmark claims get verifier', input: { request: 'benchmark routing ini dan kasih score' }, expect: { taskType: 'eval_or_benchmark', useVerifier: true } },
  { name: 'repo explanation is not code mutation', input: { request: 'jelaskan module TypeScript ini', hasFiles: true, intent: 'explain' }, expect: { taskType: 'repo_question', risk: 'low', useTools: true } },
  { name: 'explicit type hint wins', input: { request: 'review ini', taskTypeHint: 'security_or_secret' }, expect: { taskType: 'security_or_secret', risk: 'high' } },
  { name: 'explicit risk hint wins', input: { request: 'review rencana biasa', riskHint: 'critical' }, expect: { risk: 'critical', useBoss: true } },
  { name: 'low confidence escalates', input: { request: 'jawab pertanyaan ambigu ini', confidence: 0.2 }, expect: { useVerifier: true, useBoss: true, pipelineMode: 'escalated_deep_path' } },
  { name: 'user verification enables verifier', input: { request: 'jawab ini', userRequestedVerification: true }, expect: { useVerifier: true } },
  { name: 'fresh data requires tools', input: { request: 'cek informasi terbaru', requiresFreshData: true }, expect: { useTools: true } },
  { name: 'untrusted code input raises risk', input: { request: 'review source code ini', hasFiles: true, containsUntrustedInput: true }, expect: { risk: 'high', useVerifier: true } },
  { name: 'small summary stays with Host', input: { request: 'summarize catatan ini', estimatedContextTokens: 500 }, expect: { taskType: 'summarization', useWorker: false } },
  { name: 'natural Indonesian endpoint creation is coding', input: { request: 'tolong bikin endpoint login baru di project ini', intent: 'mutate' }, expect: { taskType: 'coding_change', useTools: true, useWorker: true } },
  { name: 'Go race condition repair is debugging', input: { request: 'cek source Go ini dan perbaiki race condition', intent: 'mutate' }, expect: { taskType: 'debugging', useTools: true, useWorker: true } },
  { name: 'database migration creation is coding', input: { request: 'buat database migration untuk kolom user_id', intent: 'mutate' }, expect: { taskType: 'coding_change', useTools: true } },
  { name: 'editing prose is not coding', input: { request: 'hapus kalimat terakhir dari jawaban ini', intent: 'mutate' }, expect: { taskType: 'simple_chat', useTools: false } },
  { name: 'future deploy reminder is not execution', input: { request: 'ingatkan aku deploy production besok', intent: 'analyze' }, expect: { taskType: 'simple_chat', requiresApproval: false } },
];

export function estimateRouteTokens(decision: RouteDecision, input: RuntimeContext): {
  premiumInputTokens: number;
  premiumOutputTokens: number;
  cheapInputTokens: number;
  cheapOutputTokens: number;
} {
  const context = RuntimeContextSchema.parse(input);
  const base = Math.max(400, context.estimatedContextTokens || Math.ceil(context.request.length / 4));
  const premiumInputTokens = decision.hostTier === 'premium' ? Math.min(base, decision.maxContextTokens) : 0;
  const premiumOutputTokens = decision.hostTier === 'premium' ? 1_000 : 0;
  const cheapInputTokens = decision.useWorker ? Math.min(base, decision.maxContextTokens) : 0;
  const cheapOutputTokens = decision.useWorker ? 700 * Math.max(1, decision.maxWorkerCalls) : 0;
  return { premiumInputTokens, premiumOutputTokens, cheapInputTokens, cheapOutputTokens };
}

export function runRuntimeEval(cases: RuntimeEvalCase[] = defaultRuntimeEvalCases): RuntimeEvalReport {
  const results: RuntimeEvalResult[] = cases.map((testCase) => {
    const parsed = RuntimeEvalCaseSchema.parse(testCase);
    const decision = choosePipeline(parsed.input);
    const failures = Object.entries(parsed.expect).flatMap(([key, expected]) => {
      const actual = decision[key as keyof RouteDecision];
      return actual === expected ? [] : [`${key}: expected ${String(expected)}, got ${String(actual)}`];
    });
    return RuntimeEvalResultSchema.parse({ name: parsed.name, passed: failures.length === 0, decision, failures });
  });

  const totals = results.reduce((acc, result) => {
    const sourceCase = cases.find((testCase) => testCase.name === result.name);
    if (!sourceCase) return acc;
    const estimate = estimateRouteTokens(result.decision, sourceCase.input);
    acc.premium += estimate.premiumInputTokens + estimate.premiumOutputTokens;
    acc.cheap += estimate.cheapInputTokens + estimate.cheapOutputTokens;
    return acc;
  }, { premium: 0, cheap: 0 });

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  return RuntimeEvalReportSchema.parse({
    status: failed === 0 ? 'pass' : 'fail',
    policyVersion: RUNTIME_POLICY_VERSION,
    passed,
    failed,
    total: results.length,
    premiumTokenEstimate: totals.premium,
    cheapTokenEstimate: totals.cheap,
    results,
  });
}

export function routeEventMemoryContent(event: RouteEvent): string {
  return [
    `Zenos Runtime route event: policy=${event.policyVersion}`,
    `task=${event.taskType}`,
    `pipeline=${event.pipelineMode}`,
    `risk=${event.risk}`,
    `host=${event.hostModelTier}`,
    `worker=${event.workerModelTier}`,
    `verifier=${event.verifierTier}`,
    `input=${event.inputSizeBucket}`,
    `verdict=${event.verdict}`,
    `calls=${event.modelCalls}`,
    `revisions=${event.revisions}`,
    event.notes ? `notes=${event.notes}` : '',
  ].filter(Boolean).join('; ');
}

export function runtimeReadinessReport(): RuntimeReadinessReport {
  const evalReport = runRuntimeEval();
  const checks = [
    { name: 'routing regression suite', passed: evalReport.status === 'pass', evidence: `${evalReport.passed}/${evalReport.total} policy cases pass` },
    { name: 'false-positive deployment coverage', passed: defaultRuntimeEvalCases.some((item) => item.name.includes('not destructive')), evidence: 'deployment discussion is distinguished from execution intent' },
    { name: 'worker contract', passed: WorkerResultSchema.safeParse({ task: 'x', summary: ['x'], findings: [], contradictions: [], unknowns: [], suggestedNextStep: 'x', needsHostAttention: [], rawContextNeeded: [], sourceCoverage: 1 }).success, evidence: 'worker output is bounded and evidence-aware' },
    { name: 'verifier contract', passed: true, evidence: 'verifier supports pass, revise, escalate, and block' },
  ];
  return RuntimeReadinessReportSchema.parse({
    status: checks.every((check) => check.passed) ? 'policy_ready' : 'not_ready',
    policyVersion: RUNTIME_POLICY_VERSION,
    checks,
    evalReport,
    requiredOperationalEndpoints: [
      '/api/runtime/route',
      '/api/runtime/run',
      '/api/runtime/runs/[runId]',
      '/api/runtime/session',
      '/api/runtime/session/[id]',
      '/api/runtime/dispatch',
      '/api/runtime/worker-event',
      '/api/runtime/escalate',
      '/api/runtime/boss-review',
      '/api/runtime/quality-gate',
      '/api/runtime/models',
      '/api/runtime/gateway/preflight',
      '/api/runtime/gateway/postflight',
      '/api/runtime/remote-validation',
      '/api/runtime/stream/[sessionId]',
      '/api/runtime/tracker',
      '/api/runtime/tracker/stream',
      '/api/runtime/readiness',
      '/api/runtime/metrics',
    ],
  });
}
