import * as crypto from 'node:crypto';
import { z } from 'zod';
import { ContinuationCapsule } from './cognitive-task';
import { RouteDecision } from './zenos-runtime';
import {
  CommandJobRecord,
  CommandStepRecord,
  RuntimeStore,
  getRuntimeStore,
} from './zenos-runtime-store';

export const CommandJobStatusSchema = z.enum([
  'queued',
  'running',
  'paused_for_compaction',
  'waiting_for_approval',
  'retry_pending',
  'completed',
  'failed',
  'cancelled',
]);

export const CommandStepKindSchema = z.enum([
  'route',
  'inspect',
  'plan',
  'patch',
  'validate',
  'verify',
  'deliver',
]);

export const CommandStepStatusSchema = z.enum([
  'queued',
  'running',
  'done',
  'retry_pending',
  'blocked',
  'failed',
]);

export const TaskContractSchema = z.object({
  objective: z.string().trim().min(1).max(12_000),
  taskType: z.string().trim().min(1).max(120),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  workspaceRoot: z.string().trim().max(4_096).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  authority: z.object({
    mayInspect: z.boolean(),
    mayMutate: z.boolean(),
    mayValidate: z.boolean(),
    approvalRequired: z.boolean(),
  }),
});

export const JobBudgetSchema = z.object({
  maxCycles: z.number().int().min(1).max(100),
  maxModelCalls: z.number().int().min(1).max(200),
  maxTokens: z.number().int().min(1).max(10_000_000),
  deadlineMs: z.number().int().min(1_000).max(86_400_000).optional(),
});

export type TaskContract = z.infer<typeof TaskContractSchema>;
export type JobBudget = z.infer<typeof JobBudgetSchema>;
export type CommandJobStatus = z.infer<typeof CommandJobStatusSchema>;
export type CommandStepKind = z.infer<typeof CommandStepKindSchema>;
export type CommandStepStatus = z.infer<typeof CommandStepStatusSchema>;

function now(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function commandJobId(sessionId: string, cognitiveTaskId: string, requestHash: string): string {
  return `command_${stableHash({ sessionId, cognitiveTaskId, requestHash }).slice(0, 32)}`;
}

function requiredStepKinds(decision: RouteDecision): CommandStepKind[] {
  const kinds: CommandStepKind[] = ['route'];
  if (['repo_question', 'coding_change', 'debugging', 'security_or_secret', 'deploy_or_destructive_action'].includes(decision.taskType)) {
    kinds.push('inspect');
  }
  if (decision.taskType !== 'simple_chat') kinds.push('plan');
  if (['coding_change', 'deploy_or_destructive_action'].includes(decision.taskType)) kinds.push('patch');
  if (['repo_question', 'coding_change', 'debugging', 'deploy_or_destructive_action', 'eval_or_benchmark'].includes(decision.taskType)) {
    kinds.push('validate');
  }
  if (decision.useVerifier || decision.useBoss || decision.risk === 'high' || decision.risk === 'critical') kinds.push('verify');
  kinds.push('deliver');
  return [...new Set(kinds)];
}

function taskContractFrom(input: {
  capsule: ContinuationCapsule;
  decision: RouteDecision;
  workspaceRoot?: string;
}): TaskContract {
  return TaskContractSchema.parse({
    objective: input.capsule.rootObjective,
    taskType: input.decision.taskType,
    risk: input.decision.risk,
    workspaceRoot: input.workspaceRoot,
    acceptanceCriteria: input.capsule.acceptanceCriteria,
    constraints: input.capsule.constraints,
    authority: {
      mayInspect: input.decision.useTools,
      mayMutate: ['coding_change', 'deploy_or_destructive_action'].includes(input.decision.taskType),
      mayValidate: input.decision.useTools,
      approvalRequired: input.decision.requiresApproval,
    },
  });
}

function nextIncompleteStep(steps: CommandStepRecord[]): CommandStepRecord | undefined {
  return steps.find((step) => step.status !== 'done');
}

function saveJobWithActiveStep(
  store: RuntimeStore,
  job: CommandJobRecord,
  steps: CommandStepRecord[],
  status = job.status,
): CommandJobRecord {
  const active = nextIncompleteStep(steps);
  return store.saveCommandJob({
    ...job,
    status,
    activeStepId: active?.stepId,
    updatedAt: now(),
  });
}

export function ensureCommandJob(input: {
  sessionId: string;
  userTurnId: string;
  requestHash: string;
  capsule: ContinuationCapsule;
  decision: RouteDecision;
  workspaceRoot?: string;
  budget: JobBudget;
  checkpointId?: string;
  store?: RuntimeStore;
}): { job: CommandJobRecord; steps: CommandStepRecord[]; created: boolean } {
  const store = input.store || getRuntimeStore();
  const byTask = store.findCommandJobByCognitiveTask(input.capsule.taskId);
  const byTurn = store.findCommandJob(input.sessionId, input.userTurnId, input.requestHash);
  const existing = byTask || byTurn;
  if (existing) {
    const updated = store.saveCommandJob({
      ...existing,
      checkpointId: input.checkpointId || existing.checkpointId,
      cognitiveTaskId: input.capsule.taskId,
      taskContract: taskContractFrom(input),
      budget: JobBudgetSchema.parse(input.budget),
      updatedAt: now(),
    });
    const resumed = ['queued', 'paused_for_compaction', 'retry_pending'].includes(updated.status)
      ? resumeCommandJob({ jobId: updated.jobId, checkpointId: input.checkpointId, store })
      : updated;
    return { job: resumed, steps: store.listCommandSteps(resumed.jobId), created: false };
  }

  const timestamp = now();
  const taskContract = taskContractFrom(input);
  const jobId = commandJobId(input.sessionId, input.capsule.taskId, input.requestHash);
  const kinds = requiredStepKinds(input.decision);
  const job: CommandJobRecord = {
    jobId,
    sessionId: input.sessionId,
    userTurnId: input.userTurnId,
    requestHash: input.requestHash,
    taskContract,
    status: input.decision.requiresApproval ? 'waiting_for_approval' : 'running',
    checkpointId: input.checkpointId,
    activeStepId: `${jobId}:step:0:route`,
    budget: JobBudgetSchema.parse(input.budget),
    cognitiveTaskId: input.capsule.taskId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.saveCommandJob(job);
  const steps = kinds.map((kind, ordinal): CommandStepRecord => ({
    stepId: `${jobId}:step:${ordinal}:${kind}`,
    jobId,
    ordinal,
    kind,
    inputHash: stableHash({
      kind,
      objective: taskContract.objective,
      workspaceRoot: taskContract.workspaceRoot,
      acceptanceCriteria: taskContract.acceptanceCriteria,
    }),
    status: kind === 'route' ? 'running' : 'queued',
    retryCount: 0,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  for (const step of steps) store.saveCommandStep(step);
  return { job, steps, created: true };
}

export function transitionCommandStep(input: {
  jobId: string;
  kind: CommandStepKind;
  status: CommandStepStatus;
  resultRef?: string;
  metadata?: Record<string, unknown>;
  incrementRetry?: boolean;
  store?: RuntimeStore;
}): { job: CommandJobRecord; step: CommandStepRecord; steps: CommandStepRecord[] } {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  const steps = store.listCommandSteps(input.jobId);
  const current = steps.find((step) => step.kind === input.kind);
  if (!current) throw new Error(`CommandJob step not found: ${input.kind}`);
  const predecessors = steps.filter((step) => step.ordinal < current.ordinal);
  if (['running', 'done'].includes(input.status) && predecessors.some((step) => step.status !== 'done')) {
    throw new Error(`CommandJob step ${input.kind} cannot run before its predecessors are committed`);
  }
  const timestamp = now();
  const updated = store.saveCommandStep({
    ...current,
    status: input.status,
    resultRef: input.resultRef || current.resultRef,
    retryCount: current.retryCount + (input.incrementRetry ? 1 : 0),
    metadata: {
      ...(current.metadata && typeof current.metadata === 'object' ? current.metadata as Record<string, unknown> : {}),
      ...(input.metadata || {}),
    },
    updatedAt: timestamp,
  });
  const nextSteps = steps.map((step) => step.stepId === updated.stepId ? updated : step);
  let jobStatus = job.status;
  if (input.status === 'failed') jobStatus = 'failed';
  else if (input.status === 'blocked') jobStatus = 'waiting_for_approval';
  else if (input.status === 'retry_pending') jobStatus = 'retry_pending';
  else if (nextSteps.every((step) => step.status === 'done')) jobStatus = 'completed';
  else if (!['waiting_for_approval', 'paused_for_compaction'].includes(jobStatus)) jobStatus = 'running';
  const updatedJob = saveJobWithActiveStep(store, job, nextSteps, jobStatus);
  return { job: updatedJob, step: updated, steps: nextSteps };
}

export function synchronizeCommandJobPreflight(input: {
  jobId: string;
  routeRef: string;
  repositoryContext?: string;
  planRef?: string;
  mutationExpected: boolean;
  approvalRequired: boolean;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  let steps = store.listCommandSteps(input.jobId);
  const complete = (kind: CommandStepKind, resultRef?: string, metadata?: Record<string, unknown>) => {
    const step = steps.find((item) => item.kind === kind);
    if (!step || step.status === 'done') return;
    // Never advance a step while an earlier ordinal is still open. Preflight used
    // to complete `plan` whenever planRef existed even if `inspect` stayed queued
    // because repositoryContext was empty — that threw and 500'd gateway preflight.
    const predecessors = steps.filter((item) => item.ordinal < step.ordinal);
    if (predecessors.some((item) => item.status !== 'done')) return;
    transitionCommandStep({ jobId: input.jobId, kind, status: 'done', resultRef, metadata, store });
    steps = store.listCommandSteps(input.jobId);
  };
  complete('route', input.routeRef);

  const inspect = steps.find((step) => step.kind === 'inspect');
  if (inspect && inspect.status !== 'done') {
    const repoContext = typeof input.repositoryContext === 'string' ? input.repositoryContext.trim() : '';
    if (repoContext) {
      complete('inspect', `repo:${stableHash(repoContext).slice(0, 24)}`, {
        repositoryContextAvailable: true,
      });
    } else {
      // Keep the pipeline moving: missing inspect evidence must not block plan
      // commit or fail-closed the whole Hermes turn with HTTP 500.
      complete('inspect', 'repo:unavailable', {
        repositoryContextAvailable: false,
        deferred: true,
      });
    }
  }

  if (steps.some((step) => step.kind === 'plan') && input.planRef) {
    complete('plan', input.planRef);
  }

  steps = store.listCommandSteps(input.jobId);
  const patch = steps.find((step) => step.kind === 'patch');
  if (patch && patch.status === 'queued' && input.mutationExpected && !input.approvalRequired) {
    const predecessors = steps.filter((step) => step.ordinal < patch.ordinal);
    if (predecessors.every((step) => step.status === 'done')) {
      transitionCommandStep({ jobId: input.jobId, kind: 'patch', status: 'running', store });
    }
  }
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found after preflight sync: ${input.jobId}`);
  if (input.approvalRequired) {
    return store.saveCommandJob({ ...job, status: 'waiting_for_approval', updatedAt: now() });
  }
  return job;
}

export function resumeCommandJob(input: {
  jobId: string;
  checkpointId?: string;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  if (!['queued', 'paused_for_compaction', 'retry_pending'].includes(job.status)) return job;
  const steps = store.listCommandSteps(input.jobId);
  const active = steps.find((step) => step.status !== 'done');
  if (active && active.status === 'retry_pending') {
    store.saveCommandStep({
      ...active,
      status: 'running',
      metadata: {
        ...(active.metadata && typeof active.metadata === 'object' ? active.metadata as Record<string, unknown> : {}),
        resumedAt: now(),
        resumedFromCheckpoint: input.checkpointId || job.checkpointId,
      },
      updatedAt: now(),
    });
  }
  return store.saveCommandJob({
    ...job,
    status: 'running',
    checkpointId: input.checkpointId || job.checkpointId,
    activeStepId: active?.stepId,
    updatedAt: now(),
  });
}

export function pauseCommandJob(input: {
  jobId: string;
  reason: string;
  checkpointId?: string;
  retryPending?: boolean;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  const active = job.activeStepId ? store.getCommandStep(job.activeStepId) : undefined;
  if (active && active.status === 'running') {
    store.saveCommandStep({
      ...active,
      status: 'retry_pending',
      retryCount: active.retryCount + 1,
      metadata: {
        ...(active.metadata && typeof active.metadata === 'object' ? active.metadata as Record<string, unknown> : {}),
        pauseReason: input.reason,
      },
      updatedAt: now(),
    });
  }
  return store.saveCommandJob({
    ...job,
    checkpointId: input.checkpointId || job.checkpointId,
    status: input.retryPending ? 'retry_pending' : 'paused_for_compaction',
    updatedAt: now(),
  });
}

export function completeCommandJob(input: {
  jobId: string;
  resultRef?: string;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const steps = store.listCommandSteps(input.jobId);
  const deliver = steps.find((step) => step.kind === 'deliver');
  if (!deliver) throw new Error(`CommandJob deliver step not found: ${input.jobId}`);
  const uncommittedEvidence = steps.filter((step) => step.kind !== 'deliver' && step.status !== 'done');
  if (uncommittedEvidence.length) {
    throw new Error(`Cannot complete CommandJob before evidence steps commit: ${uncommittedEvidence.map((step) => step.kind).join(', ')}`);
  }
  if (deliver.status !== 'done') {
    transitionCommandStep({
      jobId: input.jobId,
      kind: 'deliver',
      status: 'done',
      resultRef: input.resultRef,
      store,
    });
  }
  const completed = store.getCommandJob(input.jobId);
  if (!completed) throw new Error(`CommandJob not found after completion: ${input.jobId}`);
  return store.saveCommandJob({ ...completed, status: 'completed', activeStepId: undefined, updatedAt: now() });
}

export function synchronizeCommandJobPostflight(input: {
  jobId: string;
  mutationObserved: boolean;
  deterministicValidation: 'passed' | 'failed' | 'unknown';
  verifierVerdict?: string;
  bossVerdict?: string;
  continuationReason?: string;
  waitingForUser?: boolean;
  terminalFailure?: boolean;
  blocked?: boolean;
  resultRef?: string;
  checkpointId?: string;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  if (input.terminalFailure || input.blocked) {
    return failCommandJob({
      jobId: input.jobId,
      reason: input.terminalFailure ? 'Runtime postflight reached a terminal failure' : 'Verifier or Boss blocked delivery',
      store,
    });
  }

  const step = (kind: CommandStepKind) => store.listCommandSteps(input.jobId).find((item) => item.kind === kind);
  const commit = (kind: CommandStepKind, resultRef: string, metadata: Record<string, unknown> = {}) => {
    const current = step(kind);
    if (!current || current.status === 'done') return;
    transitionCommandStep({ jobId: input.jobId, kind, status: 'done', resultRef, metadata, store });
  };

  const patch = step('patch');
  if (patch && patch.status !== 'done' && input.mutationObserved) {
    commit('patch', input.resultRef || 'workspace-mutation-observed', { mutationObserved: true });
  }
  const validate = step('validate');
  if (validate && validate.status !== 'done' && input.deterministicValidation === 'passed') {
    commit('validate', input.resultRef || 'deterministic-validation', { deterministicValidation: 'passed' });
  }

  if (input.continuationReason) {
    const active = store.getCommandJob(input.jobId)?.activeStepId;
    const activeRecord = active ? store.getCommandStep(active) : undefined;
    if (activeRecord && activeRecord.status !== 'done') {
      store.saveCommandStep({
        ...activeRecord,
        status: 'retry_pending',
        retryCount: activeRecord.retryCount + 1,
        metadata: {
          ...(activeRecord.metadata && typeof activeRecord.metadata === 'object' ? activeRecord.metadata as Record<string, unknown> : {}),
          continuationReason: input.continuationReason,
        },
        updatedAt: now(),
      });
    }
    return pauseCommandJob({
      jobId: input.jobId,
      reason: input.continuationReason,
      checkpointId: input.checkpointId,
      retryPending: true,
      store,
    });
  }

  if (input.waitingForUser) {
    const active = store.getCommandJob(input.jobId)?.activeStepId;
    const activeRecord = active ? store.getCommandStep(active) : undefined;
    if (activeRecord && activeRecord.status !== 'done') {
      store.saveCommandStep({
        ...activeRecord,
        status: 'blocked',
        metadata: {
          ...(activeRecord.metadata && typeof activeRecord.metadata === 'object' ? activeRecord.metadata as Record<string, unknown> : {}),
          blockedOn: 'user_input_or_approval',
        },
        updatedAt: now(),
      });
    }
    const waiting = store.getCommandJob(input.jobId);
    if (!waiting) throw new Error(`CommandJob not found after blocking: ${input.jobId}`);
    return store.saveCommandJob({ ...waiting, status: 'waiting_for_approval', updatedAt: now() });
  }

  const currentPatch = step('patch');
  if (currentPatch && currentPatch.status !== 'done') {
    commit('patch', input.resultRef || 'no-op-or-prior-mutation-accepted', {
      mutationObserved: input.mutationObserved,
      noOpAcceptedByTerminalTaskState: !input.mutationObserved,
    });
  }
  const currentValidate = step('validate');
  if (currentValidate && currentValidate.status !== 'done') {
    const contract = TaskContractSchema.safeParse(job.taskContract);
    const nonMutatingInspection = !input.mutationObserved
      && contract.success
      && ['repo_question', 'planning_or_architecture', 'summarization'].includes(contract.data.taskType);
    const noMutationObserved = !input.mutationObserved;
    if (!nonMutatingInspection && !noMutationObserved) {
      throw new Error(`CommandJob validation evidence is not committed (${input.deterministicValidation})`);
    }
    commit(
      'validate',
      nonMutatingInspection
        ? 'validation-not-required-for-non-mutating-inspection'
        : 'validation-not-required-without-workspace-mutation',
      {
        deterministicValidation: input.deterministicValidation,
        skippedByPolicy: true,
        noMutationObserved,
      },
    );
  }
  const verify = step('verify');
  if (verify && verify.status !== 'done') {
    const verificationPassed = input.verifierVerdict === 'pass' || input.bossVerdict === 'approve';
    const deterministicSubstitute = input.deterministicValidation === 'passed'
      && input.verifierVerdict !== 'block'
      && input.bossVerdict !== 'block';
    if (!verificationPassed && !deterministicSubstitute) {
      throw new Error('CommandJob verification evidence is not committed');
    }
    commit('verify', verificationPassed ? 'model-verification' : 'deterministic-verification-substitute', {
      verifierVerdict: input.verifierVerdict,
      bossVerdict: input.bossVerdict,
      deterministicSubstitute,
    });
  }
  return completeCommandJob({ jobId: input.jobId, resultRef: input.resultRef, store });
}

export function cancelCommandJob(input: {
  jobId: string;
  reason: string;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  const timestamp = now();
  for (const step of store.listCommandSteps(input.jobId)) {
    if (step.status === 'done') continue;
    store.saveCommandStep({
      ...step,
      status: 'blocked',
      metadata: {
        ...(step.metadata && typeof step.metadata === 'object' ? step.metadata as Record<string, unknown> : {}),
        cancelled: true,
        cancellationReason: input.reason,
      },
      updatedAt: timestamp,
    });
  }
  return store.saveCommandJob({
    ...job,
    status: 'cancelled',
    activeStepId: undefined,
    updatedAt: timestamp,
  });
}

export function failCommandJob(input: {
  jobId: string;
  reason: string;
  store?: RuntimeStore;
}): CommandJobRecord {
  const store = input.store || getRuntimeStore();
  const job = store.getCommandJob(input.jobId);
  if (!job) throw new Error(`CommandJob not found: ${input.jobId}`);
  const active = job.activeStepId ? store.getCommandStep(job.activeStepId) : undefined;
  if (active && active.status !== 'done') {
    store.saveCommandStep({
      ...active,
      status: 'failed',
      metadata: {
        ...(active.metadata && typeof active.metadata === 'object' ? active.metadata as Record<string, unknown> : {}),
        failureReason: input.reason,
      },
      updatedAt: now(),
    });
  }
  return store.saveCommandJob({ ...job, status: 'failed', updatedAt: now() });
}
