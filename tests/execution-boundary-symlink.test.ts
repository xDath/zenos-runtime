import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { evaluateExecutionBoundary } from '../app/lib/execution-boundary';
import { resolveRepositoryPath } from '../app/lib/repository-intelligence';

test('execution and repository boundaries resolve symlinks before allowlist checks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenos-boundary-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  const link = path.join(allowed, 'escape');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    t.skip(`Symlinks are unavailable in this environment: ${String(error)}`);
    return;
  }

  const original = {
    nodeEnv: process.env.NODE_ENV,
    mode: process.env.ZENOS_RUNTIME_EXECUTION_MODE,
    validation: process.env.ZENOS_RUNTIME_VALIDATION_ROOTS,
    enabled: process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED,
  };
  try {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    process.env.ZENOS_RUNTIME_EXECUTION_MODE = 'control-plane';
    process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED = 'true';
    process.env.ZENOS_RUNTIME_VALIDATION_ROOTS = allowed;
    const decision = evaluateExecutionBoundary({
      action: 'remote_validation',
      workspaceRoot: link,
      approvalGranted: true,
    });
    assert.equal(decision.allowed, false);
    assert.throws(() => resolveRepositoryPath(allowed, 'escape/secret.txt'), /outside repository root/i);
  } finally {
    if (original.nodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Reflect.set(process.env, 'NODE_ENV', original.nodeEnv);
    if (original.mode === undefined) delete process.env.ZENOS_RUNTIME_EXECUTION_MODE; else process.env.ZENOS_RUNTIME_EXECUTION_MODE = original.mode;
    if (original.validation === undefined) delete process.env.ZENOS_RUNTIME_VALIDATION_ROOTS; else process.env.ZENOS_RUNTIME_VALIDATION_ROOTS = original.validation;
    if (original.enabled === undefined) delete process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED; else process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED = original.enabled;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
