#!/usr/bin/env node
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || '';
const credentialFile = credentialDirectory ? path.join(credentialDirectory, 'zenos-runtime.env') : '';
if (credentialFile && existsSync(credentialFile)) {
  for (const sourceLine of readFileSync(credentialFile, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const baseUrl = (process.env.ZENOS_MEMORY_BASE_URL || process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
const namespace = process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';
const outputDir = process.env.ZENOS_MEMORY_SECONDARY_BACKUP_DIR || '/var/backups/zenos-memory';
const retention = Math.max(3, Math.min(Number(process.env.ZENOS_MEMORY_SECONDARY_BACKUP_KEEP || 14), 90));
const masterSecret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET || '';
const apiKey = process.env.ZENOS_MEMORY_API_KEY || '';
const encryptionSecret = process.env.ZENOS_BACKUP_ENCRYPTION_KEY || masterSecret || apiKey;

if (!encryptionSecret) throw new Error('Secondary backup refused: no encryption secret is configured');

function tokenHeaders(scopes = ['memory:read']) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = [
    'zenos-memory-signature-v2',
    String(timestamp),
    nonce,
    'POST',
    '/api/auth',
    emptyHash,
  ].join('\n');
  return {
    'content-type': 'application/json',
    'x-etla-timestamp': String(timestamp),
    'x-etla-nonce': nonce,
    'x-etla-content-sha256': emptyHash,
    'x-etla-signature': crypto.createHmac('sha256', masterSecret).update(canonical).digest('hex'),
    'x-etla-client-id': 'zenos-secondary-backup',
    'x-etla-requested-scopes': scopes.join(' '),
  };
}

async function authorization() {
  if (!masterSecret) {
    if (!apiKey) throw new Error('Zenos Memory authentication is not configured');
    return `Bearer ${apiKey}`;
  }
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: tokenHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Memory token exchange failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload.token !== 'string' || payload.token.length < 16) {
    throw new Error('Memory token exchange returned no usable token');
  }
  return `Bearer ${payload.token}`;
}

function encrypt(payload) {
  const plaintext = Buffer.from(JSON.stringify(payload));
  const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  const compressed = gzipSync(plaintext, { level: 9 });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(encryptionSecret, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: 'zenos-memory-secondary-backup-v1',
    created_at: new Date().toISOString(),
    namespace,
    checksum,
    compression: 'gzip',
    encryption: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function verify(envelope) {
  const key = crypto.scryptSync(encryptionSecret, Buffer.from(envelope.salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const plaintext = gunzipSync(compressed);
  return crypto.createHash('sha256').update(plaintext).digest('hex') === envelope.checksum;
}

async function main() {
  const auth = await authorization();
  const url = new URL(`${baseUrl}/api/memory/export`);
  url.searchParams.set('namespace', namespace);
  url.searchParams.set('format', 'json');
  const response = await fetch(url, {
    headers: { authorization: auth, accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Memory export failed with HTTP ${response.status}`);
  const exported = await response.json();
  if (!exported?.success || !exported?.exported) throw new Error('Memory export returned an invalid contract');

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const envelope = encrypt(exported);
  if (!verify(envelope)) throw new Error('Encrypted backup failed immediate verification');

  const stamp = envelope.created_at.replace(/[:.]/g, '-');
  const target = path.join(outputDir, `zenos-memory-${namespace}-${stamp}.json.enc`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
  renameSync(temporary, target);
  chmodSync(target, 0o600);

  const persisted = JSON.parse(readFileSync(target, 'utf8'));
  if (!verify(persisted)) {
    rmSync(target, { force: true });
    throw new Error('Persisted encrypted backup failed verification');
  }

  const backups = readdirSync(outputDir)
    .filter((name) => name.startsWith(`zenos-memory-${namespace}-`) && name.endsWith('.json.enc'))
    .sort()
    .reverse();
  for (const stale of backups.slice(retention)) rmSync(path.join(outputDir, stale), { force: true });

  console.log(JSON.stringify({
    ok: true,
    destination: target,
    namespace,
    count: Number(exported.exported.count || 0),
    checksum: envelope.checksum,
    verified: true,
    retained: Math.min(backups.length, retention),
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    service: 'zenos-memory-secondary-backup',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
