#!/usr/bin/env node
import * as crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

function loadCredentialFile() {
  const directory = process.env.CREDENTIALS_DIRECTORY || '';
  const file = directory ? `${directory}/zenos-runtime.env` : '';
  if (!file || !existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function tokenHeaders(secret) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = [
    'zenos-memory-signature-v2',
    String(timestamp),
    nonce,
    'POST',
    '/api/auth',
    bodyHash,
  ].join('\n');
  return {
    'content-type': 'application/json',
    'x-etla-timestamp': String(timestamp),
    'x-etla-nonce': nonce,
    'x-etla-content-sha256': bodyHash,
    'x-etla-signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex'),
    'x-etla-client-id': 'zenos-memory-prewarm-v1',
    'x-etla-requested-scopes': 'memory:read',
  };
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON data`);
  }
}

async function main() {
  loadCredentialFile();
  const baseUrl = (process.env.ZENOS_MEMORY_BASE_URL
    || process.env.ZENOS_MEMORY_URL
    || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
  const secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET || '';
  const namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
  const timeoutMs = Math.max(10_000, Math.min(Number(process.env.ZENOS_MEMORY_HEALTH_TIMEOUT_MS || 25_000), 90_000));
  if (!secret) throw new Error('Zenos Memory HMAC secret is not configured');

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const auth = await readJson(await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: tokenHeaders(secret),
      signal: controller.signal,
      cache: 'no-store',
    }), 'Memory token exchange');
    if (typeof auth.token !== 'string' || auth.token.length < 16) {
      throw new Error('Memory token exchange returned no scoped token');
    }
    const status = await readJson(await fetch(`${baseUrl}/api/memory/authenticated-status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ namespace }),
      signal: controller.signal,
      cache: 'no-store',
    }), 'Memory authenticated status');
    if (!status.authenticated || !status.storage_readable) {
      throw new Error('Memory authenticated status is not ready');
    }
    console.log(JSON.stringify({
      ok: true,
      service: 'zenos-memory-prewarm',
      namespace,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    const message = error instanceof Error
      ? error.name === 'AbortError' ? `Memory prewarm timed out after ${timeoutMs} ms` : error.message
      : String(error);
    console.error(JSON.stringify({
      ok: false,
      service: 'zenos-memory-prewarm',
      error: message.slice(0, 300),
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

await main();
