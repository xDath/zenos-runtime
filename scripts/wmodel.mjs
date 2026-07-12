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
const slots = ['host', 'worker', 'boss', 'verifier'];

if (!apiKey) throw new Error('ZENOS_RUNTIME_API_KEY is required for wmodel');

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

async function request(path, body, method = 'GET') {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: authHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 800)}`);
  return data;
}

function normalizeSlot(slot) {
  const lower = slot.toLowerCase();
  const aliases = { h: 'host', w: 'worker', b: 'boss', v: 'verifier' };
  const normalized = aliases[lower] || lower;
  if (slots.includes(normalized)) return normalized;
  throw new Error(`Unknown slot: ${slot}`);
}

function parseArgs(rawArgs) {
  const args = [...rawArgs];
  let sessionId = process.env.ZENOS_RUNTIME_SESSION_ID || '';
  let global = false;
  let json = false;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--session') {
      sessionId = args[index + 1] || '';
      if (!sessionId) throw new Error('--session requires an id');
      index += 1;
    } else if (arg === '--global') {
      global = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      values.push(arg);
    }
  }
  return { sessionId: global ? '' : sessionId, values, json };
}

function parseSegments(args) {
  const text = args.join(' ').trim();
  if (!text) return {};
  const update = {};
  const segments = text.split(';').map((segment) => segment.trim()).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const tokens = segments[index].split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    let slot = slots[index];
    let model = tokens[0];
    if (tokens[0].includes(':')) {
      const [rawSlot, rawModel] = tokens[0].split(/:(.+)/);
      slot = normalizeSlot(rawSlot);
      model = rawModel;
    }
    if (!slot || !model || model.startsWith('--')) throw new Error(`Invalid model segment: ${segments[index]}`);
    const providerIndex = tokens.indexOf('--provider');
    const provider = providerIndex >= 0 ? tokens[providerIndex + 1] : undefined;
    update[`${slot}Model`] = model;
    if (provider) update[`${slot}Provider`] = provider;
  }
  return update;
}

function modelValue(config, slot) {
  return config.roles?.[slot]?.model || config[`${slot}Model`] || '-';
}

function printStatus(config, sessionId = '', jsonOutput = false) {
  const result = {
    scope: sessionId ? 'session' : 'global',
    sessionId: sessionId || null,
    host: modelValue(config, 'host'),
    worker: modelValue(config, 'worker'),
    boss: modelValue(config, 'boss'),
    verifier: modelValue(config, 'verifier'),
  };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else console.log([
    sessionId ? `Session: ${sessionId}` : 'Scope: global default',
    `Host: ${result.host}`,
    `Worker: ${result.worker}`,
    `Boss: ${result.boss}`,
    `Verifier: ${result.verifier}`,
  ].join('\n'));
}

function pathWithSession(path, sessionId) {
  return sessionId ? `${path}?sessionId=${encodeURIComponent(sessionId)}` : path;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.values[0] === 'help') {
  console.log('Usage:\n  wmodel [--json] [--session sessionId]\n  wmodel --session sessionId host:model; worker:model2; boss:model3; verifier:model4\n  wmodel --global host:model; worker:model2; boss:model3; verifier:model4');
  process.exit(0);
}

if (!parsed.values.length) {
  const data = await request(pathWithSession('/api/runtime/models', parsed.sessionId));
  printStatus(data.config, parsed.sessionId, parsed.json);
  process.exit(0);
}

const update = parseSegments(parsed.values);
if (!Object.keys(update).length) throw new Error('No model updates were supplied');
const saved = await request(pathWithSession('/api/runtime/models', parsed.sessionId), update, 'POST');
printStatus(saved.config, parsed.sessionId, parsed.json);
if (!parsed.json) console.log(`\nSaved ${saved.scope}.`);
