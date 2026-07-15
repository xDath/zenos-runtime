#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function loadCredentialEnvironment() {
  const directory = process.env.CREDENTIALS_DIRECTORY || '';
  const file = directory ? path.join(directory, 'zenos-runtime.env') : '';
  if (!file || !existsSync(file)) return;
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

loadCredentialEnvironment();

const source = process.env.ZENOS_RUNTIME_DB_PATH || '/var/lib/zenos-runtime/runtime.db';
const outputDirectory = process.env.ZENOS_RUNTIME_BACKUP_DIR || '/var/backups/zenos-runtime';
const retention = Math.max(2, Math.min(Number(process.env.ZENOS_RUNTIME_BACKUP_KEEP || 14), 90));
const secret = process.env.ZENOS_BACKUP_ENCRYPTION_KEY
  || process.env.ZENOS_RUNTIME_BACKUP_SECRET
  || process.env.ETLA_MASTER_SECRET
  || '';

if (!secret) throw new Error('Runtime backup refused: no encryption secret is configured');
if (!existsSync(source)) throw new Error(`Runtime backup source does not exist: ${source}`);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
chmodSync(outputDirectory, 0o700);

const stamp = timestamp();
const snapshot = path.join(outputDirectory, `.runtime-${process.pid}-${stamp}.sqlite`);
const verifySnapshot = path.join(outputDirectory, `.verify-${process.pid}-${stamp}.sqlite`);
const target = path.join(outputDirectory, `zenos-runtime-${stamp}.json.enc`);
const temporaryTarget = `${target}.tmp`;

try {
  const database = new DatabaseSync(source, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  database.close();
  chmodSync(snapshot, 0o600);

  const plaintext = readFileSync(snapshot);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    format: 'zenos-runtime-backup-v1',
    created_at: new Date().toISOString(),
    source: path.basename(source),
    algorithm: 'aes-256-gcm+scrypt',
    plaintext_sha256: sha256(plaintext),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  writeFileSync(temporaryTarget, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  renameSync(temporaryTarget, target);
  chmodSync(target, 0o600);

  const persisted = JSON.parse(readFileSync(target, 'utf8'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    scryptSync(secret, Buffer.from(persisted.salt, 'base64'), 32),
    Buffer.from(persisted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(persisted.tag, 'base64'));
  const restored = Buffer.concat([
    decipher.update(Buffer.from(persisted.ciphertext, 'base64')),
    decipher.final(),
  ]);
  if (sha256(restored) !== persisted.plaintext_sha256) throw new Error('Runtime backup checksum verification failed');
  writeFileSync(verifySnapshot, restored, { mode: 0o600 });
  const verification = new DatabaseSync(verifySnapshot, { readOnly: true });
  const quickCheck = verification.prepare('PRAGMA quick_check').get();
  verification.close();
  if (quickCheck?.quick_check !== 'ok') throw new Error(`Runtime backup SQLite verification failed: ${quickCheck?.quick_check || 'unknown'}`);

  const backups = readdirSync(outputDirectory)
    .filter((name) => /^zenos-runtime-.*\.json\.enc$/.test(name))
    .sort()
    .reverse();
  for (const stale of backups.slice(retention)) rmSync(path.join(outputDirectory, stale), { force: true });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    service: 'zenos-runtime-backup',
    target,
    bytes: readFileSync(target).length,
    retained: Math.min(backups.length, retention),
    integrity: 'ok',
  })}\n`);
} finally {
  rmSync(snapshot, { force: true });
  rmSync(verifySnapshot, { force: true });
  rmSync(temporaryTarget, { force: true });
}
