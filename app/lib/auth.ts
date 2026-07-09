import * as crypto from 'crypto';

function bearerOrApiKey(request: Request): string {
  const authHeader = request.headers.get('authorization') || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim() || request.headers.get('x-api-key') || '';
}

export function validateApiKey(request: Request): boolean {
  const runtimeApiKey = process.env.ZENOS_RUNTIME_API_KEY;
  const memoryApiKey = process.env.ZENOS_MEMORY_API_KEY;
  const providedKey = bearerOrApiKey(request);

  if (runtimeApiKey && providedKey === runtimeApiKey) return true;
  if (memoryApiKey && providedKey === memoryApiKey) return true;

  const etlaSecret = process.env.ETLA_MASTER_SECRET;
  if (etlaSecret) {
    const token = request.headers.get('x-etla-token') || '';
    if (token && verifyEtlaToken(token, etlaSecret)) return true;
    return verifyEtlaSignature(request, etlaSecret);
  }

  if (!runtimeApiKey && !memoryApiKey) {
    console.warn('[ZenosRuntime] No API key set in env - allowing all (dev only)');
    return true;
  }

  return false;
}

export function verifyEtlaSignature(request: Request, secret: string): boolean {
  const ts = request.headers.get('x-etla-timestamp') || '';
  const sig = request.headers.get('x-etla-signature') || '';

  if (!ts || !sig) {
    return false;
  }

  const now = Date.now();
  const timestamp = parseInt(ts, 10);

  if (isNaN(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return false;
  }

  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const path = url.pathname + (url.search || '');

  const payload = `${timestamp}:${method}:${path}`;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

export function verifyEtlaToken(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [data, sig] = parts;
  const exp = parseInt(data, 10);

  if (isNaN(exp) || Date.now() > exp) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

export function issueEtlaToken(secret: string, ttlMs = 60 * 60 * 1000): string {
  const exp = Date.now() + ttlMs;
  const data = `${exp}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('hex');
  return `${data}.${sig}`;
}

export function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
