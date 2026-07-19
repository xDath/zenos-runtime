import { z } from 'zod';
import { GatewayMemoryBrief, GatewayTurnPreflightRequest } from './gateway-contracts';
import { RouteDecision } from './zenos-runtime';

export const CognitivePhaseSchema = z.enum([
  'understand',
  'discover',
  'plan',
  'execute',
  'validate',
  'repair',
  'complete',
  'waiting_for_user',
]);
export type CognitivePhase = z.infer<typeof CognitivePhaseSchema>;

export const CognitiveFieldStatusSchema = z.enum(['known', 'inferable', 'optional', 'blocking']);
export type CognitiveFieldStatus = z.infer<typeof CognitiveFieldStatusSchema>;

export const WorkerProfileSchema = z.enum([
  'browser-research',
  'repo-inspector',
  'coding-worker',
  'validation-worker',
  'ops-observer',
  'data-extractor',
]);
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const CognitiveFieldSchema = z.object({
  name: z.string().trim().min(1).max(120),
  status: CognitiveFieldStatusSchema,
  value: z.string().max(4_000).optional(),
  source: z.string().max(500).optional(),
  reason: z.string().max(1_000).optional(),
  safeDefault: z.string().max(1_000).optional(),
});

export const CapabilityRecommendationSchema = z.object({
  profile: WorkerProfileSchema,
  goal: z.string().trim().min(1).max(4_000),
  parallelSafe: z.boolean(),
  mutating: z.boolean(),
  evidenceRequired: z.array(z.string().trim().min(1).max(1_000)).max(10).default([]),
});

export const ContinuationPolicySchema = z.object({
  enabled: z.boolean(),
  maxCycles: z.number().int().min(1).max(12),
  compactAtTokens: z.number().int().min(8_000).max(500_000),
  preserveRecentMessages: z.number().int().min(2).max(40),
  askUserOnlyForBlockingFields: z.boolean(),
  terminalConditions: z.array(z.string().trim().min(1).max(1_000)).max(10),
});

export const CognitivePacketSchema = z.object({
  version: z.literal('zenos-cognitive-packet-v1'),
  rootObjective: z.string().trim().min(1).max(12_000),
  taskType: z.string().trim().min(1).max(120),
  phase: CognitivePhaseSchema,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(16),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(16),
  fields: z.array(CognitiveFieldSchema).max(24),
  capabilities: z.array(CapabilityRecommendationSchema).max(6),
  maxParallelWorkers: z.number().int().min(0).max(3),
  workerModelPolicy: z.literal('inherit-host'),
  verifierPolicy: z.enum(['off', 'explicit-only', 'critical-only']),
  bossPolicy: z.enum(['off', 'explicit-or-critical']),
  memorySource: z.enum(['none', 'handoff', 'recall', 'bootstrap']),
  repositoryContextAvailable: z.boolean(),
  nextAction: z.object({
    owner: z.enum(['host', 'worker']),
    profile: WorkerProfileSchema.optional(),
    instruction: z.string().trim().min(1).max(4_000),
    stopCondition: z.string().trim().min(1).max(2_000),
  }),
  continuation: ContinuationPolicySchema,
});

export type CognitivePacket = z.infer<typeof CognitivePacketSchema>;

const USER_OWNED_SECRET = /\b(?:api\s*key|credential|password|private\s*key|mnemonic|secret|token)\b/i;
const RECIPIENT_FIELD = /\b(?:email|e-mail|alamat\s+email|recipient|penerima|nomor\s+tujuan|destination)\b/i;
const IRREVERSIBLE_CHOICE = /\b(?:hapus\s+permanen|hard\s*delete|transfer|kirim\s+dana|mainnet|production\s+destroy|wipe|format\s+disk)\b/i;

function acceptanceCriteriaFor(request: GatewayTurnPreflightRequest, decision: RouteDecision): string[] {
  const criteria: Record<RouteDecision['taskType'], string[]> = {
    simple_chat: ['The response directly answers the latest user request.'],
    memory_question: ['Relevant durable context is recovered without presenting stale state as current.'],
    repo_question: ['The answer is grounded in inspected repository evidence and cites exact artifacts or paths.'],
    coding_change: [
      'The requested behavior is implemented.',
      'Relevant deterministic validation passes.',
      'No unrelated files are modified.',
    ],
    debugging: [
      'The failing behavior is reproduced or bounded by concrete evidence.',
      'The root cause is identified before a fix is claimed.',
      'The fix or recovery is validated end to end.',
    ],
    summarization: ['The output preserves goals, decisions, blockers, pending work, and important artifacts.'],
    planning_or_architecture: ['The plan resolves the objective, constraints, sequencing, risks, and measurable acceptance criteria.'],
    security_or_secret: [
      'The work stays within the authorized scope.',
      'Claims are backed by reproducible local, testnet, sandbox, or program-authorized evidence.',
      'Secrets are not copied into chat, logs, or long-term memory.',
    ],
    deploy_or_destructive_action: [
      'The target and rollback path are verified before mutation.',
      'Required authorization is present.',
      'Post-action health checks pass.',
    ],
    eval_or_benchmark: ['The methodology, inputs, result, and limitations are reported consistently.'],
  };
  const selected = [...criteria[decision.taskType]];
  if (request.userRequestedVerification) selected.push('The explicitly requested verification is completed before final delivery.');
  return selected;
}

function constraintsFor(request: GatewayTurnPreflightRequest, decision: RouteDecision): string[] {
  const constraints = [
    'Hermes Host is the sole orchestrator and final decision maker.',
    'Use the smallest sufficient tool and context surface.',
    'Do not ask the user to continue routine work that can proceed autonomously.',
    'Do not repeat a failed attempt unless new evidence changes its premise.',
  ];
  if (request.workspaceRoot) constraints.push(`Canonical workspace: ${request.workspaceRoot}`);
  if (decision.risk === 'high' || decision.risk === 'critical') {
    constraints.push('Require concrete evidence and a reversible path before consequential mutations.');
  }
  if (decision.taskType === 'coding_change' || decision.taskType === 'debugging') {
    constraints.push('At most one mutating worker may operate on a workspace at a time; parallel workers must otherwise remain read-only.');
  }
  if (decision.taskType === 'security_or_secret') {
    constraints.push('Authorized bug-bounty, CTF, local PoC, testnet, and sandbox work is permitted; unscoped live attacks are not.');
  }
  return constraints;
}

function fieldsFor(request: GatewayTurnPreflightRequest, decision: RouteDecision): z.infer<typeof CognitiveFieldSchema>[] {
  const fields: z.infer<typeof CognitiveFieldSchema>[] = [
    {
      name: 'root_objective',
      status: 'known',
      value: request.request,
      source: 'latest-user-message',
    },
  ];
  if (request.workspaceRoot) {
    fields.push({
      name: 'workspace_root',
      status: 'known',
      value: request.workspaceRoot,
      source: 'gateway-context',
    });
  } else if (['repo_question', 'coding_change', 'debugging'].includes(decision.taskType)) {
    fields.push({
      name: 'workspace_root',
      status: 'inferable',
      source: 'current terminal, repository context, or project memory',
      reason: 'Repository work needs a canonical workspace, but Hermes can discover it before asking the user.',
    });
  }
  if (USER_OWNED_SECRET.test(request.request)) {
    fields.push({
      name: 'user_owned_credential',
      status: 'inferable',
      source: 'encrypted service credentials or configured provider state',
      reason: 'Inspect configured secret references first; ask only when the credential is genuinely absent.',
    });
  }
  if (RECIPIENT_FIELD.test(request.request)) {
    fields.push({
      name: 'destination',
      status: 'inferable',
      source: 'saved contact, explicit conversation context, or task artifact',
      reason: 'A destination may be discoverable; it becomes blocking only if multiple materially different candidates remain.',
    });
  }
  if (IRREVERSIBLE_CHOICE.test(request.request)) {
    fields.push({
      name: 'irreversible_authorization',
      status: request.approvalGranted ? 'known' : 'blocking',
      value: request.approvalGranted ? 'granted' : undefined,
      source: request.approvalGranted ? 'gateway-approval' : undefined,
      reason: request.approvalGranted ? undefined : 'Only the user can authorize an irreversible or privileged boundary.',
    });
  }
  return fields;
}

function capabilitiesFor(
  request: GatewayTurnPreflightRequest,
  decision: RouteDecision,
): z.infer<typeof CapabilityRecommendationSchema>[] {
  const profile = (
    name: WorkerProfile,
    goal: string,
    parallelSafe: boolean,
    mutating: boolean,
    evidenceRequired: string[],
  ): z.infer<typeof CapabilityRecommendationSchema> => ({
    profile: name,
    goal,
    parallelSafe,
    mutating,
    evidenceRequired,
  });

  switch (decision.taskType) {
    case 'repo_question':
      return [profile('repo-inspector', 'Inspect the smallest relevant repository surface and return exact file, symbol, and revision evidence.', true, false, ['paths', 'symbols', 'relevant excerpts'])];
    case 'coding_change':
      return [
        profile('repo-inspector', 'Map the affected code path, constraints, and tests before mutation.', true, false, ['affected files', 'call path', 'existing tests']),
        profile('coding-worker', 'Implement one bounded change in an isolated task context after the Host chooses the patch boundary.', false, true, ['changed files', 'patch summary']),
        profile('validation-worker', 'Run targeted deterministic validation and return exact command results.', true, false, ['commands', 'exit status', 'failure output']),
      ];
    case 'debugging':
      return [
        profile('ops-observer', 'Collect service, process, queue, and log evidence without changing production state.', true, false, ['timestamps', 'service state', 'relevant log lines']),
        profile('repo-inspector', 'Trace the observed failure through configuration and source code.', true, false, ['configuration path', 'source path', 'drop or failure point']),
        profile('validation-worker', 'Reproduce the failure or validate the proposed fix with a bounded test.', true, false, ['reproduction', 'expected versus actual', 'exit status']),
      ];
    case 'security_or_secret':
      return [
        profile('browser-research', 'Confirm the authorized scope, rules, and referenced documentation.', true, false, ['scope URL or artifact', 'authorization constraints']),
        profile('repo-inspector', 'Trace the vulnerable or security-sensitive path in the authorized target.', true, false, ['source path', 'control flow', 'impact preconditions']),
        profile('validation-worker', 'Run only authorized local, sandbox, testnet, or program-scoped validation.', true, false, ['environment', 'test command', 'reproducible result']),
      ];
    case 'summarization':
      return request.estimatedContextTokens >= 12_000
        ? [profile('data-extractor', 'Extract goals, decisions, blockers, questions, artifacts, and unresolved work into a structured evidence bundle.', true, false, ['source anchors', 'coverage by category'])]
        : [];
    case 'planning_or_architecture':
      return [
        profile('repo-inspector', 'Inspect current architecture and constraints before proposing changes.', true, false, ['current components', 'coupling', 'operational constraints']),
        profile('browser-research', 'Research only external facts or current standards that materially affect the design.', true, false, ['authoritative sources', 'date or version']),
      ];
    case 'deploy_or_destructive_action':
      return [profile('ops-observer', 'Verify target health, active revision, dependencies, rollback path, and current production state without mutating it.', true, false, ['active revision', 'service health', 'rollback artifact'])];
    case 'eval_or_benchmark':
      return [profile('validation-worker', 'Execute the bounded evaluation and return raw metrics, configuration, and limitations.', true, false, ['inputs', 'metrics', 'environment', 'limitations'])];
    case 'memory_question':
    case 'simple_chat':
    default:
      return [];
  }
}

function initialPhase(request: GatewayTurnPreflightRequest, decision: RouteDecision, repositoryContext: string): CognitivePhase {
  if (fieldsFor(request, decision).some((field) => field.status === 'blocking')) return 'waiting_for_user';
  if (decision.taskType === 'simple_chat' || decision.taskType === 'memory_question') return 'execute';
  if (['coding_change', 'debugging', 'repo_question', 'security_or_secret'].includes(decision.taskType) && !repositoryContext) return 'discover';
  if (decision.taskType === 'planning_or_architecture') return 'plan';
  return 'execute';
}

function nextActionFor(
  phase: CognitivePhase,
  capabilities: z.infer<typeof CapabilityRecommendationSchema>[],
  decision: RouteDecision,
): CognitivePacket['nextAction'] {
  const first = capabilities[0];
  if (phase === 'waiting_for_user') {
    return {
      owner: 'host',
      instruction: 'Ask one concise question containing only the genuinely blocking user-owned field, while preserving the durable task state.',
      stopCondition: 'The blocking field has a valid user-provided value.',
    };
  }
  if (first && capabilities.length > 1) {
    return {
      owner: 'host',
      instruction: `Decide which independent evidence tasks can run concurrently, then delegate only those bounded tasks using the recommended worker profiles. Start with ${first.profile}.`,
      stopCondition: 'The Host has enough evidence to execute or validate the next material step.',
    };
  }
  if (first) {
    return {
      owner: 'worker',
      profile: first.profile,
      instruction: first.goal,
      stopCondition: first.evidenceRequired.length ? `Return: ${first.evidenceRequired.join(', ')}.` : 'Return a bounded evidence bundle.',
    };
  }
  return {
    owner: 'host',
    instruction: decision.useTools
      ? 'Use the smallest relevant tool sequence directly and keep the final synthesis with the Host.'
      : 'Answer the latest user request directly from the available context.',
    stopCondition: 'The acceptance criteria are satisfied or a genuine blocking field is identified.',
  };
}

export function compileCognitivePacket(input: {
  request: GatewayTurnPreflightRequest;
  decision: RouteDecision;
  memory: GatewayMemoryBrief;
  repositoryContext: string;
}): CognitivePacket {
  const capabilities = capabilitiesFor(input.request, input.decision);
  const phase = initialPhase(input.request, input.decision, input.repositoryContext);
  const configuredCycles = Number(process.env.ZENOS_COGNITIVE_MAX_CONTINUATIONS || 6);
  const configuredCompactAt = Number(process.env.ZENOS_COGNITIVE_COMPACT_AT_TOKENS || 160_000);
  return CognitivePacketSchema.parse({
    version: 'zenos-cognitive-packet-v1',
    rootObjective: input.request.request,
    taskType: input.decision.taskType,
    phase,
    acceptanceCriteria: acceptanceCriteriaFor(input.request, input.decision),
    constraints: constraintsFor(input.request, input.decision),
    fields: fieldsFor(input.request, input.decision),
    capabilities,
    maxParallelWorkers: Math.min(3, capabilities.filter((item) => item.parallelSafe).length),
    workerModelPolicy: 'inherit-host',
    verifierPolicy: input.request.userRequestedVerification ? 'explicit-only' : 'off',
    bossPolicy: 'explicit-or-critical',
    memorySource: input.memory.source,
    repositoryContextAvailable: Boolean(input.repositoryContext),
    nextAction: nextActionFor(phase, capabilities, input.decision),
    continuation: {
      enabled: input.decision.taskType !== 'simple_chat',
      maxCycles: Math.max(1, Math.min(Number.isFinite(configuredCycles) ? configuredCycles : 6, 12)),
      compactAtTokens: Math.max(8_000, Math.min(Number.isFinite(configuredCompactAt) ? configuredCompactAt : 160_000, 500_000)),
      preserveRecentMessages: 10,
      askUserOnlyForBlockingFields: true,
      terminalConditions: [
        'All acceptance criteria are satisfied with evidence.',
        'A genuinely blocking user-owned field is missing.',
        'An explicit privileged or irreversible approval is required.',
        'The bounded continuation budget is exhausted.',
        'A non-recoverable blocker is proven by evidence.',
      ],
    },
  });
}

export function renderCognitivePacket(packet: CognitivePacket): string {
  const knownFields = packet.fields.filter((field) => field.status === 'known');
  const inferableFields = packet.fields.filter((field) => field.status === 'inferable');
  const blockingFields = packet.fields.filter((field) => field.status === 'blocking');
  const capabilityLines = packet.capabilities.map((capability) => (
    `- ${capability.profile}: ${capability.goal} [parallel=${capability.parallelSafe}; mutating=${capability.mutating}]`
  ));
  return [
    '# ZENOS COGNITIVE EXECUTION PACKET',
    `Objective: ${packet.rootObjective}`,
    `Phase: ${packet.phase}`,
    `Task type: ${packet.taskType}`,
    '',
    '## Acceptance criteria',
    ...packet.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '## Constraints',
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    knownFields.length ? `\n## Known fields\n${knownFields.map((field) => `- ${field.name}: ${field.value || 'known'} (${field.source || 'context'})`).join('\n')}` : '',
    inferableFields.length ? `\n## Infer before asking\n${inferableFields.map((field) => `- ${field.name}: ${field.reason || field.source || 'discover with tools'}`).join('\n')}` : '',
    blockingFields.length ? `\n## Genuine blockers\n${blockingFields.map((field) => `- ${field.name}: ${field.reason || 'user input required'}`).join('\n')}` : '',
    capabilityLines.length ? `\n## Optional delegation profiles\n${capabilityLines.join('\n')}\n- Worker model policy: inherit the current Host model.\n- Delegate only independent bounded work; Host remains responsible for synthesis and final actions.` : '',
    '',
    '## Next action',
    `Owner: ${packet.nextAction.owner}${packet.nextAction.profile ? ` (${packet.nextAction.profile})` : ''}`,
    packet.nextAction.instruction,
    `Stop condition: ${packet.nextAction.stopCondition}`,
    '',
    '## Continuation contract',
    `- One visible user request may use up to ${packet.continuation.maxCycles} internal cycles.`,
    `- Compact/checkpoint near ${packet.continuation.compactAtTokens} tokens using verified delta state, not recursive prose summaries.`,
    '- Continue automatically after ordinary tool, context, or iteration boundaries.',
    '- Ask the user only for a field marked blocking; do not silently skip required fields.',
    '- Intermediate drafts are not final answers.',
  ].filter(Boolean).join('\n');
}
