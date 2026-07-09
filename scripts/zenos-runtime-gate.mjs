#!/usr/bin/env node

const request = process.argv.slice(2).join(' ').trim();
if (!request) {
  console.error('Usage: zenos-runtime-gate <user request>');
  process.exit(2);
}

const seriousPatterns = [
  /fix|bug|patch|implement|refactor|code|repo|file|log|trace|error/i,
  /deploy|production|prod|release|rollback|delete|reset|rm -rf|destructive/i,
  /secret|credential|token|api key|password|auth|oauth|jwt|private key/i,
  /browser|search|research|scrape|website|url/i,
  /summarize|ringkas|extract|compare|audit|review|test|lint|build/i,
];

const required = seriousPatterns.some((pattern) => pattern.test(request));
const payload = {
  request,
  hasFiles: /repo|file|code|bug|patch|implement|refactor|test|lint|build/i.test(request),
  hasLogs: /log|trace|error/i.test(request),
  hasCodeChangeIntent: /fix|bug|patch|implement|refactor/i.test(request),
  userRequestedVerification: /review|audit|verify|cek/i.test(request),
  estimatedContextTokens: required ? 6000 : 500,
};

if (!required) {
  console.log(JSON.stringify({ required: false, reason: 'direct_fast_path_allowed', payload }, null, 2));
  process.exit(0);
}

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || process.env.ZENOS_MEMORY_API_KEY || 'local-dev';

const res = await fetch(`${baseUrl}/api/runtime/session`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = text; }

if (!res.ok) {
  console.log(JSON.stringify({ required: true, ok: false, error: data }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ required: true, ok: true, runtime: data }, null, 2));
