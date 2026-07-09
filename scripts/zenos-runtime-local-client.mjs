#!/usr/bin/env node

const baseUrl = (process.env.ZENOS_RUNTIME_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');
const apiKey = process.env.ZENOS_RUNTIME_API_KEY || process.env.ZENOS_MEMORY_API_KEY || '';

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function request(path, body, method = 'POST') {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return data;
}

function parseJsonArg(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return { request: value }; }
}

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === 'help') {
  console.log(`Zenos Runtime local client\n\nCommands:\n  health\n  route <request-or-json>\n  session <request-or-json>\n  dispatch <sessionId> <template> <task>\n  event <json>\n  escalate <sessionId> [hostAssessment]\n  boss-review <sessionId> <decision-json>\n  quality-gate <json>\n  models\n  budget <sessionId>\n`);
  process.exit(0);
}

let out;
switch (cmd) {
  case 'health':
    out = await request('/api/health', null, 'GET');
    break;
  case 'route':
    out = await request('/api/runtime/route', parseJsonArg(args.join(' ')));
    break;
  case 'session':
    out = await request('/api/runtime/session', parseJsonArg(args.join(' ')));
    break;
  case 'dispatch':
    out = await request('/api/runtime/dispatch', { sessionId: args[0], template: args[1], task: args.slice(2).join(' ') });
    break;
  case 'event':
    out = await request('/api/runtime/worker-event', JSON.parse(args.join(' ')));
    break;
  case 'escalate':
    out = await request('/api/runtime/escalate', { sessionId: args[0], hostAssessment: args.slice(1).join(' ') || undefined });
    break;
  case 'boss-review':
    out = await request('/api/runtime/boss-review', { sessionId: args[0], decision: JSON.parse(args.slice(1).join(' ')) });
    break;
  case 'quality-gate':
    out = await request('/api/runtime/quality-gate', JSON.parse(args.join(' ')));
    break;
  case 'models':
    out = await request('/api/runtime/models', null, 'GET');
    break;
  case 'budget':
    out = await request(`/api/runtime/budget/${args[0]}`, null, 'GET');
    break;
  default:
    throw new Error(`Unknown command: ${cmd}`);
}

console.log(JSON.stringify(out, null, 2));
