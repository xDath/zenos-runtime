import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { loadCodingTask, recordRemoteValidationResult } from './codex-execution-core';
import { assertExecutionBoundary } from './execution-boundary';

const execFileAsync = promisify(execFile);

const SafeTaskId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const SafeWorkflow = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9._/-]+\.ya?ml$/);

export const RemoteValidationRequestSchema = z.object({
  taskId: SafeTaskId,
  workspaceRoot: z.string().trim().min(1).max(4_096),
  approvalGranted: z.boolean(),
  workflowFile: SafeWorkflow.optional().default('zenos-runtime-validation.yml'),
  branchPrefix: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._/-]+$/).optional().default('etla/runtime'),
  timeoutSeconds: z.number().int().min(60).max(3_600).optional().default(1_200),
  pollSeconds: z.number().int().min(2).max(60).optional().default(8),
  cleanupBranch: z.enum(['success', 'always', 'never']).optional().default('success'),
  recordTaskResult: z.boolean().optional().default(true),
});

const GithubJobStepSchema = z.object({
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  number: z.number().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
}).passthrough();

const GithubJobSchema = z.object({
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  databaseId: z.number().optional(),
  steps: z.array(GithubJobStepSchema).optional().default([]),
  url: z.string().optional(),
}).passthrough();

const GithubRunSchema = z.object({
  databaseId: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  url: z.string().optional(),
  headSha: z.string().optional(),
  headBranch: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  jobs: z.array(GithubJobSchema).optional().default([]),
}).passthrough();

export const RemoteValidationResultSchema = z.object({
  ok: z.boolean(),
  passed: z.boolean(),
  taskId: z.string(),
  repository: z.string(),
  branch: z.string(),
  headSha: z.string(),
  workflowFile: z.string(),
  runId: z.number().int().positive(),
  runUrl: z.string().optional(),
  conclusion: z.string(),
  status: z.string(),
  summary: z.string(),
  jobs: z.array(GithubJobSchema),
  artifactId: z.string().optional(),
  branchCleaned: z.boolean(),
  taskStateRecorded: z.boolean(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});

export type RemoteValidationRequest = z.input<typeof RemoteValidationRequestSchema>;
export type RemoteValidationResult = z.infer<typeof RemoteValidationResultSchema>;

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

type RemoteValidationDependencies = {
  runCommand?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  artifactDirectory?: string;
};

function safeBranchSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'task';
}

function defaultArtifactDirectory(): string {
  return process.env.ZENOS_RUNTIME_ARTIFACT_DIR || path.join(process.cwd(), '.data', 'artifacts');
}

async function defaultRunCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
    });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    const stdout = String(failure.stdout || '');
    const stderr = String(failure.stderr || '');
    throw new Error([
      `${command} ${args.join(' ')} failed${failure.code !== undefined ? ` (${failure.code})` : ''}: ${failure.message}`,
      stdout.trim() ? `stdout: ${stdout.trim().slice(-4_000)}` : '',
      stderr.trim() ? `stderr: ${stderr.trim().slice(-4_000)}` : '',
    ].filter(Boolean).join('\n'));
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON: ${value.slice(0, 1_000)}`);
  }
}

function saveArtifact(directory: string, payload: unknown): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `remote_validation_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.json`;
  const file = path.join(directory, id);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function validationSummary(run: z.infer<typeof GithubRunSchema>): string {
  const failedJobs = run.jobs.filter((job) => job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped');
  const failedSteps = run.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped')
      .map((step) => `${job.name || 'job'} → ${step.name || 'step'} (${step.conclusion})`),
  );
  if (run.conclusion === 'success') {
    return `GitHub Actions remote validation passed (${run.jobs.length} jobs).`;
  }
  const detail = failedSteps.length
    ? failedSteps.slice(0, 12).join('; ')
    : failedJobs.map((job) => `${job.name || 'job'} (${job.conclusion})`).slice(0, 12).join('; ');
  return `GitHub Actions remote validation concluded ${run.conclusion || 'unknown'}${detail ? `: ${detail}` : '.'}`;
}

async function cleanupRemoteBranch(
  runCommand: CommandRunner,
  root: string,
  branch: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await runCommand('git', ['push', 'origin', '--delete', branch], { cwd: root, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function dispatchRemoteValidation(
  raw: RemoteValidationRequest,
  dependencies: RemoteValidationDependencies = {},
): Promise<RemoteValidationResult> {
  const request = RemoteValidationRequestSchema.parse(raw);
  const root = path.resolve(request.workspaceRoot);
  assertExecutionBoundary({
    action: 'remote_validation',
    workspaceRoot: root,
    approvalGranted: request.approvalGranted,
  });
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const sleep = dependencies.sleep || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now || (() => new Date());
  const timeoutMs = request.timeoutSeconds * 1_000;
  const started = now();

  const inside = (await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 30_000 })).stdout.trim();
  if (inside !== 'true') throw new Error('Workspace is not a Git repository');
  const dirty = (await runCommand('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 30_000 })).stdout.trim();
  if (dirty) {
    throw new Error('Remote validation requires a clean worktree so unrelated changes cannot be pushed');
  }
  const headSha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 30_000 })).stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error('Could not resolve a valid Git HEAD');
  const repository = (await runCommand('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: root, timeoutMs: 60_000 })).stdout.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Could not resolve GitHub repository: ${repository}`);

  const timestamp = started.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const branch = `${request.branchPrefix.replace(/\/+$/g, '')}/${safeBranchSegment(request.taskId)}-${timestamp}`;
  await runCommand('git', ['push', 'origin', `${headSha}:refs/heads/${branch}`], { cwd: root, timeoutMs: 120_000 });

  const deadline = Date.now() + timeoutMs;
  let selectedRun: z.infer<typeof GithubRunSchema> | undefined;
  while (Date.now() < deadline) {
    const listed = await runCommand('gh', [
      'run', 'list',
      '--repo', repository,
      '--workflow', request.workflowFile,
      '--branch', branch,
      '--limit', '10',
      '--json', 'databaseId,status,conclusion,url,headSha,headBranch,createdAt,updatedAt',
    ], { cwd: root, timeoutMs: 60_000 });
    const candidates = z.array(GithubRunSchema).parse(parseJson<unknown>(listed.stdout || '[]', 'gh run list'));
    selectedRun = candidates.find((candidate) => candidate.headSha === headSha || candidate.headBranch === branch);
    if (selectedRun) break;
    await sleep(request.pollSeconds * 1_000);
  }
  if (!selectedRun) {
    const cleaned = request.cleanupBranch === 'always'
      ? await cleanupRemoteBranch(runCommand, root, branch, 120_000)
      : false;
    throw new Error(`No GitHub Actions run appeared for ${branch} before timeout${cleaned ? '; temporary branch was cleaned' : ''}`);
  }

  while (selectedRun.status !== 'completed' && Date.now() < deadline) {
    await sleep(request.pollSeconds * 1_000);
    const viewed = await runCommand('gh', [
      'run', 'view', String(selectedRun.databaseId),
      '--repo', repository,
      '--json', 'databaseId,status,conclusion,url,headSha,headBranch,createdAt,updatedAt,jobs',
    ], { cwd: root, timeoutMs: 60_000 });
    selectedRun = GithubRunSchema.parse(parseJson<unknown>(viewed.stdout, 'gh run view'));
  }
  if (selectedRun.status !== 'completed') {
    throw new Error(`GitHub Actions run ${selectedRun.databaseId} did not complete before timeout`);
  }

  // Fetch one final structured view even when the first list response was already completed.
  const finalView = await runCommand('gh', [
    'run', 'view', String(selectedRun.databaseId),
    '--repo', repository,
    '--json', 'databaseId,status,conclusion,url,headSha,headBranch,createdAt,updatedAt,jobs',
  ], { cwd: root, timeoutMs: 60_000 });
  selectedRun = GithubRunSchema.parse(parseJson<unknown>(finalView.stdout, 'gh run view'));
  const passed = selectedRun.conclusion === 'success';
  const summary = validationSummary(selectedRun);
  const artifactId = saveArtifact(dependencies.artifactDirectory || defaultArtifactDirectory(), {
    request: { ...request, approvalGranted: true },
    repository,
    branch,
    headSha,
    run: selectedRun,
    summary,
  });

  let taskStateRecorded = false;
  if (request.recordTaskResult) {
    const task = loadCodingTask(request.taskId);
    if (task?.currentPhase === 'full_validation') {
      recordRemoteValidationResult({
        taskId: request.taskId,
        passed,
        summary,
        artifactId,
      });
      taskStateRecorded = true;
    }
  }

  const shouldCleanup = request.cleanupBranch === 'always' || (request.cleanupBranch === 'success' && passed);
  const branchCleaned = shouldCleanup
    ? await cleanupRemoteBranch(runCommand, root, branch, 120_000)
    : false;
  const completed = now();

  return RemoteValidationResultSchema.parse({
    ok: passed,
    passed,
    taskId: request.taskId,
    repository,
    branch,
    headSha,
    workflowFile: request.workflowFile,
    runId: selectedRun.databaseId,
    runUrl: selectedRun.url,
    conclusion: selectedRun.conclusion || 'unknown',
    status: selectedRun.status,
    summary,
    jobs: selectedRun.jobs,
    artifactId,
    branchCleaned,
    taskStateRecorded,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  });
}
