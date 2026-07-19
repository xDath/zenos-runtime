#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || '';
loadEnv(credentialDirectory ? `${credentialDirectory}/zenos-runtime.env` : '');
loadEnv('.env.local');
loadEnv('.env');

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || '';
assert.ok(apiKey, 'ZENOS_RUNTIME_API_KEY is required for the live orchestration smoke');

const idempotencyKey = `live-four-role-${Date.now()}`;
const response = await fetch(`${baseUrl}/api/runtime/run`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  },
  body: JSON.stringify({
    request: 'Benchmark this synthetic, non-mutating production-readiness evidence and return a concise verdict with the strongest remaining risk.',
    context: [
      'Evidence A: the service is loopback-only and runs as a non-root system identity.',
      'Evidence B: the state store uses SQLite WAL with integrity checks and idempotent requests.',
      'Evidence C: this benchmark smoke must independently exercise Host, Worker, Verifier, and Boss.',
      'Constraint: do not call tools, mutate files, or perform a production action.',
    ].join('\n'),
    intent: 'analyze',
    estimatedContextTokens: 8_000,
    userRequestedVerification: true,
    userRequestedBoss: true,
    autoRecallMemory: false,
    persistRouteEvent: false,
    autonomousCoding: false,
    includeExecutionReceipt: true,
    acceptanceCriteria: [
      'Use the supplied evidence only.',
      'State one remaining risk.',
      'Return a concise final verdict.',
    ],
  }),
  signal: AbortSignal.timeout(240_000),
});

const body = await response.json();
assert.equal(response.ok, true, `Runtime returned HTTP ${response.status}: ${JSON.stringify(body)}`);
assert.equal(body.ok, true, JSON.stringify(body));
assert.equal(body.result?.status, 'done', JSON.stringify(body.result));
const receipt = body.result?.executionReceipt;
assert.ok(receipt, 'Runtime did not return an execution receipt');
assert.ok(receipt.host.calls >= 1, 'Host was not executed');
assert.ok(receipt.worker.calls >= 1, 'Worker was not executed');
assert.ok(receipt.verifier.calls >= 1, 'Verifier was not executed');
assert.ok(receipt.boss.calls >= 1 && receipt.boss.skipped === false, 'Boss was not executed');

process.stdout.write(`${JSON.stringify({
  ok: true,
  runId: body.result.runId,
  sessionId: body.result.sessionId,
  status: body.result.status,
  decision: {
    taskType: body.result.decision?.taskType,
    pipelineMode: body.result.decision?.pipelineMode,
    risk: body.result.decision?.risk,
  },
  calls: {
    host: receipt.host.calls,
    worker: receipt.worker.calls,
    verifier: receipt.verifier.calls,
    boss: receipt.boss.calls,
  },
  revisions: body.result.revisions,
  durationMs: body.result.durationMs,
}, null, 2)}\n`);
