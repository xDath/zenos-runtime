import path from 'node:path';
import { dispatchRemoteValidation } from '../app/lib/github-remote-validation';

const workspaceRoot = path.resolve(process.argv[2] || '');
const taskId = process.argv[3] || `runtime-${Date.now()}`;
if (!process.argv[2]) {
  throw new Error('Usage: npm run validate:remote -- <isolated-workspace> [task-id]');
}

Reflect.set(process.env, 'NODE_ENV', 'production');
process.env.ZENOS_RUNTIME_EXECUTION_MODE = 'control-plane';
process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED = 'true';
process.env.ZENOS_RUNTIME_VALIDATION_ROOTS = workspaceRoot;
process.env.ZENOS_RUNTIME_ARTIFACT_DIR = process.env.ZENOS_RUNTIME_ARTIFACT_DIR
  || '/var/lib/zenos-runtime/artifacts';

const result = await dispatchRemoteValidation({
  taskId,
  workspaceRoot,
  approvalGranted: true,
  timeoutSeconds: 1_800,
  pollSeconds: 8,
  cleanupBranch: 'success',
  recordTaskResult: false,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
