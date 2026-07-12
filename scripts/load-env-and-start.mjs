#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

function yamlScalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}:\\s*['\"]?([^'\"\\n#]+)`, 'm'));
  return match?.[1]?.trim() || '';
}

function yamlBlock(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^(\\s*)${escaped}:\\s*$`, 'm');
  const match = marker.exec(text);
  if (!match) return '';
  const indent = match[1].length;
  const rest = text.slice(match.index + match[0].length);
  const lines = [];
  for (const line of rest.split('\n')) {
    if (!line.trim()) {
      lines.push(line);
      continue;
    }
    const currentIndent = line.match(/^\s*/)?.[0].length || 0;
    if (currentIndent <= indent) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function resolveConfigValue(value) {
  const clean = value.trim().replace(/^['\"]|['\"]$/g, '');
  const envMatch = clean.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  return envMatch ? process.env[envMatch[1]] || '' : clean;
}

function configureFromHermes() {
  const configPath = process.env.HERMES_CONFIG_PATH || '/root/.hermes/profiles/zenos/config.yaml';
  if (!existsSync(configPath)) return;
  const text = readFileSync(configPath, 'utf8');
  const providerName = (yamlScalar(text, 'provider') || 'etla-router').replace(/^custom:/, '');
  const block = yamlBlock(text, providerName);
  if (!block) return;

  const baseUrl = yamlScalar(block, 'base_url') || yamlScalar(block, 'url');
  const defaultModel = yamlScalar(block, 'default_model') || yamlScalar(text, 'default');
  const credentialFields = ['api_key', 'api-key', 'apikey', 'token', 'key'];
  let apiKey = '';
  for (const field of credentialFields) {
    const candidate = yamlScalar(block, field);
    if (candidate) {
      apiKey = resolveConfigValue(candidate);
      break;
    }
  }
  if (!apiKey) {
    for (const field of ['api_key_env', 'api-key-env', 'token_env', 'key_env']) {
      const envName = yamlScalar(block, field).replace(/^['\"]|['\"]$/g, '');
      if (envName && process.env[envName]) {
        apiKey = process.env[envName];
        break;
      }
    }
  }

  if (!process.env.ZENOS_LLM_BASE_URL && baseUrl) process.env.ZENOS_LLM_BASE_URL = baseUrl;
  if (!process.env.ZENOS_LLM_API_KEY && apiKey) process.env.ZENOS_LLM_API_KEY = apiKey;
  if (!process.env.ZENOS_HOST_MODEL && defaultModel) process.env.ZENOS_HOST_MODEL = defaultModel;
  if (!process.env.ZENOS_WORKER_MODEL && defaultModel) process.env.ZENOS_WORKER_MODEL = defaultModel;
  if (!process.env.ZENOS_BOSS_MODEL && defaultModel) process.env.ZENOS_BOSS_MODEL = defaultModel;
  if (!process.env.ZENOS_VERIFIER_MODEL && defaultModel) process.env.ZENOS_VERIFIER_MODEL = defaultModel;
  for (const role of ['HOST', 'WORKER', 'BOSS', 'VERIFIER']) {
    if (!process.env[`ZENOS_${role}_PROVIDER`]) process.env[`ZENOS_${role}_PROVIDER`] = providerName;
  }
  if (process.env.ZENOS_LLM_API_KEY && !process.env.ZENOS_MODEL_TRANSPORT) process.env.ZENOS_MODEL_TRANSPORT = 'http';
}

for (const file of [
  '.env.local',
  '.env',
  '/root/.hermes/profiles/zenos/.env',
  '/root/.hermes/.env',
]) loadEnvFile(file);
configureFromHermes();

if (process.env.NODE_ENV === 'production') {
  const authConfigured = Boolean(process.env.ZENOS_RUNTIME_API_KEY || process.env.ETLA_MASTER_SECRET);
  const modelsConfigured = Boolean(
    process.env.ZENOS_LLM_BASE_URL
    && process.env.ZENOS_HOST_MODEL
    && process.env.ZENOS_WORKER_MODEL
    && process.env.ZENOS_BOSS_MODEL
    && process.env.ZENOS_VERIFIER_MODEL,
  );
  if (!authConfigured) throw new Error('Production startup refused: configure ZENOS_RUNTIME_API_KEY or ETLA_MASTER_SECRET');
  const modelConfigPath = process.env.ZENOS_RUNTIME_CONFIG_PATH || '/root/.hermes/profiles/zenos/zenos-runtime.json';
  if (!modelsConfigured && !existsSync(modelConfigPath)) {
    throw new Error('Production startup refused: configure all four runtime model roles');
  }
}

const nextBin = resolve('node_modules/next/dist/bin/next');
if (!existsSync(nextBin)) throw new Error(`Next.js binary not found at ${nextBin}`);
if (!existsSync('.next/BUILD_ID')) throw new Error('Production build is missing. Run npm run build before starting Zenos Runtime.');

const child = spawn(process.execPath, [nextBin, 'start', '-p', process.env.PORT || '3090', '-H', process.env.ZENOS_BIND_HOST || '127.0.0.1'], {
  stdio: 'inherit',
  env: process.env,
});

let shutdownSignal = '';
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    shutdownSignal = signal;
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', service: 'zenos-runtime', message: 'Failed to start Next.js', error: error.message }));
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (shutdownSignal) process.exit(0);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
