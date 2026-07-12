#!/usr/bin/env node
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
loadEnv('.env.local');
loadEnv('.env');

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || '';

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function request(path, body, method = 'POST', extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers(), ...extraHeaders },
    ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 800)}`);
  return data;
}

function parseJsonArg(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return { request: value }; }
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === 'help') {
  console.log(`Zenos Runtime local client\n\nCommands:\n  health\n  readiness\n  eval\n  metrics\n  route <request-or-json>\n  run <request-or-json>\n  run-key <idempotencyKey> <request-or-json>\n  run-status <runId>\n  gateway-preflight <json>\n  gateway-postflight <json>\n  remote-validate <json>\n  session <request-or-json>\n  session-get <sessionId>\n  dispatch <sessionId> <template> <task>\n  event <json>\n  escalate <sessionId> [hostAssessment]\n  boss-review <sessionId> <decision-json>\n  quality-gate <json>\n  models [sessionId]\n  budget <sessionId>\n`);
  process.exit(0);
}

let output;
switch (command) {
  case 'health': output = await request('/api/health', null, 'GET'); break;
  case 'readiness': output = await request('/api/runtime/readiness', null, 'GET'); break;
  case 'eval': output = await request('/api/runtime/eval', null, 'GET'); break;
  case 'metrics': output = await request('/api/runtime/metrics', null, 'GET'); break;
  case 'route': output = await request('/api/runtime/route', parseJsonArg(args.join(' '))); break;
  case 'run': output = await request('/api/runtime/run', parseJsonArg(args.join(' ')), 'POST', { 'Idempotency-Key': `cli-${Date.now()}-${Math.random().toString(36).slice(2)}` }); break;
  case 'run-key': {
    const key = args.shift() || '';
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error('run-key requires a valid idempotency key');
    output = await request('/api/runtime/run', parseJsonArg(args.join(' ')), 'POST', { 'Idempotency-Key': key });
    break;
  }
  case 'run-status': output = await request(`/api/runtime/runs/${encodeURIComponent(args[0] || '')}`, null, 'GET'); break;
  case 'gateway-preflight': output = await request('/api/runtime/gateway/preflight', JSON.parse(args.join(' '))); break;
  case 'gateway-postflight': output = await request('/api/runtime/gateway/postflight', JSON.parse(args.join(' '))); break;
  case 'remote-validate': output = await request('/api/runtime/remote-validation', JSON.parse(args.join(' '))); break;
  case 'session': output = await request('/api/runtime/session', parseJsonArg(args.join(' '))); break;
  case 'session-get': output = await request(`/api/runtime/session/${encodeURIComponent(args[0] || '')}`, null, 'GET'); break;
  case 'dispatch': output = await request('/api/runtime/dispatch', { sessionId: args[0], template: args[1], task: args.slice(2).join(' '), mode: 'managed' }); break;
  case 'event': output = await request('/api/runtime/worker-event', JSON.parse(args.join(' '))); break;
  case 'escalate': output = await request('/api/runtime/escalate', { sessionId: args[0], hostAssessment: args.slice(1).join(' ') || undefined }); break;
  case 'boss-review': output = await request('/api/runtime/boss-review', { sessionId: args[0], decision: JSON.parse(args.slice(1).join(' ')) }); break;
  case 'quality-gate': output = await request('/api/runtime/quality-gate', JSON.parse(args.join(' '))); break;
  case 'models': output = await request(`/api/runtime/models${args[0] ? `?sessionId=${encodeURIComponent(args[0])}` : ''}`, null, 'GET'); break;
  case 'budget': output = await request(`/api/runtime/budget/${encodeURIComponent(args[0] || '')}`, null, 'GET'); break;
  default: throw new Error(`Unknown command: ${command}`);
}

console.log(JSON.stringify(output, null, 2));
