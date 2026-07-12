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
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadEnv('.env.local');
loadEnv('.env');

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
  intent: /\b(execute|jalankan|sekarang|now)\b/i.test(request)
    ? 'execute'
    : /\b(fix|patch|implement|refactor|ubah|perbaiki)\b/i.test(request)
      ? 'mutate'
      : /\b(plan|rencana|rancang|architecture|arsitektur|design|desain)\b/i.test(request)
        ? 'plan'
        : /\b(explain|jelaskan)\b/i.test(request)
          ? 'explain'
          : 'analyze',
};

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || '';
if (!apiKey) throw new Error('ZENOS_RUNTIME_API_KEY is required');

const res = await fetch(`${baseUrl}/api/runtime/route`, {
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

console.log(JSON.stringify({ ok: true, payload, route: data }, null, 2));
