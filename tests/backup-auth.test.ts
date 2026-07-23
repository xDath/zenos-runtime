import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  authorization,
  buildTokenExchangeHeaders,
} from '../scripts/backup-zenos-memory.mjs';

test('secondary backup signs kid-bound Memory token exchange with the v3 canonical contract', () => {
  const secret = 's'.repeat(64);
  const kid = 'memory-2026-07-test';
  const timestamp = 1_784_817_600_000;
  const nonce = 'fixed_nonce_for_backup_auth';
  const headers = buildTokenExchangeHeaders({
    secret,
    kid,
    scopes: ['memory:read'],
    timestamp,
    nonce,
  });
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = [
    'zenos-memory-signature-v3',
    kid,
    String(timestamp),
    nonce,
    'POST',
    '/api/auth',
    emptyHash,
  ].join('\n');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  assert.equal(headers['x-etla-kid'], kid);
  assert.equal(headers['x-etla-signature-version'], '3');
  assert.equal(headers['x-etla-signature'], expected);
  assert.equal(headers['x-etla-requested-scopes'], 'memory:read');
});

test('secondary backup keeps v2 migration fallback when no signing kid is configured', () => {
  const secret = 'l'.repeat(64);
  const timestamp = 1_784_817_600_000;
  const nonce = 'fixed_nonce_for_legacy_auth';
  const headers = buildTokenExchangeHeaders({ secret, timestamp, nonce });
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = [
    'zenos-memory-signature-v2',
    String(timestamp),
    nonce,
    'POST',
    '/api/auth',
    emptyHash,
  ].join('\n');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  assert.equal(headers['x-etla-kid'], undefined);
  assert.equal(headers['x-etla-signature-version'], undefined);
  assert.equal(headers['x-etla-signature'], expected);
});

test('secondary backup authorization verifies the returned signing kid', async () => {
  let observedHeaders: Headers | undefined;
  const bearer = await authorization({
    memoryBaseUrl: 'https://memory.test',
    secret: 'k'.repeat(64),
    kid: 'current-kid',
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({ token: 'zm2.current-kid.usable-token-value', kid: 'current-kid' });
    },
  });

  assert.equal(bearer, 'Bearer zm2.current-kid.usable-token-value');
  assert.equal(observedHeaders?.get('x-etla-kid'), 'current-kid');

  await assert.rejects(() => authorization({
    memoryBaseUrl: 'https://memory.test',
    secret: 'k'.repeat(64),
    kid: 'current-kid',
    fetchImpl: async () => Response.json({
      token: 'zm2.other-kid.usable-token-value',
      kid: 'other-kid',
    }),
  }), /unexpected signing key/i);
});
