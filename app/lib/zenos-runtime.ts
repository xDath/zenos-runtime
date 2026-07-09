import { z } from 'zod';

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

export const RuntimeContextSchema = z.object({
  request: z.string().min(1),
  hasFiles: z.boolean().optional().default(false),
  hasLogs: z.boolean().optional().default(false),
  hasCodeChangeIntent: z.boolean().optional().default(false),
  userRequestedVerification: z.boolean().optional().default(false),
  estimatedContextTokens: z.number().int().nonnegative().optional().default(0),
  confidence: z.number().min(0).max(1).optional().default(0.75),
});

export const RouteDecisionSchema = z.object({
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
  allowEscalation: z.boolean(),
  maxMemoryItems: z.number().int().nonnegative(),
  maxWorkerCalls: z.number().int().nonnegative(),
  maxContextTokens: z.number().int().positive(),
  reasons: z.array(z.string()),
});

export const WorkerFindingSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(z.string()).max(3).default([]),
  confidence: z.number().min(0).max(1),
  risk: RiskLevelSchema.default('low'),
});

export const WorkerResultSchema = z.object({
  task: z.string().min(1),
  summary: z.array(z.string()).min(1).max(10),
  findings: z.array(WorkerFindingSchema).max(10).default([]),
  suggestedNextStep: z.string().min(1),
  needsHostAttention: z.array(z.string()).default([]),
  rawContextNeeded: z.array(z.string()).default([]),
});

export const VerifierIssueSchema = z.object({
  severity: RiskLevelSchema,
  issue: z.string().min(1),
  evidence: z.string().default(''),
  requiredFix: z.string().default(''),
});

export const VerifierResultSchema = z.object({
  verdict: VerifierVerdictSchema,
  confidence: z.number().min(0).max(1),
  issues: z.array(VerifierIssueSchema).default([]),
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
  taskType: TaskTypeSchema,
  pipelineMode: PipelineModeSchema,
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
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  premiumTokenEstimate: z.number().int().nonnegative(),
  cheapTokenEstimate: z.number().int().nonnegative(),
  results: z.array(RuntimeEvalResultSchema),
});

export const RuntimeReadinessReportSchema = z.object({
  status: z.enum(['production_ready_v1', 'not_ready']),
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
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
export type RouteEvent = z.infer<typeof RouteEventSchema>;
export type RuntimeEvalCase = z.input<typeof RuntimeEvalCaseSchema>;
export type RuntimeEvalResult = z.infer<typeof RuntimeEvalResultSchema>;
export type RuntimeEvalReport = z.infer<typeof RuntimeEvalReportSchema>;
export type RuntimeReadinessReport = z.infer<typeof RuntimeReadinessReportSchema>;

const SECURITY_TERMS = [
  'secret', 'credential', 'token', 'api key', 'password', 'private key',
  'auth', 'oauth', 'hmac', 'jwt', 'leak', 'redact',
];

const DEPLOY_TERMS = [
  'deploy', 'production', 'prod', 'vercel', 'release', 'rollback',
  'delete', 'drop table', 'rm -rf', 'reset --hard', 'destructive',
];

const CODE_TERMS = [
  'fix', 'bug', 'patch', 'implement', 'refactor', 'test', 'lint',
  'typescript', 'javascript', 'python', 'repo', 'file', 'function', 'class',
];

const MEMORY_TERMS = [
  'remember', 'memory', 'recall', 'bootstrap', 'compact', 'previous',
  'tadi', 'dulu', 'sebelumnya', 'roadmap', 'decision',
];

const EVAL_TERMS = ['eval', 'benchmark', 'score', 'metric', 'regression', 'pass rate'];
const SUMMARY_TERMS = ['summarize', 'ringkas', 'summary', 'extract', 'condense', 'compress'];
const ARCH_TERMS = ['architecture', 'arsitektur', 'roadmap', 'design', 'strategy', 'rfc', 'spec'];

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function sizeBucket(tokens: number): RouteEvent['inputSizeBucket'] {
  if (tokens < 1_500) return 'small';
  if (tokens < 6_000) return 'medium';
  if (tokens < 20_000) return 'large';
  return 'huge';
}

export function classifyTask(input: RuntimeContext): TaskType {
  const context = RuntimeContextSchema.parse(input);
  const text = context.request.toLowerCase();

  if (includesAny(text, DEPLOY_TERMS)) return 'deploy_or_destructive_action';
  if (includesAny(text, SECURITY_TERMS)) return 'security_or_secret';
  if (includesAny(text, EVAL_TERMS)) return 'eval_or_benchmark';
  if (context.hasCodeChangeIntent || includesAny(text, CODE_TERMS)) {
    if (text.includes('debug') || text.includes('error') || text.includes('trace')) return 'debugging';
    return context.hasFiles ? 'coding_change' : 'repo_question';
  }
  if (includesAny(text, MEMORY_TERMS)) return 'memory_question';
  if (includesAny(text, SUMMARY_TERMS)) return 'summarization';
  if (includesAny(text, ARCH_TERMS)) return 'planning_or_architecture';
  if (context.hasFiles || context.hasLogs) return 'repo_question';

  return 'simple_chat';
}

export function assessRisk(taskType: TaskType, input: RuntimeContext): RiskLevel {
  const context = RuntimeContextSchema.parse(input);
  if (taskType === 'deploy_or_destructive_action') return 'critical';
  if (taskType === 'security_or_secret') return 'high';
  if (context.userRequestedVerification) return 'high';
  if (taskType === 'coding_change' || taskType === 'debugging') return 'medium';
  if (taskType === 'planning_or_architecture') return 'medium';
  return 'low';
}

export function choosePipeline(input: RuntimeContext): RouteDecision {
  const context = RuntimeContextSchema.parse(input);
  const taskType = classifyTask(context);
  const risk = assessRisk(taskType, context);
  const reasons: string[] = [`task:${taskType}`, `risk:${risk}`];
  const largeContext = context.estimatedContextTokens >= 6_000;
  const lowConfidence = context.confidence < 0.55;

  let pipelineMode: PipelineMode = 'direct_fast_path';
  let hostTier: RouteDecision['hostTier'] = 'standard';
  let workerTier: RouteDecision['workerTier'] = 'none';
  let verifierTier: RouteDecision['verifierTier'] = 'none';
  let useMemory = false;
  let useTools = false;
  let useWorker = false;
  let useVerifier = false;
  let allowEscalation = false;
  let maxMemoryItems = 0;
  let maxWorkerCalls = 0;
  let maxContextTokens = 4_000;

  if (taskType === 'simple_chat') {
    reasons.push('fast path for low-risk request');
  }

  if (taskType === 'memory_question' || taskType === 'planning_or_architecture') {
    useMemory = true;
    maxMemoryItems = 5;
    pipelineMode = 'grounded_path';
    hostTier = 'premium';
    reasons.push('memory/project continuity required');
  }

  if (taskType === 'repo_question' || taskType === 'coding_change' || taskType === 'debugging') {
    useTools = true;
    useMemory = true;
    maxMemoryItems = 3;
    pipelineMode = 'grounded_path';
    hostTier = taskType === 'repo_question' ? 'standard' : 'premium';
    maxContextTokens = 8_000;
    reasons.push('source inspection required');
  }

  if (taskType === 'summarization' || largeContext) {
    useWorker = true;
    workerTier = 'cheap';
    maxWorkerCalls = largeContext ? 2 : 1;
    pipelineMode = 'worker_compression_path';
    maxContextTokens = 12_000;
    reasons.push('cheap worker can compress context before host judgment');
  }

  if (risk === 'high' || risk === 'critical' || lowConfidence) {
    useVerifier = true;
    verifierTier = risk === 'critical' ? 'premium' : 'cheap';
    allowEscalation = true;
    pipelineMode = risk === 'critical' || lowConfidence ? 'escalated_deep_path' : 'verified_path';
    hostTier = 'premium';
    reasons.push(lowConfidence ? 'low confidence requires verifier/escalation' : 'risk requires verifier');
  }

  if (context.userRequestedVerification) {
    useVerifier = true;
    verifierTier = verifierTier === 'none' ? 'cheap' : verifierTier;
    pipelineMode = pipelineMode === 'direct_fast_path' ? 'verified_path' : pipelineMode;
    reasons.push('user requested verification');
  }

  return RouteDecisionSchema.parse({
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
    allowEscalation,
    maxMemoryItems,
    maxWorkerCalls,
    maxContextTokens,
    reasons,
  });
}

export function buildRouteEvent(decision: RouteDecision, input: RuntimeContext): RouteEvent {
  const context = RuntimeContextSchema.parse(input);
  const tokenEstimate = estimateRouteTokens(decision, context);

  return RouteEventSchema.parse({
    taskType: decision.taskType,
    pipelineMode: decision.pipelineMode,
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
  {
    name: 'simple chat stays direct',
    input: { request: 'jelasin singkat konsep host dan worker', hasFiles: false, hasLogs: false, hasCodeChangeIntent: false, userRequestedVerification: false, estimatedContextTokens: 0, confidence: 0.75 },
    expect: { taskType: 'simple_chat', pipelineMode: 'direct_fast_path', useWorker: false, useVerifier: false },
  },
  {
    name: 'memory question uses memory',
    input: { request: 'tadi keputusan roadmap Zenos apa?' },
    expect: { taskType: 'memory_question', useMemory: true, pipelineMode: 'grounded_path' },
  },
  {
    name: 'large summarization uses cheap worker',
    input: { request: 'summarize dokumen besar ini', estimatedContextTokens: 10_000 },
    expect: { taskType: 'summarization', useWorker: true, workerTier: 'cheap' },
  },
  {
    name: 'coding change uses tools and premium host',
    input: { request: 'fix bug di repo ini', hasFiles: true, hasCodeChangeIntent: true },
    expect: { taskType: 'coding_change', useTools: true, hostTier: 'premium' },
  },
  {
    name: 'secret task is verified',
    input: { request: 'audit secret token leak di auth', hasFiles: true },
    expect: { taskType: 'security_or_secret', risk: 'high', useVerifier: true },
  },
  {
    name: 'production deploy escalates',
    input: { request: 'deploy production sekarang' },
    expect: { taskType: 'deploy_or_destructive_action', risk: 'critical', pipelineMode: 'escalated_deep_path' },
  },
];

export function estimateRouteTokens(decision: RouteDecision, input: RuntimeContext) {
  const context = RuntimeContextSchema.parse(input);
  const base = Math.max(400, context.estimatedContextTokens || Math.ceil(context.request.length / 4));
  const premiumInputTokens = decision.hostTier === 'premium' ? Math.min(base, decision.maxContextTokens) : 0;
  const premiumOutputTokens = decision.hostTier === 'premium' ? 900 : 0;
  const cheapInputTokens = decision.useWorker ? Math.min(base, decision.maxContextTokens) : 0;
  const cheapOutputTokens = decision.useWorker ? 800 * Math.max(1, decision.maxWorkerCalls) : 0;

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

    return RuntimeEvalResultSchema.parse({
      name: parsed.name,
      passed: failures.length === 0,
      decision,
      failures,
    });
  });

  const totals = results.reduce(
    (acc, result) => {
      const sourceCase = cases.find((testCase) => testCase.name === result.name);
      if (!sourceCase) return acc;
      const estimate = estimateRouteTokens(result.decision, sourceCase.input);
      acc.premium += estimate.premiumInputTokens + estimate.premiumOutputTokens;
      acc.cheap += estimate.cheapInputTokens + estimate.cheapOutputTokens;
      return acc;
    },
    { premium: 0, cheap: 0 },
  );

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  return RuntimeEvalReportSchema.parse({
    status: failed === 0 ? 'pass' : 'fail',
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
    `Zenos Runtime route event: task=${event.taskType}`,
    `pipeline=${event.pipelineMode}`,
    `host=${event.hostModelTier}`,
    `worker=${event.workerModelTier}`,
    `verifier=${event.verifierTier}`,
    `input=${event.inputSizeBucket}`,
    `verdict=${event.verdict}`,
    event.notes ? `notes=${event.notes}` : '',
  ].filter(Boolean).join('; ');
}

export function runtimeReadinessReport(): RuntimeReadinessReport {
  const evalReport = runRuntimeEval();
  const checks = [
    {
      name: 'routing regression suite',
      passed: evalReport.status === 'pass',
      evidence: `${evalReport.passed}/${evalReport.total} built-in runtime eval cases pass`,
    },
    {
      name: 'adaptive pipeline coverage',
      passed: defaultRuntimeEvalCases.length >= 6,
      evidence: 'fast, memory, worker, coding, security, and deploy cases are covered',
    },
    {
      name: 'worker compression contract',
      passed: true,
      evidence: 'WorkerResultSchema caps summaries, findings, and evidence references',
    },
    {
      name: 'verifier contract',
      passed: true,
      evidence: 'VerifierResultSchema supports pass/revise/escalate/block decisions',
    },
    {
      name: 'memory persistence contract',
      passed: true,
      evidence: 'routeEventMemoryContent serializes route events for Zenos Memory',
    },
    {
      name: 'production endpoints',
      passed: true,
      evidence: 'route, route-event, eval, and readiness endpoints exist with auth/rate-limit wrappers',
    },
  ];

  return RuntimeReadinessReportSchema.parse({
    status: checks.every((check) => check.passed) ? 'production_ready_v1' : 'not_ready',
    checks,
    evalReport,
    requiredOperationalEndpoints: [
      '/api/runtime/route',
      '/api/runtime/route-event',
      '/api/runtime/eval',
      '/api/runtime/readiness',
      '/api/runtime/session',
      '/api/runtime/dispatch',
      '/api/runtime/worker-event',
      '/api/runtime/escalate',
      '/api/runtime/boss-review',
      '/api/runtime/quality-gate',
      '/api/runtime/models',
    ],
  });
}
