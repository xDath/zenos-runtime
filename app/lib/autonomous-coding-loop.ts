import { z } from 'zod';
import {
  beginCodingRevision,
  CodingTaskState,
  loadCodingTask,
  PreparedCodexExecution,
  recordCodingToolCall,
  recordCodexPatch,
  rollbackCodingCheckpoint,
  runCodexValidationStage,
  updateCodingTask,
} from './codex-execution-core';
import { recordWorkerEvent } from './zenos-runtime-three-agent';
import { createDefaultToolBroker, ToolBroker, ToolEvidence } from './tool-broker';

const AutonomousPlanSchema = z.object({
  summary: z.string().min(1).max(8_000),
  filesToInspect: z.array(z.string().min(1).max(4_096)).max(16).default([]),
  searchQueries: z.array(z.string().min(1).max(512)).max(8).default([]),
  plannedChanges: z.array(z.object({
    path: z.string().min(1).max(4_096),
    rationale: z.string().min(1).max(4_000),
  })).max(12).default([]),
  validationFocus: z.array(z.string().min(1).max(4_000)).max(12).default([]),
  assumptions: z.array(z.string().min(1).max(4_000)).max(12).default([]),
});
export type AutonomousPlan = z.infer<typeof AutonomousPlanSchema>;

const AutonomousPatchSchema = z.object({
  summary: z.string().min(1).max(8_000),
  patches: z.array(z.object({
    path: z.string().min(1).max(4_096),
    expectedHash: z.string().length(64).optional(),
    replacements: z.array(z.object({
      oldText: z.string().min(1).max(250_000),
      newText: z.string().max(250_000),
    })).min(1).max(30),
  })).max(8).default([]),
  assumptions: z.array(z.string().min(1).max(4_000)).max(12).default([]),
  noChangeReason: z.string().max(8_000).optional(),
});
export type AutonomousPatch = z.infer<typeof AutonomousPatchSchema>;

export type AutonomousModelResult = {
  ok: boolean;
  role: 'worker' | 'host' | 'verifier' | 'boss';
  model: string;
  provider: string;
  content?: string;
  parsed?: unknown;
  usage: {
    inputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
    accountedTokens: number;
    estimated: boolean;
    source: 'provider' | 'estimate' | 'hermes-session-delta';
    valid: boolean;
    invalidReason?: string;
    providerRequestId?: string;
  };
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  latencyMs: number;
  attempts: number;
  requestId: string;
  finishReason?: string;
  error?: string;
};

export type AutonomousModelInvoker = (input: {
  stage: 'plan' | 'patch' | 'revise';
  system: string;
  user: string;
  maxTokens: number;
  requestId: string;
}) => Promise<AutonomousModelResult>;

export type AutonomousCodingStatus =
  | 'planned'
  | 'blocked'
  | 'no_change'
  | 'validation_failed'
  | 'remote_required'
  | 'completed'
  | 'failed';

export type AutonomousCodingOutcome = {
  status: AutonomousCodingStatus;
  task: CodingTaskState;
  plan?: AutonomousPlan;
  patches: AutonomousPatch[];
  modelCalls: AutonomousModelResult[];
  toolEvidence: ToolEvidence[];
  hostUpdates: string[];
  summary: string;
  error?: string;
};

type FileEvidence = {
  path: string;
  hash: string;
  startLine: number;
  endLine: number;
  content: string;
};

function stableUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function emitProgress(
  sessionId: string | undefined,
  role: 'host' | 'worker' | 'verifier' | 'boss' | 'tool',
  summary: string,
  metadata: Record<string, unknown> = {},
  type: 'progress' | 'tool_result' | 'done' | 'error' = 'progress',
): void {
  if (!sessionId) return;
  try {
    const { usage, ...eventMetadata } = metadata;
    recordWorkerEvent({
      sessionId,
      workerId: `runtime-${role}`,
      type: type === 'error' ? 'progress' : type,
      summary,
      evidence: [],
      severity: 'low',
      confidence: 1,
      needsBoss: false,
      metadata: { role, outcome: type, ...eventMetadata, ...(usage ? { modelUsage: usage } : {}) },
    });
  } catch {
    // Progress reporting must never break the execution path.
  }
}

function hostUpdate(out: string[], sessionId: string | undefined, summary: string, metadata: Record<string, unknown> = {}): void {
  out.push(summary);
  emitProgress(sessionId, 'host', summary, metadata);
}

function parsePlan(result: AutonomousModelResult): AutonomousPlan {
  if (!result.ok || result.parsed === undefined || result.parsed === null) {
    throw new Error(result.error || 'Worker planner returned no structured plan');
  }
  return AutonomousPlanSchema.parse(result.parsed);
}

function parsePatch(result: AutonomousModelResult): AutonomousPatch {
  if (!result.ok || result.parsed === undefined || result.parsed === null) {
    throw new Error(result.error || 'Worker patcher returned no structured patch');
  }
  return AutonomousPatchSchema.parse(result.parsed);
}

function boundedJson(value: unknown, maxChars = 100_000): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

async function inspectFiles(input: {
  prepared: PreparedCodexExecution;
  plan: AutonomousPlan;
  broker: ToolBroker;
  approvalGranted: boolean;
  sessionId?: string;
  evidence: ToolEvidence[];
}): Promise<FileEvidence[]> {
  const indexedFiles = new Set(input.prepared.repository.files.map((file) => file.path));
  const requested = stableUnique([
    ...input.plan.filesToInspect,
    ...input.plan.plannedChanges.map((change) => change.path),
    ...input.prepared.state.filesInspected,
  ]).filter((file) => indexedFiles.has(file)).slice(0, 12);

  const files: FileEvidence[] = [];
  for (const file of requested) {
    const result = await input.broker.execute('repo.read', {
      path: file,
      startLine: 1,
      endLine: 4_000,
      maxBytes: 300_000,
    }, {
      cwd: input.prepared.repository.root,
      approvalGranted: input.approvalGranted,
      allowProduction: false,
    });
    input.evidence.push(result);
    emitProgress(input.sessionId, 'tool', result.summary, { tool: result.tool, status: result.status }, 'tool_result');
    if (result.status !== 'success') continue;
    const content = typeof result.details.rawContent === 'string'
      ? result.details.rawContent
      : typeof result.details.content === 'string'
        ? result.details.content
        : '';
    const hash = typeof result.details.hash === 'string' ? result.details.hash : '';
    const startLine = typeof result.details.startLine === 'number' ? result.details.startLine : 1;
    const endLine = typeof result.details.endLine === 'number' ? result.details.endLine : startLine;
    files.push({ path: file, hash, startLine, endLine, content });
  }

  for (const query of input.plan.searchQueries.slice(0, 6)) {
    const result = await input.broker.execute('repo.search', { query, limit: 30 }, {
      cwd: input.prepared.repository.root,
      approvalGranted: input.approvalGranted,
      allowProduction: false,
    });
    input.evidence.push(result);
    emitProgress(input.sessionId, 'tool', result.summary, { tool: result.tool, status: result.status, query }, 'tool_result');
  }
  return files;
}

function allowedPatchFiles(prepared: PreparedCodexExecution, plan: AutonomousPlan, inspected: FileEvidence[]): string[] {
  return stableUnique([
    ...inspected.map((file) => file.path),
    ...plan.plannedChanges.map((change) => change.path),
    ...prepared.impact.changedFiles,
    ...prepared.impact.directDependents,
    ...prepared.impact.relatedTests,
  ]);
}

async function applyPatchCandidate(input: {
  candidate: AutonomousPatch;
  prepared: PreparedCodexExecution;
  plan: AutonomousPlan;
  inspected: FileEvidence[];
  broker: ToolBroker;
  approvalGranted: boolean;
  sessionId?: string;
  evidence: ToolEvidence[];
}): Promise<{ changedFiles: string[]; task: CodingTaskState; blocked: boolean }> {
  const allowed = new Set(allowedPatchFiles(input.prepared, input.plan, input.inspected));
  const changedFiles: string[] = [];
  let task = loadCodingTask(input.prepared.state.taskId) || input.prepared.state;

  for (const patch of input.candidate.patches) {
    if (!allowed.has(patch.path)) {
      throw new Error(`Autonomous patch attempted an uninspected or unrelated file: ${patch.path}`);
    }
    const result = await input.broker.execute('repo.patch', {
      path: patch.path,
      expectedHash: patch.expectedHash,
      replacements: patch.replacements,
      dryRun: false,
    }, {
      cwd: input.prepared.repository.root,
      approvalGranted: input.approvalGranted,
      allowProduction: false,
    });
    input.evidence.push(result);
    task = recordCodingToolCall(task.taskId, {
      tool: result.tool,
      status: result.status,
      summary: result.summary,
      artifactId: result.artifactId,
      durationMs: result.durationMs,
    });
    emitProgress(input.sessionId, 'tool', result.summary, {
      tool: result.tool,
      status: result.status,
      path: patch.path,
      artifactId: result.artifactId,
    }, result.status === 'success' ? 'tool_result' : 'error');
    if (result.status !== 'success') throw new Error(result.summary);
    if (result.details.changed === true) changedFiles.push(patch.path);
  }

  if (!changedFiles.length) return { changedFiles: [], task, blocked: false };
  const recorded = await recordCodexPatch({
    taskId: task.taskId,
    changedFiles,
    allowedFiles: [...allowed],
  });
  task = recorded.state;
  if (recorded.policy.verdict === 'block') {
    const checkpoint = task.checkpoints.at(-1);
    if (checkpoint) task = rollbackCodingCheckpoint(task.taskId, checkpoint.checkpointId, { approvalGranted: true }).state;
    return { changedFiles, task, blocked: true };
  }
  return { changedFiles, task, blocked: false };
}

function planPrompt(prepared: PreparedCodexExecution): { system: string; user: string } {
  return {
    system: `You are the bounded coding planner Worker inside Etla Runtime.
Return only JSON matching this contract:
{
  "summary": "bounded plan",
  "filesToInspect": ["repo/relative/file"],
  "searchQueries": ["exact symbol or phrase"],
  "plannedChanges": [{"path":"repo/relative/file","rationale":"why"}],
  "validationFocus": ["check"],
  "assumptions": ["explicit assumption"]
}
Select the smallest relevant scope. Do not invent files. Do not propose disabling checks, deleting tests, adding dependencies, or changing public APIs without explicit evidence.`,
    user: `User request:\n${prepared.state.request}\n\nRepository packet:\n${prepared.context}\n\nAcceptance criteria:\n${prepared.state.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\nForbidden actions:\n${prepared.state.forbiddenActions.map((item) => `- ${item}`).join('\n')}`,
  };
}

function patchPrompt(input: {
  prepared: PreparedCodexExecution;
  plan: AutonomousPlan;
  inspected: FileEvidence[];
  revisionPacket?: string;
}): { system: string; user: string } {
  return {
    system: `You are the bounded patch Worker inside Etla Runtime.
Return only JSON matching this contract:
{
  "summary": "what the patch changes",
  "patches": [{
    "path": "an inspected repo-relative file",
    "expectedHash": "64-char hash from evidence",
    "replacements": [{"oldText":"exact unique current text","newText":"replacement"}]
  }],
  "assumptions": [],
  "noChangeReason": "only when no safe patch can be produced"
}
Use exact unique replacements copied from the supplied current file evidence. Make the smallest patch. Never use ellipses in oldText. Do not touch uninspected files, disable checks, delete tests, add dependencies, or broaden scope.`,
    user: `User request:\n${input.prepared.state.request}\n\nPlan:\n${boundedJson(input.plan, 20_000)}\n\n${input.revisionPacket ? `Revision packet:\n${input.revisionPacket}\n\n` : ''}Current file evidence:\n${boundedJson(input.inspected, 120_000)}\n\nAcceptance criteria:\n${input.prepared.state.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\nForbidden actions:\n${input.prepared.state.forbiddenActions.map((item) => `- ${item}`).join('\n')}`,
  };
}

export async function runAutonomousCodingLoop(input: {
  prepared: PreparedCodexExecution;
  invokeModel: AutonomousModelInvoker;
  approvalGranted: boolean;
  maxRevisions?: number;
  broker?: ToolBroker;
  requestIdPrefix: string;
}): Promise<AutonomousCodingOutcome> {
  const broker = input.broker || createDefaultToolBroker();
  const maxRevisions = Math.max(0, Math.min(input.maxRevisions ?? 2, 3));
  const modelCalls: AutonomousModelResult[] = [];
  const toolEvidence: ToolEvidence[] = [];
  const hostUpdates: string[] = [];
  const patches: AutonomousPatch[] = [];
  const sessionId = input.prepared.state.sessionId;
  let task = input.prepared.state;
  let plan: AutonomousPlan | undefined;

  try {
    hostUpdate(hostUpdates, sessionId, `Host opened coding task ${task.taskId} and requested a bounded Worker plan.`, {
      taskId: task.taskId,
      phase: task.currentPhase,
    });
    const planMessages = planPrompt(input.prepared);
    const planCall = await input.invokeModel({
      stage: 'plan',
      ...planMessages,
      maxTokens: 1_800,
      requestId: `${input.requestIdPrefix}:coding-plan`,
    });
    modelCalls.push(planCall);
    emitProgress(sessionId, 'worker', planCall.ok
      ? `Worker ${planCall.model} produced a structured coding plan.`
      : `Worker ${planCall.model || 'unknown'} failed to produce a coding plan.`, {
      stage: 'plan', model: planCall.model, provider: planCall.provider, usage: planCall.usage,
    }, planCall.ok ? 'progress' : 'error');
    plan = parsePlan(planCall);
    task = updateCodingTask(task.taskId, {
      assumptions: stableUnique([...task.assumptions, ...plan.assumptions]),
      tokenUsage: {
        input: task.tokenUsage.input + planCall.usage.inputTokens,
        output: task.tokenUsage.output + planCall.usage.outputTokens,
        estimatedCost: task.tokenUsage.estimatedCost,
      },
    });

    const inspected = await inspectFiles({
      prepared: input.prepared,
      plan,
      broker,
      approvalGranted: input.approvalGranted,
      sessionId,
      evidence: toolEvidence,
    });
    hostUpdate(hostUpdates, sessionId, `Host verified ${inspected.length} file snapshot(s) and ${plan.searchQueries.length} search request(s) before mutation.`, {
      taskId: task.taskId,
      inspectedFiles: inspected.map((file) => file.path),
    });

    if (!input.approvalGranted) {
      hostUpdate(hostUpdates, sessionId, 'Host stopped before repo.patch because local write approval was not granted.', {
        taskId: task.taskId,
        approvalRequired: true,
      });
      return {
        status: 'planned',
        task: loadCodingTask(task.taskId) || task,
        plan,
        patches,
        modelCalls,
        toolEvidence,
        hostUpdates,
        summary: 'Plan and inspection completed; mutation is waiting for explicit approval.',
      };
    }

    if (!inspected.length) throw new Error('No bounded file evidence was available for patch generation');

    let revisionPacket: string | undefined;
    for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
      const currentEvidence = attempt === 0
        ? inspected
        : await inspectFiles({
            prepared: input.prepared,
            plan,
            broker,
            approvalGranted: input.approvalGranted,
            sessionId,
            evidence: toolEvidence,
          });
      const patchMessages = patchPrompt({ prepared: input.prepared, plan, inspected: currentEvidence, revisionPacket });
      const patchCall = await input.invokeModel({
        stage: attempt === 0 ? 'patch' : 'revise',
        ...patchMessages,
        maxTokens: 4_000,
        requestId: `${input.requestIdPrefix}:coding-${attempt === 0 ? 'patch' : `revision-${attempt}`}`,
      });
      modelCalls.push(patchCall);
      emitProgress(sessionId, 'worker', patchCall.ok
        ? `Worker ${patchCall.model} produced patch candidate ${attempt + 1}.`
        : `Worker patch candidate ${attempt + 1} failed.`, {
        stage: attempt === 0 ? 'patch' : 'revise', model: patchCall.model, provider: patchCall.provider, usage: patchCall.usage,
      }, patchCall.ok ? 'progress' : 'error');
      const candidate = parsePatch(patchCall);
      patches.push(candidate);
      task = updateCodingTask(task.taskId, {
        assumptions: stableUnique([...task.assumptions, ...candidate.assumptions]),
        tokenUsage: {
          input: task.tokenUsage.input + patchCall.usage.inputTokens,
          output: task.tokenUsage.output + patchCall.usage.outputTokens,
          estimatedCost: task.tokenUsage.estimatedCost,
        },
      });
      if (!candidate.patches.length) {
        if (task.filesChanged.length) {
          const checkpoint = task.checkpoints.at(-1);
          if (checkpoint) {
            task = rollbackCodingCheckpoint(task.taskId, checkpoint.checkpointId, { approvalGranted: true }).state;
            hostUpdate(hostUpdates, sessionId, 'Host restored the checkpoint because the revision Worker produced no corrective patch.', {
              taskId: task.taskId,
              checkpointId: checkpoint.checkpointId,
            });
          }
        }
        return {
          status: 'no_change',
          task,
          plan,
          patches,
          modelCalls,
          toolEvidence,
          hostUpdates,
          summary: candidate.noChangeReason || 'Worker found no safe bounded patch.',
        };
      }

      const applied = await applyPatchCandidate({
        candidate,
        prepared: input.prepared,
        plan,
        inspected: currentEvidence,
        broker,
        approvalGranted: input.approvalGranted,
        sessionId,
        evidence: toolEvidence,
      });
      task = applied.task;
      if (applied.blocked) {
        hostUpdate(hostUpdates, sessionId, 'Host rejected the candidate through minimal-patch policy and rolled back the checkpoint.', {
          taskId: task.taskId,
          changedFiles: applied.changedFiles,
        });
        return {
          status: 'blocked', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
          summary: 'Minimal-patch policy blocked and rolled back the candidate.',
        };
      }

      hostUpdate(hostUpdates, sessionId, `Host confirmed repo.patch changed ${applied.changedFiles.length} file(s); targeted validation started.`, {
        taskId: task.taskId,
        changedFiles: applied.changedFiles,
      });
      const targeted = await runCodexValidationStage({
        taskId: task.taskId,
        stage: 'targeted',
        approvalGranted: input.approvalGranted,
      }, undefined, broker);
      task = targeted.state;
      toolEvidence.push(...targeted.evidence);
      emitProgress(sessionId, 'verifier', `Deterministic targeted validation: ${targeted.status}.`, {
        taskId: task.taskId,
        status: targeted.status,
        tools: targeted.evidence.map((item) => ({ tool: item.tool, status: item.status, artifactId: item.artifactId })),
      }, targeted.status === 'failed' ? 'error' : 'progress');

      if (targeted.status === 'remote_required') {
        hostUpdate(hostUpdates, sessionId, 'Host stopped because targeted validation was deferred by the Resource Governor.', {
          taskId: task.taskId,
          remoteRequired: true,
        });
        return {
          status: 'remote_required', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
          summary: 'The patch was applied, but validation requires remote compute under current VPS pressure.',
        };
      }

      if (targeted.status === 'passed') {
        const full = await runCodexValidationStage({
          taskId: task.taskId,
          stage: 'full',
          approvalGranted: input.approvalGranted,
        }, undefined, broker);
        task = full.state;
        toolEvidence.push(...full.evidence);
        emitProgress(sessionId, 'verifier', `Full validation ladder: ${full.status}.`, {
          taskId: task.taskId,
          status: full.status,
          tools: full.evidence.map((item) => ({ tool: item.tool, status: item.status, artifactId: item.artifactId })),
        }, full.status === 'failed' ? 'error' : 'progress');
        if (full.status === 'passed') {
          hostUpdate(hostUpdates, sessionId, 'Host received passing deterministic validation and marked the coding task complete.', {
            taskId: task.taskId,
            changedFiles: task.filesChanged,
          });
          return {
            status: 'completed', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
            summary: 'Patch applied and deterministic validation passed.',
          };
        }
        if (full.status === 'remote_required') {
          hostUpdate(hostUpdates, sessionId, 'Host stopped at the remote-validation boundary; no local full build was forced on the VPS.', {
            taskId: task.taskId,
            remoteRequired: true,
          });
          return {
            status: 'remote_required', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
            summary: 'Local checks passed; full build requires remote validation.',
          };
        }
      }

      if (attempt >= maxRevisions) {
        const checkpoint = task.checkpoints.at(-1);
        if (checkpoint) {
          task = rollbackCodingCheckpoint(task.taskId, checkpoint.checkpointId, { approvalGranted: true }).state;
          hostUpdate(hostUpdates, sessionId, 'Host rolled back the failed patch after the bounded revision budget was exhausted.', {
            taskId: task.taskId,
            checkpointId: checkpoint.checkpointId,
          });
        }
        return {
          status: 'validation_failed', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
          summary: 'Validation still failed after the bounded revision budget; the checkpoint was restored.',
        };
      }
      const revision = beginCodingRevision(task.taskId);
      task = revision.state;
      revisionPacket = revision.revisionPacket;
      hostUpdate(hostUpdates, sessionId, `Host requested bounded revision ${attempt + 1} using only failed-check evidence.`, {
        taskId: task.taskId,
        revision: attempt + 1,
      });
    }

    return {
      status: 'failed', task, plan, patches, modelCalls, toolEvidence, hostUpdates,
      summary: 'Autonomous coding loop exhausted without a terminal result.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.approvalGranted && task.filesChanged.length) {
      const checkpoint = task.checkpoints.at(-1);
      if (checkpoint) {
        try {
          task = rollbackCodingCheckpoint(task.taskId, checkpoint.checkpointId, { approvalGranted: true }).state;
          hostUpdate(hostUpdates, sessionId, 'Host restored the latest checkpoint after an autonomous execution error.', {
            taskId: task.taskId,
            checkpointId: checkpoint.checkpointId,
          });
        } catch {
          // Preserve the original execution error; rollback failure is visible in unresolved state.
        }
      }
    }
    emitProgress(sessionId, 'host', `Autonomous coding loop failed: ${message}`, { taskId: task.taskId }, 'error');
    return {
      status: 'failed',
      task: loadCodingTask(task.taskId) || task,
      plan,
      patches,
      modelCalls,
      toolEvidence,
      hostUpdates,
      summary: 'Autonomous coding loop failed closed.',
      error: message,
    };
  }
}
