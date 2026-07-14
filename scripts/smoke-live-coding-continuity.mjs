#!/usr/bin/env node

import assert from 'node:assert/strict';
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
assert.ok(apiKey, 'ZENOS_RUNTIME_API_KEY is required for the live coding-continuity smoke');

async function runtimeRequest(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `Runtime returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const suffix = Date.now();
const sessionId = `hermes_live_coding_continuity_${suffix}`;
const turnId = `turn_live_coding_continuity_${suffix}`;
const preflight = await runtimeRequest('/api/runtime/gateway/preflight', {
  request: 'tapi lihat juga sellnya kan, sellnya juga pasti ga langsung sell pasti sellnya berurutan',
  sessionId,
  turnId,
  platform: 'telegram',
  host: { model: 'grok', provider: 'etla-router' },
  context: [
    'Reading /root/openclaw-projects/rh-copybot/bot.py',
    'Editing /root/openclaw-projects/rh-copybot/bot.py',
    'Status jujur: file sempat rusak mid-patch dan belum selesai.',
    'Blocker sekarang: bot.py IndentationError. Next turn repair lalu jalankan test.',
  ].join('\n'),
  intent: 'analyze',
});

assert.equal(preflight.ok, true, JSON.stringify(preflight));
assert.equal(preflight.decision?.taskType, 'coding_change', JSON.stringify(preflight.decision));
assert.equal(preflight.decision?.pipelineMode, 'verified_path', JSON.stringify(preflight.decision));
assert.equal(preflight.decision?.useWorker, true, JSON.stringify(preflight.decision));
assert.equal(preflight.decision?.useVerifier, true, JSON.stringify(preflight.decision));
assert.equal(preflight.receipt?.worker?.invoked, true, JSON.stringify(preflight.receipt));
assert.equal(preflight.holdFinalDelivery, true, JSON.stringify(preflight));

const postflight = await runtimeRequest('/api/runtime/gateway/postflight', {
  sessionId,
  runId: preflight.runId,
  turnId,
  draft: 'Status jujur: file sempat rusak mid-patch, lanjut next turn.',
  host: { model: 'grok', provider: 'etla-router' },
  toolSummary: [
    'edit_file: completed — Updated /root/openclaw-projects/rh-copybot/bot.py',
    'terminal: failed — python -m py_compile bot.py exited code 1: IndentationError',
  ].join('\n'),
  hostUsage: { inputTokens: 500, outputTokens: 90, calls: 2 },
});

assert.equal(postflight.ok, false, JSON.stringify(postflight));
assert.equal(postflight.failed, true, JSON.stringify(postflight));
assert.equal(postflight.receipt?.pipeline, 'verified_path', JSON.stringify(postflight.receipt));
assert.equal(postflight.receipt?.verifier?.invoked, true, JSON.stringify(postflight.receipt));
assert.match(postflight.finalAnswer || '', /repair|rollback/i);

const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${encodeURIComponent(preflight.runId)}`, {
  headers: { authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(30_000),
});
const runPayload = await runResponse.json();
assert.equal(runResponse.ok, true, JSON.stringify(runPayload));
assert.equal(runPayload.run?.status, 'failed', JSON.stringify(runPayload.run));
assert.match((runPayload.run?.errors || []).join(' '), /deterministic validation/i);

process.stdout.write(`${JSON.stringify({
  ok: true,
  runId: preflight.runId,
  sessionId,
  preflight: {
    taskType: preflight.decision.taskType,
    pipelineMode: preflight.decision.pipelineMode,
    workerInvoked: preflight.receipt.worker.invoked,
    verifierRequired: preflight.decision.useVerifier,
  },
  postflight: {
    ok: postflight.ok,
    failed: postflight.failed,
    verifierInvoked: postflight.receipt.verifier.invoked,
    persistedStatus: runPayload.run.status,
  },
}, null, 2)}\n`);
