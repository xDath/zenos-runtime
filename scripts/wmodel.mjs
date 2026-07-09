#!/usr/bin/env node

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || process.env.ZENOS_MEMORY_API_KEY || 'local-dev';
const slots = ['host', 'worker', 'boss', 'verifier'];

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
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

function printStatus(config) {
  const lines = [
    `Host: ${config.hostModel || '-'}`,
    `Worker: ${config.workerModel || '-'}`,
    `Boss: ${config.bossModel || '-'}`,
    `Verifier: ${config.verifierModel || '-'}`,
  ];
  console.log(lines.join('\n'));
}

const args = process.argv.slice(2);
if (args[0] === 'help') {
  console.log(`Usage:\n  wmodel\n  wmodel host:model --provider provider; worker:model2 --provider provider2; boss:model3; verifier:model4\n  wmodel modelHost --provider provider; modelWorker --provider provider; modelBoss --provider provider; modelVerifier --provider provider`);
  process.exit(0);
}

if (!args.length) {
  const data = await request('/api/runtime/models');
  printStatus(data.config);
  process.exit(0);
}

const update = parseSegments(args);
const saved = await request('/api/runtime/models', update, 'POST');
printStatus(saved.config);
console.log('\nSaved.');
