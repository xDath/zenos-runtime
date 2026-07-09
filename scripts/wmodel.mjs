#!/usr/bin/env node

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || process.env.ZENOS_MEMORY_API_KEY || 'local-dev';
const slots = ['host', 'worker', 'boss', 'verifier'];

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
}

async function request(path, body, method = 'GET') {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: authHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

function normalizeSlot(slot) {
  const lower = slot.toLowerCase();
  if (lower === 'h') return 'host';
  if (lower === 'w') return 'worker';
  if (lower === 'b') return 'boss';
  if (lower === 'v') return 'verifier';
  if (slots.includes(lower)) return lower;
  throw new Error(`Unknown slot: ${slot}`);
}

function parseArgs(rawArgs) {
  const args = [...rawArgs];
  let sessionId = process.env.ZENOS_RUNTIME_SESSION_ID || '';
  let global = false;
  const filtered = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--session') {
      sessionId = args[i + 1] || '';
      i += 1;
    } else if (args[i] === '--global') {
      global = true;
    } else {
      filtered.push(args[i]);
    }
  }

  return { sessionId: global ? '' : sessionId, args: filtered };
}

function parseSegments(args) {
  const text = args.join(' ').trim();
  if (!text) return {};
  const update = {};
  const segments = text.split(';').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < segments.length; i += 1) {
    const tokens = segments[i].split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    let slot = slots[i];
    let model = tokens[0];
    if (tokens[0].includes(':')) {
      const [rawSlot, rawModel] = tokens[0].split(/:(.+)/);
      slot = normalizeSlot(rawSlot);
      model = rawModel;
    }
    const providerIndex = tokens.indexOf('--provider');
    const provider = providerIndex >= 0 ? tokens[providerIndex + 1] : undefined;
    update[`${slot}Model`] = model;
    if (provider) update[`${slot}Provider`] = provider;
  }
  return update;
}

function modelButtonLabel(slot, config) {
  const model = config[`${slot}Model`] || '-';
  return `${slot[0].toUpperCase()}${slot.slice(1)}: ${model}`;
}

function printStatus(config, sessionId = '') {
  const lines = [
    sessionId ? `Session: ${sessionId}` : 'Scope: global default',
    modelButtonLabel('host', config),
    modelButtonLabel('worker', config),
    modelButtonLabel('boss', config),
    modelButtonLabel('verifier', config),
  ];
  console.log(lines.join('\n'));
}

function pathWithSession(path, sessionId) {
  return sessionId ? `${path}?sessionId=${encodeURIComponent(sessionId)}` : path;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.args[0] === 'help') {
  console.log(`Usage:\n  wmodel [--session sessionId]\n  wmodel --session sessionId host:model --provider provider; worker:model2 --provider provider2; boss:model3; verifier:model4\n  wmodel --global modelHost --provider provider; modelWorker --provider provider; modelBoss --provider provider; modelVerifier --provider provider\n\nDefault scope is per-session when --session or ZENOS_RUNTIME_SESSION_ID is set. Use --global to change defaults.`);
  process.exit(0);
}

if (!parsed.args.length) {
  const data = await request(pathWithSession('/api/runtime/models', parsed.sessionId));
  printStatus(data.config, parsed.sessionId);
  process.exit(0);
}

const update = parseSegments(parsed.args);
const saved = await request(pathWithSession('/api/runtime/models', parsed.sessionId), update, 'POST');
printStatus(saved.config, parsed.sessionId);
console.log(`\nSaved ${saved.scope}.`);
