import * as crypto from 'node:crypto';
import { getRuntimeStore } from './zenos-runtime-store';
import { hashForLog, log } from './logger';

export type RuntimeScope =
  | 'runtime:read'
  | 'runtime:route'
  | 'runtime:run'
  | 'runtime:session'
  | 'runtime:worker'
  | 'runtime:models'
  | 'runtime:admin'
  | 'runtime:metrics'
  | '*';

export type AuthContext = {
  method: 'api_key' | 'token' | 'hmac_v2' | 'hmac_legacy' | 'development';
  clientId: string;
  scopes: string[];
  legacy: boolean;
};

export type AuthorizationResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 401 | 403 | 413; error: string };

type TokenClaims = {
  v: 2;
  sub: string;
  scopes: string[];
  iat: number;
  exp: number;
  nonce: string;
};

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hmacHex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function sha256Hex(value: Uint8Array | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pathWithQuery(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search || ''}`;
}

function bearerOrApiKey(request: Request): string {
  const authHeader = request.headers.get('authorization') || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim() || request.headers.get('x-api-key')?.trim() || '';
}

function normalizeTimestamp(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function scopeAllowed(scopes: string[], requiredScope: RuntimeScope): boolean {
  return requiredScope === '*' || scopes.includes('*') || scopes.includes(requiredScope);
}

function runtimeSecret(): string {
  return process.env.ETLA_MASTER_SECRET || '';
}

function runtimeApiKey(): string {
  return process.env.ZENOS_RUNTIME_API_KEY || '';
}

function legacyHmacAllowed(): boolean {
  return process.env.ZENOS_ALLOW_LEGACY_HMAC === 'true';
}

function insecureDevelopmentAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ZENOS_DEV_ALLOW_INSECURE === 'true';
}

function parseV2Token(token: string, secret: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'zrt2') return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const signature = parts[2];
    if (!safeEqual(signature, hmacHex(secret, `zrt2.${parts[1]}`))) return null;
    const claims = JSON.parse(payload) as Partial<TokenClaims>;
    if (claims.v !== 2 || typeof claims.sub !== 'string' || !Array.isArray(claims.scopes)) return null;
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || typeof claims.nonce !== 'string') return null;
    const now = Date.now();
    if (claims.exp <= now || claims.iat > now + 30_000) return null;
    return claims as TokenClaims;
  } catch {
    return null;
  }
}

function verifyLegacyToken(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [data, signature] = parts;
  const expiry = Number(data);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  return safeEqual(signature, hmacHex(secret, data));
}

async function requestBodyHash(request: Request, maxBodyBytes: number): Promise<{ hash: string; size: number } | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return { hash: sha256Hex(''), size: 0 };
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > maxBodyBytes) return null;
  const body = new Uint8Array(await request.clone().arrayBuffer());
  if (body.byteLength > maxBodyBytes) return null;
  return { hash: sha256Hex(body), size: body.byteLength };
}

export async function authorizeRequest(
  request: Request,
  requiredScope: RuntimeScope,
  options: { maxBodyBytes?: number } = {},
): Promise<AuthorizationResult> {
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const provided = bearerOrApiKey(request);
  const apiKey = runtimeApiKey();

  if (apiKey && provided && safeEqual(provided, apiKey)) {
    return { ok: true, context: { method: 'api_key', clientId: 'runtime-api-key', scopes: ['*'], legacy: false } };
  }

  const secret = runtimeSecret();
  if (secret && provided) {
    const claims = parseV2Token(provided, secret);
    if (claims) {
      if (!scopeAllowed(claims.scopes, requiredScope)) return { ok: false, status: 403, error: 'Token scope does not permit this operation' };
      return { ok: true, context: { method: 'token', clientId: claims.sub, scopes: claims.scopes, legacy: false } };
    }
    if (legacyHmacAllowed() && verifyLegacyToken(provided, secret)) {
      log('warn', 'Legacy Etla token accepted', { tokenHash: hashForLog(provided), requiredScope });
      return { ok: true, context: { method: 'token', clientId: 'legacy-token', scopes: ['*'], legacy: true } };
    }
  }

  if (secret) {
    const timestampRaw = request.headers.get('x-etla-timestamp') || '';
    const signature = request.headers.get('x-etla-signature') || '';
    const timestamp = normalizeTimestamp(timestampRaw);
    if (timestamp && signature) {
      const maxSkewMs = Math.max(15_000, Number(process.env.ZENOS_HMAC_MAX_SKEW_MS || '90000'));
      if (Math.abs(Date.now() - timestamp) > maxSkewMs) return { ok: false, status: 401, error: 'Expired request signature' };

      const nonce = request.headers.get('x-etla-nonce')?.trim() || '';
      const clientId = request.headers.get('x-etla-client')?.trim() || 'etla-client';
      const declaredScope = request.headers.get('x-etla-scope')?.trim() || requiredScope;
      const path = pathWithQuery(request);

      if (nonce) {
        if (!/^[A-Za-z0-9._:-]{12,200}$/.test(nonce)) return { ok: false, status: 401, error: 'Invalid request nonce' };
        const body = await requestBodyHash(request, maxBodyBytes);
        if (!body) return { ok: false, status: 413, error: 'Request body is too large' };
        const suppliedBodyHash = request.headers.get('x-etla-body-sha256')?.trim().toLowerCase() || '';
        if (!safeEqual(suppliedBodyHash, body.hash)) return { ok: false, status: 401, error: 'Request body hash mismatch' };
        const payload = [
          'v2',
          String(timestamp),
          nonce,
          request.method.toUpperCase(),
          path,
          body.hash,
          declaredScope,
          clientId,
        ].join('\n');
        if (!safeEqual(signature, hmacHex(secret, payload))) return { ok: false, status: 401, error: 'Invalid request signature' };
        if (declaredScope !== '*' && declaredScope !== requiredScope) return { ok: false, status: 403, error: 'Signed scope does not match operation' };
        const expiresAt = new Date(timestamp + maxSkewMs).toISOString();
        if (!getRuntimeStore().claimNonce(nonce, clientId, expiresAt)) return { ok: false, status: 401, error: 'Request nonce has already been used' };
        return { ok: true, context: { method: 'hmac_v2', clientId, scopes: [declaredScope], legacy: false } };
      }

      if (legacyHmacAllowed()) {
        const payload = `${timestamp}:${request.method.toUpperCase()}:${path}`;
        if (safeEqual(signature, hmacHex(secret, payload))) {
          log('warn', 'Legacy path-only HMAC accepted', { clientId, path, requiredScope });
          return { ok: true, context: { method: 'hmac_legacy', clientId, scopes: ['*'], legacy: true } };
        }
      }
    }
  }

  if (insecureDevelopmentAllowed()) {
    return { ok: true, context: { method: 'development', clientId: 'development', scopes: ['*'], legacy: false } };
  }

  return { ok: false, status: 401, error: 'Unauthorized' };
}

export function issueScopedToken(
  secret: string,
  options: { subject?: string; scopes?: RuntimeScope[]; ttlMs?: number } = {},
): string {
  const now = Date.now();
  const claims: TokenClaims = {
    v: 2,
    sub: options.subject || 'etla-client',
    scopes: options.scopes?.length ? options.scopes : ['runtime:read'],
    iat: now,
    exp: now + Math.min(Math.max(options.ttlMs || 15 * 60 * 1000, 30_000), 24 * 60 * 60 * 1000),
    nonce: crypto.randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `zrt2.${encoded}.${hmacHex(secret, `zrt2.${encoded}`)}`;
}

export function issueEtlaToken(secret: string, ttlMs = 15 * 60 * 1000): string {
  return issueScopedToken(secret, { scopes: ['*'], ttlMs });
}

export function verifyEtlaToken(token: string, secret: string): boolean {
  return Boolean(parseV2Token(token, secret)) || (legacyHmacAllowed() && verifyLegacyToken(token, secret));
}

export function verifyEtlaSignature(request: Request, secret: string): boolean {
  const timestampRaw = request.headers.get('x-etla-timestamp') || '';
  const signature = request.headers.get('x-etla-signature') || '';
  const timestamp = normalizeTimestamp(timestampRaw);
  if (!timestamp || !signature || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;
  const payload = `${timestamp}:${request.method.toUpperCase()}:${pathWithQuery(request)}`;
  return safeEqual(signature, hmacHex(secret, payload));
}

export function validateApiKey(request: Request): boolean {
  const provided = bearerOrApiKey(request);
  const apiKey = runtimeApiKey();
  if (apiKey && provided && safeEqual(provided, apiKey)) return true;
  const secret = runtimeSecret();
  if (secret && provided && verifyEtlaToken(provided, secret)) return true;
  if (secret && legacyHmacAllowed() && verifyEtlaSignature(request, secret)) return true;
  return insecureDevelopmentAllowed();
}

export function authConfigurationStatus(): {
  configured: boolean;
  apiKeyConfigured: boolean;
  hmacConfigured: boolean;
  legacyHmacAllowed: boolean;
  failClosed: boolean;
} {
  return {
    configured: Boolean(runtimeApiKey() || runtimeSecret()),
    apiKeyConfigured: Boolean(runtimeApiKey()),
    hmacConfigured: Boolean(runtimeSecret()),
    legacyHmacAllowed: legacyHmacAllowed(),
    failClosed: process.env.NODE_ENV === 'production' || !insecureDevelopmentAllowed(),
  };
}

export function unauthorizedResponse(message = 'Unauthorized', status: 401 | 403 | 413 = 401): Response {
  return Response.json({ ok: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
