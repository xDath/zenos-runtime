#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv(file) {
  if (!file || !existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || '';
loadEnv(credentialDirectory ? path.join(credentialDirectory, 'zenos-runtime.env') : '');
loadEnv('.env.local');
loadEnv('.env');

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || '';
const workspaceRoot = process.env.ZENOS_CONTINUATION_SMOKE_WORKSPACE || '/srv/etla/workspaces/zenos-runtime';
assert.ok(apiKey, 'ZENOS_RUNTIME_API_KEY is required');

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 120_000),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `Runtime HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function git(args) {
  return execFileSync('git', ['-C', workspaceRoot, ...args], { encoding: 'utf8' }).trim();
}

function workspaceState() {
  const diff = git(['diff', '--no-ext-diff', '--binary', 'HEAD', '--']);
  const changed = git(['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    workspaceRoot,
    gitHead: git(['rev-parse', 'HEAD']),
    dirtyDiffSha256: crypto.createHash('sha256').update(diff).digest('hex'),
    changedFiles: changed ? changed.split(/\r?\n/).slice(0, 200).map(line => ({
      path: line.slice(3).trim(),
      exists: !line.startsWith(' D') && !line.startsWith('D '),
    })) : [],
    clean: !changed,
    capturedAt: new Date().toISOString(),
  };
}

const suffix = Date.now();
const sessionId = `live_one_command_${suffix}`;
const firstTurnId = `live_one_command_turn_1_${suffix}`;
const secondTurnId = `live_one_command_turn_2_${suffix}`;
let firstPreflight;
let firstPostflight;
let terminal = false;

async function abortBestEffort(reason) {
  if (!firstPreflight?.runId || terminal) return;
  try {
    await request('/api/runtime/gateway/abort', {
      body: {
        sessionId,
        runId: firstPreflight.runId,
        turnId: firstTurnId,
        reason: String(reason).slice(0, 2_000),
      },
      timeoutMs: 30_000,
    });
  } catch {
    // Startup janitor is the final recovery path.
  }
}

try {
  firstPreflight = await request('/api/runtime/gateway/preflight', {
    body: {
      request: 'Implement the requested Runtime change and continue autonomously until targeted validation passes. This is a smoke task; do not actually edit files.',
      sessionId,
      turnId: firstTurnId,
      platform: 'telegram',
      host: { model: 'deepseek', provider: 'etla-router' },
      workspaceRoot,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
    },
  });
  assert.equal(firstPreflight.ok, true, JSON.stringify(firstPreflight));
  assert.ok(firstPreflight.cognitiveTaskId, JSON.stringify(firstPreflight));

  firstPostflight = await request('/api/runtime/gateway/postflight', {
    body: {
      sessionId,
      runId: firstPreflight.runId,
      turnId: firstTurnId,
      draft: 'Intermediate backend cycle: implementation and validation are still pending.',
      host: { model: 'deepseek', provider: 'etla-router' },
      hostUsage: { inputTokens: 300, outputTokens: 45, calls: 1 },
    },
  });
  assert.equal(firstPostflight.ok, true, JSON.stringify(firstPostflight));
  assert.equal(firstPostflight.continuation?.required, true, JSON.stringify(firstPostflight));
  assert.ok(firstPostflight.continuation?.continuationId, JSON.stringify(firstPostflight));
  assert.ok(firstPostflight.continuation?.leaseToken, JSON.stringify(firstPostflight));
  // Runtime returns the intermediate draft to its trusted Hermes caller.
  // Hermes suppresses delivery whenever continuation.required=true.
  assert.equal(firstPostflight.transformed, false, JSON.stringify(firstPostflight));
  assert.match(firstPostflight.finalAnswer || '', /Intermediate backend cycle/i);

  const heartbeat = await request('/api/runtime/gateway/continuation', {
    body: {
      continuationId: firstPostflight.continuation.continuationId,
      leaseToken: firstPostflight.continuation.leaseToken,
      action: 'heartbeat',
    },
    timeoutMs: 30_000,
  });
  assert.equal(heartbeat.continuation?.status, 'leased', JSON.stringify(heartbeat));

  const secondPreflight = await request('/api/runtime/gateway/preflight', {
    body: {
      request: firstPostflight.continuation.prompt,
      sessionId,
      turnId: secondTurnId,
      platform: 'telegram',
      host: { model: 'deepseek', provider: 'etla-router' },
      workspaceRoot,
      hasFiles: true,
      hasCodeChangeIntent: true,
      intent: 'mutate',
    },
  });
  assert.equal(secondPreflight.cognitiveTaskId, firstPreflight.cognitiveTaskId, JSON.stringify(secondPreflight));
  assert.equal(secondPreflight.hostBudget?.budgetId, firstPreflight.hostBudget?.budgetId, JSON.stringify(secondPreflight));
  assert.equal(secondPreflight.hostBudget?.budgetId, firstPreflight.runId, JSON.stringify(secondPreflight));

  const currentWorkspace = workspaceState();
  const secondPostflight = await request('/api/runtime/gateway/postflight', {
    body: {
      sessionId,
      runId: secondPreflight.runId,
      turnId: secondTurnId,
      draft: 'The requested implementation is complete and targeted validation passed.',
      host: { model: 'deepseek', provider: 'etla-router' },
      workspaceState: currentWorkspace,
      executionReceipts: [
        {
          receiptId: `live-workspace-${suffix}`,
          kind: 'workspace',
          tool: 'apply_patch',
          status: 'passed',
          summary: 'Synthetic smoke receipt; no real file was modified.',
          changedFiles: ['app/lib/gateway-orchestration.ts'],
          artifactIds: [],
          workspaceRevisionBefore: currentWorkspace.dirtyDiffSha256,
          workspaceRevisionAfter: currentWorkspace.dirtyDiffSha256,
          metadata: { mutating: true, syntheticSmoke: true },
        },
        {
          receiptId: `live-validation-${suffix}`,
          kind: 'validation',
          tool: 'terminal',
          status: 'passed',
          command: 'npm run typecheck',
          exitCode: 0,
          validationKind: 'typecheck',
          summary: 'Synthetic structured validation receipt for contract smoke.',
          changedFiles: [],
          artifactIds: [],
          metadata: { syntheticSmoke: true },
        },
      ],
      hostUsage: { inputTokens: 320, outputTokens: 55, calls: 2 },
    },
  });
  assert.equal(secondPostflight.ok, true, JSON.stringify(secondPostflight));
  assert.equal(secondPostflight.continuation, undefined, JSON.stringify(secondPostflight));
  assert.equal(secondPostflight.cognitivePhase, 'complete', JSON.stringify(secondPostflight));

  const acknowledgement = await request('/api/runtime/gateway/continuation', {
    body: {
      continuationId: firstPostflight.continuation.continuationId,
      leaseToken: firstPostflight.continuation.leaseToken,
      action: 'complete',
    },
    timeoutMs: 30_000,
  });
  assert.equal(acknowledgement.continuation?.status, 'completed', JSON.stringify(acknowledgement));

  const run = await request(`/api/runtime/runs/${encodeURIComponent(secondPreflight.runId)}`, {
    method: 'GET',
    timeoutMs: 30_000,
  });
  assert.equal(run.run?.status, 'done', JSON.stringify(run));
  terminal = true;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    rootRunId: firstPreflight.runId,
    continuationId: firstPostflight.continuation.continuationId,
    continuationReason: firstPostflight.continuation.reason,
    sharedBudgetId: secondPreflight.hostBudget.budgetId,
    terminalRunId: secondPreflight.runId,
    cognitiveTaskId: secondPreflight.cognitiveTaskId,
    terminalPhase: secondPostflight.cognitivePhase,
    acknowledgement: acknowledgement.continuation.status,
  }, null, 2)}\n`);
} catch (error) {
  await abortBestEffort(error instanceof Error ? error.message : String(error));
  throw error;
}
