import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchRemoteValidation } from '../app/lib/github-remote-validation';
import { resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
});

test('remote dispatcher refuses to create or push a branch without explicit approval', async () => {
  let calls = 0;
  await assert.rejects(
    dispatchRemoteValidation({
      taskId: 'task-no-approval',
      workspaceRoot: os.tmpdir(),
      approvalGranted: false,
    }, {
      runCommand: async () => {
        calls += 1;
        return { stdout: '', stderr: '' };
      },
    }),
    /explicit approval/i,
  );
  assert.equal(calls, 0);
});

test('remote dispatcher pushes an isolated branch, ingests structured Actions evidence, and cleans success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenos-remote-validation-'));
  const artifactDirectory = path.join(root, 'artifacts');
  const headSha = 'a'.repeat(40);
  const commands: Array<{ command: string; args: string[] }> = [];
  let viewCalls = 0;
  const run = {
    databaseId: 991,
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/xDath/zenos-runtime/actions/runs/991',
    headSha,
    headBranch: 'ignored-by-test',
    createdAt: '2026-07-12T06:00:00Z',
    updatedAt: '2026-07-12T06:02:00Z',
    jobs: [{
      name: 'validate',
      status: 'completed',
      conclusion: 'success',
      steps: [
        { name: 'Typecheck', status: 'completed', conclusion: 'success', number: 1 },
        { name: 'Unit and integration tests', status: 'completed', conclusion: 'success', number: 2 },
      ],
    }],
  };

  const result = await dispatchRemoteValidation({
    taskId: 'task-remote-pass',
    workspaceRoot: root,
    approvalGranted: true,
    pollSeconds: 2,
    timeoutSeconds: 60,
    recordTaskResult: false,
  }, {
    artifactDirectory,
    now: () => new Date('2026-07-12T06:00:00Z'),
    sleep: async () => undefined,
    runCommand: async (command, args) => {
      commands.push({ command, args });
      const joined = `${command} ${args.join(' ')}`;
      if (joined === 'git rev-parse --is-inside-work-tree') return { stdout: 'true\n', stderr: '' };
      if (joined === 'git status --porcelain') return { stdout: '', stderr: '' };
      if (joined === 'git rev-parse HEAD') return { stdout: `${headSha}\n`, stderr: '' };
      if (joined.startsWith('gh repo view')) return { stdout: 'xDath/zenos-runtime\n', stderr: '' };
      if (joined.startsWith('git push origin ') && !args.includes('--delete')) return { stdout: '', stderr: '' };
      if (joined.startsWith('gh run list')) {
        return { stdout: JSON.stringify([{ ...run, status: 'queued', conclusion: null, jobs: [] }]), stderr: '' };
      }
      if (joined.startsWith('gh run view')) {
        viewCalls += 1;
        return { stdout: JSON.stringify(run), stderr: '' };
      }
      if (joined.startsWith('git push origin --delete')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected command: ${joined}`);
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.conclusion, 'success');
  assert.equal(result.runId, 991);
  assert.equal(result.branchCleaned, true);
  assert.equal(result.taskStateRecorded, false);
  assert.equal(result.jobs[0].name, 'validate');
  assert.ok(result.branch.startsWith('etla/runtime/task-remote-pass-'));
  assert.ok(result.artifactId && fs.existsSync(result.artifactId));
  assert.ok(commands.some(({ command, args }) => command === 'git' && args[0] === 'push' && args.some((arg) => arg.includes('refs/heads/etla/runtime/'))));
  assert.ok(commands.some(({ command, args }) => command === 'git' && args.includes('--delete')));
  assert.ok(viewCalls >= 1);
});

test('remote dispatcher blocks dirty worktrees before any GitHub push', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenos-remote-dirty-'));
  const commands: string[] = [];

  await assert.rejects(
    dispatchRemoteValidation({
      taskId: 'task-dirty',
      workspaceRoot: root,
      approvalGranted: true,
    }, {
      runCommand: async (command, args) => {
        const joined = `${command} ${args.join(' ')}`;
        commands.push(joined);
        if (joined === 'git rev-parse --is-inside-work-tree') return { stdout: 'true\n', stderr: '' };
        if (joined === 'git status --porcelain') return { stdout: ' M app/file.ts\n', stderr: '' };
        throw new Error(`Unexpected command: ${joined}`);
      },
    }),
    /clean worktree/i,
  );

  assert.equal(commands.some((command) => command.startsWith('git push')), false);
  assert.equal(commands.some((command) => command.startsWith('gh ')), false);
});
