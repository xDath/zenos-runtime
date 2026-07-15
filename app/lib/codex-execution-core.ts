import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  ChangeImpact,
  RepositoryIndex,
  renderRepositoryContext,
  resolveRepositoryPath,
} from './repository-intelligence';
import { runGovernedCommand } from './resource-governor';
import { createDefaultToolBroker, ToolBroker, ToolEvidence } from './tool-broker';
import { getRuntimeStore, RuntimeStore } from './zenos-runtime-store';

export const CodingPhaseSchema = z.enum([
  'understand',
  'plan',
  'inspect',
  'patch',
  'targeted_validation',
  'analyze_failure',
  'revise',
  'full_validation',
  'summarize',
]);
export type CodingPhase = z.infer<typeof CodingPhaseSchema>;

export const CodingTaskStatusSchema = z.enum(['active', 'blocked', 'failed', 'completed', 'cancelled']);
export type CodingTaskStatus = z.infer<typeof CodingTaskStatusSchema>;

export const CodingStepSchema = z.object({
  sequence: z.number().int().positive(),
  phase: CodingPhaseSchema,
  status: z.enum(['started', 'completed', 'failed', 'blocked']),
  summary: z.string().max(12_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type CodingStep = z.infer<typeof CodingStepSchema>;

export const CodingToolCallSchema = z.object({
  tool: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().max(12_000),
  artifactId: z.string().optional(),
  durationMs: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type CodingToolCall = z.infer<typeof CodingToolCallSchema>;

export const CodingValidationSchema = z.object({
  kind: z.enum(['syntax', 'schema', 'security', 'targeted_test', 'typecheck', 'lint', 'package_test', 'build', 'remote']),
  status: z.enum(['passed', 'failed', 'skipped', 'remote_required']),
  summary: z.string().max(12_000),
  artifactId: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type CodingValidation = z.infer<typeof CodingValidationSchema>;

export const CodingFailureSchema = z.object({
  phase: CodingPhaseSchema,
  category: z.enum(['tool', 'validation', 'policy', 'model', 'unknown']),
  summary: z.string().max(12_000),
  evidence: z.array(z.string().max(4_000)).max(20).default([]),
  recoverable: z.boolean(),
  createdAt: z.string().datetime(),
});
export type CodingFailure = z.infer<typeof CodingFailureSchema>;

export const CodingCheckpointSchema = z.object({
  checkpointId: z.string().min(1),
  phase: CodingPhaseSchema,
  workspaceRevision: z.string().min(1),
  files: z.array(z.string()),
  diffArtifactId: z.string().optional(),
  snapshotPath: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type CodingCheckpoint = z.infer<typeof CodingCheckpointSchema>;

export const CodingTaskStateSchema = z.object({
  version: z.number().int().positive(),
  taskId: z.string().min(1),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  request: z.string().min(1).max(100_000),
  workspaceRoot: z.string().min(1),
  workspaceRevision: z.string().min(1),
  status: CodingTaskStatusSchema,
  currentPhase: CodingPhaseSchema,
  steps: z.array(CodingStepSchema),
  filesInspected: z.array(z.string()),
  filesChanged: z.array(z.string()),
  assumptions: z.array(z.string().max(8_000)),
  toolCalls: z.array(CodingToolCallSchema),
  validations: z.array(CodingValidationSchema),
  failures: z.array(CodingFailureSchema),
  checkpoints: z.array(CodingCheckpointSchema),
  unresolvedRisks: z.array(z.string().max(8_000)),
  acceptanceCriteria: z.array(z.string().max(8_000)),
  forbiddenActions: z.array(z.string().max(8_000)),
  continuationAttempts: z.number().int().nonnegative().max(10).default(0),
  lastContinuationAt: z.string().datetime().optional(),
  tokenUsage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    estimatedCost: z.number().nonnegative(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CodingTaskState = z.infer<typeof CodingTaskStateSchema>;

export const MinimalPatchViolationSchema = z.object({
  code: z.enum([
    'unrelated_file',
    'deleted_test',
    'disabled_check',
    'unjustified_dependency_change',
    'public_api_change',
    'oversized_patch',
  ]),
  severity: z.enum(['medium', 'high', 'critical']),
  file: z.string().optional(),
  evidence: z.string().max(4_000),
});
export type MinimalPatchViolation = z.infer<typeof MinimalPatchViolationSchema>;

export const MinimalPatchPolicyResultSchema = z.object({
  verdict: z.enum(['pass', 'review', 'block']),
  violations: z.array(MinimalPatchViolationSchema),
  changedFiles: z.array(z.string()),
  changedLineCount: z.number().int().nonnegative(),
});
export type MinimalPatchPolicyResult = z.infer<typeof MinimalPatchPolicyResultSchema>;

export type PreparedCodexExecution = {
  state: CodingTaskState;
  repository: RepositoryIndex;
  impact: ChangeImpact;
  validationPlan: string[];
  context: string;
};

export type CodexValidationTool = {
  name: 'test.run' | 'typecheck.run' | 'lint.run' | 'build.run' | 'json.validate' | 'schema.validate' | 'secret.scan';
  input: unknown;
};

export type CodexValidationOutcome = {
  state: CodingTaskState;
  stage: 'targeted' | 'full';
  status: 'passed' | 'failed' | 'remote_required';
  evidence: ToolEvidence[];
  revisionPacket?: string;
};

type CheckpointSnapshot = {
  version: 1;
  taskId: string;
  checkpointId: string;
  root: string;
  createdAt: string;
  entries: Array<{
    path: string;
    existed: boolean;
    mode?: number;
    hash?: string;
    contentBase64?: string;
  }>;
  gitDiff: string;
};

const PHASE_TRANSITIONS: Record<CodingPhase, CodingPhase[]> = {
  understand: ['plan'],
  plan: ['inspect'],
  inspect: ['patch', 'targeted_validation', 'summarize'],
  patch: ['targeted_validation'],
  targeted_validation: ['analyze_failure', 'full_validation', 'summarize'],
  analyze_failure: ['revise'],
  revise: ['targeted_validation'],
  full_validation: ['analyze_failure', 'summarize'],
  summarize: [],
};

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function now(): string {
  return new Date().toISOString();
}

function persistState(store: RuntimeStore, state: CodingTaskState): CodingTaskState {
  const parsed = CodingTaskStateSchema.parse(state);
  store.saveCodingTask({
    taskId: parsed.taskId,
    runId: parsed.runId,
    sessionId: parsed.sessionId,
    status: parsed.status,
    phase: parsed.currentPhase,
    state: parsed,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  });
  return parsed;
}

export function loadCodingTask(taskId: string, store: RuntimeStore = getRuntimeStore()): CodingTaskState | undefined {
  const record = store.getCodingTask(taskId);
  if (!record) return undefined;
  return CodingTaskStateSchema.parse(record.state);
}

export function createCodingTask(input: {
  taskId?: string;
  runId?: string;
  sessionId?: string;
  request: string;
  workspaceRoot: string;
  workspaceRevision: string;
  acceptanceCriteria?: string[];
  forbiddenActions?: string[];
  assumptions?: string[];
}, store: RuntimeStore = getRuntimeStore()): CodingTaskState {
  const createdAt = now();
  const taskId = input.taskId || `coding_${crypto.randomUUID()}`;
  if (store.getCodingTask(taskId)) throw new Error(`Coding task already exists: ${taskId}`);
  const state = CodingTaskStateSchema.parse({
    version: 1,
    taskId,
    runId: input.runId,
    sessionId: input.sessionId,
    request: input.request,
    workspaceRoot: path.resolve(input.workspaceRoot),
    workspaceRevision: input.workspaceRevision,
    status: 'active',
    currentPhase: 'understand',
    steps: [{
      sequence: 1,
      phase: 'understand',
      status: 'completed',
      summary: 'Captured user intent, workspace revision, constraints, and deterministic acceptance criteria.',
      metadata: {},
      startedAt: createdAt,
      completedAt: createdAt,
    }],
    filesInspected: [],
    filesChanged: [],
    assumptions: stableUnique(input.assumptions || []),
    toolCalls: [],
    validations: [],
    failures: [],
    checkpoints: [],
    unresolvedRisks: [],
    acceptanceCriteria: input.acceptanceCriteria?.length
      ? stableUnique(input.acceptanceCriteria)
      : ['The requested behavior is implemented.', 'Affected validation passes.', 'No unrelated files are modified.'],
    forbiddenActions: input.forbiddenActions?.length
      ? stableUnique(input.forbiddenActions)
      : [
          'Do not disable tests, lint, type checking, or build checks.',
          'Do not delete tests to obtain a passing result.',
          'Do not make unrelated changes.',
          'Do not introduce dependencies without explicit evidence and approval.',
          'Do not change public APIs without explicit approval.',
        ],
    continuationAttempts: 0,
    tokenUsage: { input: 0, output: 0, estimatedCost: 0 },
    createdAt,
    updatedAt: createdAt,
  });
  return persistState(store, state);
}

function nextStep(state: CodingTaskState, phase: CodingPhase, summary: string, metadata: Record<string, unknown>): CodingStep {
  const timestamp = now();
  return CodingStepSchema.parse({
    sequence: state.steps.length + 1,
    phase,
    status: 'completed',
    summary,
    metadata,
    startedAt: timestamp,
    completedAt: timestamp,
  });
}

export function transitionCodingTask(
  taskId: string,
  phase: CodingPhase,
  input: { summary: string; metadata?: Record<string, unknown>; status?: CodingTaskStatus },
  store: RuntimeStore = getRuntimeStore(),
): CodingTaskState {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  if (state.status !== 'active' && input.status === undefined) throw new Error(`Coding task ${taskId} is ${state.status}`);
  if (phase !== state.currentPhase && !PHASE_TRANSITIONS[state.currentPhase].includes(phase)) {
    throw new Error(`Invalid coding phase transition: ${state.currentPhase} -> ${phase}`);
  }
  const updated = CodingTaskStateSchema.parse({
    ...state,
    version: state.version + 1,
    currentPhase: phase,
    status: input.status || (phase === 'summarize' ? 'completed' : state.status),
    steps: phase === state.currentPhase
      ? state.steps
      : [...state.steps, nextStep(state, phase, input.summary, input.metadata || {})],
    updatedAt: now(),
  });
  return persistState(store, updated);
}

export function updateCodingTask(
  taskId: string,
  patch: Partial<Pick<CodingTaskState,
    'runId' | 'filesInspected' | 'filesChanged' | 'assumptions' | 'toolCalls' | 'validations' | 'failures' | 'checkpoints' | 'unresolvedRisks' | 'acceptanceCriteria' | 'forbiddenActions' | 'continuationAttempts' | 'lastContinuationAt' | 'tokenUsage' | 'workspaceRevision' | 'status'>>,
  store: RuntimeStore = getRuntimeStore(),
): CodingTaskState {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  const updated = CodingTaskStateSchema.parse({
    ...state,
    ...patch,
    version: state.version + 1,
    filesInspected: stableUnique(patch.filesInspected || state.filesInspected),
    filesChanged: stableUnique(patch.filesChanged || state.filesChanged),
    assumptions: stableUnique(patch.assumptions || state.assumptions),
    unresolvedRisks: stableUnique(patch.unresolvedRisks || state.unresolvedRisks),
    acceptanceCriteria: stableUnique(patch.acceptanceCriteria || state.acceptanceCriteria),
    forbiddenActions: stableUnique(patch.forbiddenActions || state.forbiddenActions),
    updatedAt: now(),
  });
  return persistState(store, updated);
}

export function recordCodingToolCall(taskId: string, call: Omit<CodingToolCall, 'createdAt'>, store: RuntimeStore = getRuntimeStore()): CodingTaskState {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  return updateCodingTask(taskId, { toolCalls: [...state.toolCalls, CodingToolCallSchema.parse({ ...call, createdAt: now() })] }, store);
}

export function recordCodingValidation(taskId: string, validation: Omit<CodingValidation, 'createdAt'>, store: RuntimeStore = getRuntimeStore()): CodingTaskState {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  return updateCodingTask(taskId, { validations: [...state.validations, CodingValidationSchema.parse({ ...validation, createdAt: now() })] }, store);
}

export function recordCodingFailure(taskId: string, failure: Omit<CodingFailure, 'createdAt'>, store: RuntimeStore = getRuntimeStore()): CodingTaskState {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  return updateCodingTask(taskId, { failures: [...state.failures, CodingFailureSchema.parse({ ...failure, createdAt: now() })] }, store);
}

function checkpointDirectory(root: string, taskId: string): string {
  const configuredRoot = process.env.ZENOS_RUNTIME_CODING_CHECKPOINT_DIR?.trim();
  const checkpointRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : process.env.NODE_ENV === 'production'
      ? '/var/lib/zenos-runtime/coding-checkpoints'
      : path.join(root, '.data', 'coding-checkpoints');
  const workspaceKey = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  const taskLabel = taskId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || 'task';
  const taskKey = `${taskLabel}-${crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 12)}`;
  return path.join(checkpointRoot, workspaceKey, taskKey);
}

function writeCheckpointSnapshot(snapshotPath: string, snapshot: CheckpointSnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const temporary = `${snapshotPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(temporary, snapshotPath);
}

export async function createCodingCheckpoint(
  taskId: string,
  files: string[],
  options: { maxSnapshotBytes?: number } = {},
  store: RuntimeStore = getRuntimeStore(),
): Promise<CodingTaskState> {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  const checkpointId = `checkpoint_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const maxSnapshotBytes = Math.max(1_000_000, Math.min(options.maxSnapshotBytes || 12_000_000, 50_000_000));
  let totalBytes = 0;
  const entries: CheckpointSnapshot['entries'] = [];
  for (const relativePath of stableUnique(files).slice(0, 100)) {
    const normalized = normalizeRelative(relativePath);
    const absolute = resolveRepositoryPath(state.workspaceRoot, normalized);
    if (!fs.existsSync(absolute)) {
      entries.push({ path: normalized, existed: false });
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) continue;
    totalBytes += stat.size;
    if (totalBytes > maxSnapshotBytes) throw new Error(`Checkpoint exceeds ${maxSnapshotBytes} bytes`);
    const content = fs.readFileSync(absolute);
    entries.push({
      path: normalized,
      existed: true,
      mode: stat.mode,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64'),
    });
  }
  const diff = await runGovernedCommand('git', ['diff', '--binary', '--no-ext-diff'], {
    cwd: state.workspaceRoot,
    timeoutMs: 20_000,
    maxOutputBytes: 8_000_000,
  });
  const directory = checkpointDirectory(state.workspaceRoot, taskId);
  const snapshotPath = path.join(directory, `${checkpointId}.json`);
  const snapshot: CheckpointSnapshot = {
    version: 1,
    taskId,
    checkpointId,
    root: state.workspaceRoot,
    createdAt: now(),
    entries,
    gitDiff: diff.stdout,
  };
  writeCheckpointSnapshot(snapshotPath, snapshot);
  const checkpoint = CodingCheckpointSchema.parse({
    checkpointId,
    phase: state.currentPhase,
    workspaceRevision: state.workspaceRevision,
    files: entries.map((entry) => entry.path),
    diffArtifactId: diff.artifactId,
    snapshotPath,
    createdAt: snapshot.createdAt,
  });
  return updateCodingTask(taskId, { checkpoints: [...state.checkpoints, checkpoint] }, store);
}

export function rollbackCodingCheckpoint(
  taskId: string,
  checkpointId: string,
  options: { approvalGranted: boolean },
  store: RuntimeStore = getRuntimeStore(),
): { state: CodingTaskState; restored: string[]; removed: string[] } {
  if (!options.approvalGranted) throw new Error('Explicit approval is required before rollback overwrites workspace files');
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  const checkpoint = state.checkpoints.find((entry) => entry.checkpointId === checkpointId);
  if (!checkpoint?.snapshotPath) throw new Error(`Checkpoint snapshot not found: ${checkpointId}`);
  const snapshot = JSON.parse(fs.readFileSync(checkpoint.snapshotPath, 'utf8')) as CheckpointSnapshot;
  if (snapshot.taskId !== taskId || path.resolve(snapshot.root) !== path.resolve(state.workspaceRoot)) {
    throw new Error('Checkpoint identity does not match the coding task');
  }
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of snapshot.entries) {
    const absolute = resolveRepositoryPath(state.workspaceRoot, entry.path);
    if (!entry.existed) {
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        fs.rmSync(absolute);
        removed.push(entry.path);
      }
      continue;
    }
    if (!entry.contentBase64) throw new Error(`Checkpoint content missing for ${entry.path}`);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.rollback.tmp`;
    fs.writeFileSync(temporary, Buffer.from(entry.contentBase64, 'base64'), { mode: entry.mode });
    fs.renameSync(temporary, absolute);
    restored.push(entry.path);
  }
  const updated = updateCodingTask(taskId, {
    filesChanged: stableUnique(state.filesChanged.filter((file) => !snapshot.entries.some((entry) => entry.path === file))),
    unresolvedRisks: [...state.unresolvedRisks, `Rollback ${checkpointId} restored the checkpointed workspace state; validation must be rerun.`],
  }, store);
  return { state: updated, restored, removed };
}

function deletedTestFiles(diff: string): string[] {
  const output: string[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match?.[2] || '';
      continue;
    }
    if (line.startsWith('deleted file mode') && /(^|\/)(__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$/i.test(currentFile)) {
      output.push(currentFile);
    }
  }
  return stableUnique(output);
}

function exportedSymbolFromDiffLine(line: string): string | undefined {
  const declaration = line.match(/^[+-]\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (declaration?.[1]) return declaration[1];
  const named = line.match(/^[+-]\s*export\s*\{\s*([A-Za-z_$][\w$]*)/);
  return named?.[1];
}

export function evaluateMinimalPatchPolicy(input: {
  diff: string;
  changedFiles: string[];
  allowedFiles?: string[];
  dependencyChangeApproved?: boolean;
  publicApiChangeApproved?: boolean;
  maxChangedLines?: number;
}): MinimalPatchPolicyResult {
  const changedFiles = stableUnique(input.changedFiles.map(normalizeRelative));
  const allowed = new Set((input.allowedFiles || []).map(normalizeRelative));
  const violations: MinimalPatchViolation[] = [];
  if (allowed.size) {
    for (const file of changedFiles.filter((candidate) => !allowed.has(candidate))) {
      violations.push({
        code: 'unrelated_file',
        severity: 'high',
        file,
        evidence: `${file} is outside the deterministic affected-file set.`,
      });
    }
  }
  for (const file of deletedTestFiles(input.diff)) {
    violations.push({ code: 'deleted_test', severity: 'critical', file, evidence: `Patch deletes test file ${file}.` });
  }
  const addedLines = input.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  const removedLines = input.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  const disabledCheckPattern = /(?:ignoreBuildErrors|eslint-disable|@ts-ignore|@ts-nocheck|\b(?:describe|it|test)\.skip\b|--no-verify|\bas\s+any\b)/i;
  for (const line of addedLines.filter((candidate) => disabledCheckPattern.test(candidate)).slice(0, 20)) {
    violations.push({ code: 'disabled_check', severity: 'high', evidence: line.slice(0, 4_000) });
  }
  const dependencyFiles = changedFiles.filter((file) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file));
  if (dependencyFiles.length && !input.dependencyChangeApproved) {
    for (const file of dependencyFiles) {
      violations.push({
        code: 'unjustified_dependency_change',
        severity: 'high',
        file,
        evidence: 'Dependency metadata changed without explicit approval.',
      });
    }
  }
  if (!input.publicApiChangeApproved) {
    const addedExports = new Set(addedLines.map(exportedSymbolFromDiffLine).filter((name): name is string => Boolean(name)));
    for (const line of removedLines.filter((candidate) => /^-\s*export\s+/.test(candidate)).slice(0, 20)) {
      const removedExport = exportedSymbolFromDiffLine(line);
      if (removedExport && addedExports.has(removedExport)) continue;
      violations.push({
        code: 'public_api_change',
        severity: 'high',
        evidence: `Exported API removal requires approval: ${line.slice(0, 3_500)}`,
      });
    }
  }
  const changedLineCount = addedLines.length + removedLines.length;
  const maxChangedLines = Math.max(20, input.maxChangedLines || 500);
  if (changedLineCount > maxChangedLines || changedFiles.length > 20) {
    violations.push({
      code: 'oversized_patch',
      severity: 'medium',
      evidence: `Patch changes ${changedLineCount} lines across ${changedFiles.length} files; bounded threshold is ${maxChangedLines} lines and 20 files.`,
    });
  }
  const verdict: MinimalPatchPolicyResult['verdict'] = violations.some((violation) => violation.severity === 'critical' || ['unrelated_file', 'deleted_test', 'disabled_check'].includes(violation.code))
    ? 'block'
    : violations.length
      ? 'review'
      : 'pass';
  return MinimalPatchPolicyResultSchema.parse({ verdict, violations, changedFiles, changedLineCount });
}

function extractFileMentions(request: string, index: RepositoryIndex): string[] {
  const indexed = new Set(index.files.map((file) => file.path));
  const matches = request.match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|sh|yaml|yml|toml|sql)/g) || [];
  return stableUnique(matches.map(normalizeRelative).filter((candidate) => indexed.has(candidate)));
}

function createValidationPlan(index: RepositoryIndex, impact: ChangeImpact): string[] {
  const plan: string[] = [];
  if (impact.relatedTests.length) plan.push(`Run targeted tests: ${impact.relatedTests.join(', ')}`);
  else plan.push('Run the narrowest package test command available and record that no direct test relationship was found.');
  if (index.packageScripts.typecheck) plan.push('Run typecheck.run.');
  if (index.packageScripts.lint) plan.push('Run lint.run against affected files or the package lint script.');
  if (index.packageScripts.test) plan.push('Run test.run after targeted validation.');
  if (impact.risk === 'high' || impact.changedFiles.some((file) => index.configFiles.includes(file))) {
    plan.push('Request remote build validation; do not force a full build on the VPS.');
  }
  return plan;
}

export async function prepareCodexExecution(input: {
  taskId?: string;
  runId?: string;
  sessionId?: string;
  request: string;
  workspaceRoot: string;
  acceptanceCriteria?: string[];
  forbiddenActions?: string[];
  changedFiles?: string[];
  forceFullIndex?: boolean;
}, store: RuntimeStore = getRuntimeStore()): Promise<PreparedCodexExecution> {
  const repository = await buildRepositoryIndex(input.workspaceRoot, { forceFull: input.forceFullIndex });
  const mentionedFiles = extractFileMentions(input.request, repository);
  const changedFiles = stableUnique(input.changedFiles?.length
    ? input.changedFiles
    : mentionedFiles.length
      ? mentionedFiles
      : repository.git.changedFiles);
  const impact = analyzeChangeImpact(repository, changedFiles);
  let state = input.taskId ? loadCodingTask(input.taskId, store) : undefined;
  if (!state) {
    state = createCodingTask({
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      request: input.request,
      workspaceRoot: repository.root,
      workspaceRevision: repository.revision,
      acceptanceCriteria: input.acceptanceCriteria,
      forbiddenActions: input.forbiddenActions,
      assumptions: changedFiles.length ? [] : ['No explicit target file was identified; repository evidence must narrow the scope before patching.'],
    }, store);
  } else if (input.runId && state.runId !== input.runId) {
    // A bounded automatic continuation creates a fresh Runtime run while
    // retaining the same durable coding task. Rebind the task to the current
    // run so abort/lease reconciliation targets the active execution rather
    // than the original pre-compaction run.
    state = updateCodingTask(state.taskId, { runId: input.runId }, store);
  }
  const validationPlan = createValidationPlan(repository, impact);
  if (state.currentPhase === 'understand') {
    state = transitionCodingTask(state.taskId, 'plan', {
      summary: 'Created a bounded execution plan from repository impact and available package validation scripts.',
      metadata: { impact, validationPlan },
    }, store);
  }
  const filesToInspect = stableUnique([
    ...impact.changedFiles,
    ...impact.directDependents,
    ...impact.relatedTests,
    ...repository.configFiles.slice(0, 8),
  ]).slice(0, 60);
  if (state.currentPhase === 'plan') {
    state = transitionCodingTask(state.taskId, 'inspect', {
      summary: 'Selected definitions, dependents, tests, and configuration files for deterministic inspection.',
      metadata: { filesToInspect },
    }, store);
  }
  state = updateCodingTask(state.taskId, {
    filesInspected: stableUnique([...state.filesInspected, ...filesToInspect]),
    unresolvedRisks: stableUnique([
      ...state.unresolvedRisks,
      ...impact.reasons.filter(() => impact.risk !== 'low'),
    ]),
  }, store);
  if (!state.checkpoints.length) {
    state = await createCodingCheckpoint(state.taskId, filesToInspect, {}, store);
  }
  return {
    state,
    repository,
    impact,
    validationPlan,
    context: `${renderRepositoryContext(repository, impact)}\nValidation plan:\n${validationPlan.map((entry) => `- ${entry}`).join('\n')}`,
  };
}

export async function recordCodexPatch(input: {
  taskId: string;
  changedFiles: string[];
  allowedFiles: string[];
  diff?: string;
  dependencyChangeApproved?: boolean;
  publicApiChangeApproved?: boolean;
}, store: RuntimeStore = getRuntimeStore()): Promise<{ state: CodingTaskState; policy: MinimalPatchPolicyResult }> {
  let state = loadCodingTask(input.taskId, store);
  if (!state) throw new Error(`Coding task not found: ${input.taskId}`);
  if (state.currentPhase === 'inspect') {
    state = transitionCodingTask(state.taskId, 'patch', {
      summary: 'Recorded the minimal candidate patch and evaluated deterministic scope policy.',
      metadata: { changedFiles: input.changedFiles },
    }, store);
  }
  if (state.currentPhase !== 'patch' && state.currentPhase !== 'revise') {
    throw new Error(`Cannot record patch while task is in ${state.currentPhase}`);
  }
  const diffResult = input.diff === undefined
    ? await runGovernedCommand('git', ['diff', '--no-ext-diff'], { cwd: state.workspaceRoot, timeoutMs: 20_000, maxOutputBytes: 8_000_000 })
    : undefined;
  const diff = input.diff ?? diffResult?.stdout ?? '';
  const policy = evaluateMinimalPatchPolicy({
    diff,
    changedFiles: input.changedFiles,
    allowedFiles: input.allowedFiles,
    dependencyChangeApproved: input.dependencyChangeApproved,
    publicApiChangeApproved: input.publicApiChangeApproved,
  });
  state = updateCodingTask(state.taskId, {
    filesChanged: stableUnique([...state.filesChanged, ...input.changedFiles]),
    unresolvedRisks: policy.verdict === 'pass'
      ? state.unresolvedRisks
      : stableUnique([...state.unresolvedRisks, ...policy.violations.map((violation) => violation.evidence)]),
    status: policy.verdict === 'block' ? 'blocked' : state.status,
  }, store);
  if (policy.verdict === 'block') {
    state = recordCodingFailure(state.taskId, {
      phase: state.currentPhase,
      category: 'policy',
      summary: 'Minimal patch policy blocked the candidate patch.',
      evidence: policy.violations.map((violation) => violation.evidence),
      recoverable: true,
    }, store);
  }
  return { state, policy };
}

function validationKindForTool(tool: CodexValidationTool['name'], stage: 'targeted' | 'full'): CodingValidation['kind'] {
  if (tool === 'typecheck.run') return 'typecheck';
  if (tool === 'lint.run') return 'lint';
  if (tool === 'build.run') return 'build';
  if (tool === 'json.validate' || tool === 'schema.validate') return 'schema';
  if (tool === 'secret.scan') return 'security';
  return stage === 'targeted' ? 'targeted_test' : 'package_test';
}

function defaultValidationTools(repository: RepositoryIndex, impact: ChangeImpact, stage: 'targeted' | 'full'): CodexValidationTool[] {
  const tools: CodexValidationTool[] = [];
  if (stage === 'targeted') {
    if (repository.packageScripts.test) {
      tools.push({
        name: 'test.run',
        input: impact.relatedTests.length ? { args: impact.relatedTests } : {},
      });
    }
    if (repository.packageScripts.typecheck) tools.push({ name: 'typecheck.run', input: {} });
    return tools;
  }
  if (repository.packageScripts.typecheck) tools.push({ name: 'typecheck.run', input: {} });
  if (repository.packageScripts.lint) tools.push({ name: 'lint.run', input: {} });
  if (repository.packageScripts.test) tools.push({ name: 'test.run', input: {} });
  if (repository.packageScripts.build) tools.push({ name: 'build.run', input: {} });
  return tools;
}

function toolFailureEvidence(evidence: ToolEvidence): string[] {
  const output: string[] = [evidence.summary];
  const stderr = typeof evidence.details.stderr === 'string' ? evidence.details.stderr : '';
  const stdout = typeof evidence.details.stdout === 'string' ? evidence.details.stdout : '';
  if (stderr) output.push(stderr.slice(0, 4_000));
  else if (stdout) output.push(stdout.slice(0, 4_000));
  if (evidence.artifactId) output.push(`Raw artifact: ${evidence.artifactId}`);
  return output;
}

export function buildCodingRevisionPacket(taskId: string, store: RuntimeStore = getRuntimeStore()): string {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  const latestFailure = state.failures.at(-1);
  const failedValidations = state.validations.filter((validation) => validation.status === 'failed').slice(-8);
  const recentTools = state.toolCalls.filter((call) => call.status !== 'success').slice(-8);
  return JSON.stringify({
    taskId: state.taskId,
    phase: state.currentPhase,
    candidateFiles: state.filesChanged,
    failedChecks: failedValidations.map((validation) => ({
      kind: validation.kind,
      summary: validation.summary,
      artifactId: validation.artifactId,
    })),
    latestFailure: latestFailure ? {
      category: latestFailure.category,
      summary: latestFailure.summary,
      evidence: latestFailure.evidence,
    } : undefined,
    failedTools: recentTools.map((call) => ({ tool: call.tool, summary: call.summary, artifactId: call.artifactId })),
    acceptanceCriteria: state.acceptanceCriteria,
    forbiddenActions: state.forbiddenActions,
    requiredCorrection: 'Fix only the failed checks using the smallest affected-file delta, then rerun targeted validation.',
  }, null, 2).slice(0, 16_000);
}

export function beginCodingRevision(taskId: string, store: RuntimeStore = getRuntimeStore()): { state: CodingTaskState; revisionPacket: string } {
  const state = loadCodingTask(taskId, store);
  if (!state) throw new Error(`Coding task not found: ${taskId}`);
  if (state.currentPhase !== 'analyze_failure') throw new Error(`Cannot begin revision while task is in ${state.currentPhase}`);
  const revisionPacket = buildCodingRevisionPacket(taskId, store);
  const revised = transitionCodingTask(taskId, 'revise', {
    summary: 'Compiled a delta-only revision packet from failed checks and preserved acceptance criteria.',
    metadata: { revisionPacketHash: crypto.createHash('sha256').update(revisionPacket).digest('hex') },
  }, store);
  return { state: revised, revisionPacket };
}

export async function runCodexValidationStage(input: {
  taskId: string;
  stage: 'targeted' | 'full';
  tools?: CodexValidationTool[];
  approvalGranted?: boolean;
  allowProduction?: boolean;
}, store: RuntimeStore = getRuntimeStore(), broker: ToolBroker = createDefaultToolBroker()): Promise<CodexValidationOutcome> {
  let state = loadCodingTask(input.taskId, store);
  if (!state) throw new Error(`Coding task not found: ${input.taskId}`);
  if (state.status !== 'active') throw new Error(`Coding task ${input.taskId} is ${state.status}`);

  if (input.stage === 'targeted') {
    if (state.currentPhase !== 'targeted_validation') {
      if (!['inspect', 'patch', 'revise'].includes(state.currentPhase)) {
        throw new Error(`Cannot start targeted validation while task is in ${state.currentPhase}`);
      }
      state = transitionCodingTask(state.taskId, 'targeted_validation', {
        summary: 'Started affected-file validation using deterministic Runtime tools.',
        metadata: {},
      }, store);
    }
  } else if (state.currentPhase !== 'full_validation') {
    if (state.currentPhase !== 'targeted_validation') {
      throw new Error(`Cannot start full validation while task is in ${state.currentPhase}`);
    }
    state = transitionCodingTask(state.taskId, 'full_validation', {
      summary: 'Targeted checks passed; started the full validation ladder.',
      metadata: {},
    }, store);
  }

  const repository = await buildRepositoryIndex(state.workspaceRoot);
  const impact = analyzeChangeImpact(repository, state.filesChanged.length ? state.filesChanged : undefined);
  const tools = input.tools || defaultValidationTools(repository, impact, input.stage);
  if (!tools.length) {
    const message = `No ${input.stage} validation tools are available from package scripts.`;
    state = recordCodingFailure(state.taskId, {
      phase: state.currentPhase,
      category: 'validation',
      summary: message,
      evidence: [],
      recoverable: true,
    }, store);
    state = transitionCodingTask(state.taskId, 'analyze_failure', { summary: message }, store);
    return { state, stage: input.stage, status: 'failed', evidence: [], revisionPacket: buildCodingRevisionPacket(state.taskId, store) };
  }

  const evidence: ToolEvidence[] = [];
  for (const tool of tools) {
    const result = await broker.execute(tool.name, tool.input, {
      cwd: state.workspaceRoot,
      approvalGranted: input.approvalGranted || false,
      allowProduction: input.allowProduction || false,
    });
    evidence.push(result);
    state = recordCodingToolCall(state.taskId, {
      tool: tool.name,
      status: result.status,
      summary: result.summary,
      artifactId: result.artifactId,
      durationMs: result.durationMs,
    }, store);
    state = recordCodingValidation(state.taskId, {
      kind: validationKindForTool(tool.name, input.stage),
      status: result.status === 'success'
        ? 'passed'
        : result.status === 'remote_required'
          ? 'remote_required'
          : result.status === 'blocked'
            ? 'skipped'
            : 'failed',
      summary: result.summary,
      artifactId: result.artifactId,
    }, store);
    if (result.status === 'failed' || result.status === 'blocked') break;
  }

  const failed = evidence.find((result) => result.status === 'failed' || result.status === 'blocked');
  if (failed) {
    state = recordCodingFailure(state.taskId, {
      phase: state.currentPhase,
      category: failed.status === 'blocked' ? 'policy' : 'validation',
      summary: failed.summary,
      evidence: toolFailureEvidence(failed),
      recoverable: true,
    }, store);
    state = transitionCodingTask(state.taskId, 'analyze_failure', {
      summary: `${input.stage} validation failed; compile a bounded revision from the failing evidence.`,
      metadata: { failedTool: failed.tool, artifactId: failed.artifactId },
    }, store);
    return {
      state,
      stage: input.stage,
      status: 'failed',
      evidence,
      revisionPacket: buildCodingRevisionPacket(state.taskId, store),
    };
  }

  const remote = evidence.find((result) => result.status === 'remote_required');
  if (remote) {
    state = updateCodingTask(state.taskId, {
      unresolvedRisks: stableUnique([...state.unresolvedRisks, `Remote validation pending: ${remote.summary}`]),
    }, store);
    return { state, stage: input.stage, status: 'remote_required', evidence };
  }

  if (input.stage === 'targeted') {
    state = transitionCodingTask(state.taskId, 'full_validation', {
      summary: 'All targeted checks passed; the task is ready for package-wide or remote validation.',
      metadata: { tools: evidence.map((result) => result.tool) },
    }, store);
    return { state, stage: input.stage, status: 'passed', evidence };
  }

  state = transitionCodingTask(state.taskId, 'summarize', {
    summary: 'All full validation checks passed; recorded final evidence and completed the coding task.',
    metadata: { tools: evidence.map((result) => result.tool) },
  }, store);
  return { state, stage: input.stage, status: 'passed', evidence };
}

export function recordRemoteValidationResult(input: {
  taskId: string;
  passed: boolean;
  summary: string;
  artifactId?: string;
}, store: RuntimeStore = getRuntimeStore()): CodingTaskState {
  let state = loadCodingTask(input.taskId, store);
  if (!state) throw new Error(`Coding task not found: ${input.taskId}`);
  if (state.currentPhase !== 'full_validation') throw new Error(`Remote validation cannot be recorded while task is in ${state.currentPhase}`);
  state = recordCodingValidation(state.taskId, {
    kind: 'remote',
    status: input.passed ? 'passed' : 'failed',
    summary: input.summary,
    artifactId: input.artifactId,
  }, store);
  if (input.passed) {
    return transitionCodingTask(state.taskId, 'summarize', {
      summary: 'Remote full validation passed; coding task completed with structured evidence.',
      metadata: { artifactId: input.artifactId },
    }, store);
  }
  state = recordCodingFailure(state.taskId, {
    phase: 'full_validation',
    category: 'validation',
    summary: input.summary,
    evidence: input.artifactId ? [`Raw artifact: ${input.artifactId}`] : [],
    recoverable: true,
  }, store);
  return transitionCodingTask(state.taskId, 'analyze_failure', {
    summary: 'Remote validation failed; prepare a bounded revision.',
    metadata: { artifactId: input.artifactId },
  }, store);
}
