#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const once = args.includes('--once');
const requestedSession = args.find((arg) => !arg.startsWith('--'));
const productionDbPath = '/var/lib/zenos-runtime/runtime.db';
const dbPath = process.env.ZENOS_RUNTIME_DB_PATH
  || (fs.existsSync(productionDbPath) ? productionDbPath : path.join(process.cwd(), '.data', 'runtime.db'));
const configPath = process.env.ZENOS_RUNTIME_CONFIG_PATH
  || path.join(os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json');

if (!fs.existsSync(dbPath)) {
  console.error(`Runtime database not found: ${dbPath}`);
  process.exit(1);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

function roleModels(config) {
  return {
    host: config.hostModel || process.env.ZENOS_HOST_MODEL || 'grok',
    worker: config.workerModel || process.env.ZENOS_WORKER_MODEL || 'build',
    verifier: config.verifierModel || process.env.ZENOS_VERIFIER_MODEL || 'grok',
    boss: config.bossModel || process.env.ZENOS_BOSS_MODEL || config.hostModel || 'codex',
  };
}

function parseJson(value, fallback = {}) {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const hasCodingTasks = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coding_tasks'").get());
const session = requestedSession
  ? db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(requestedSession)
  : db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1').get();

if (!session) {
  console.error(requestedSession ? `Session not found: ${requestedSession}` : 'No Runtime sessions exist yet.');
  db.close();
  process.exit(1);
}

const sessionId = String(session.session_id);
const models = roleModels(readConfig());
console.log(`Etla Runtime watch · session ${sessionId}`);
console.log(`goal: ${text(session.user_goal, 240)}`);
console.log(`models: Host=${models.host} Worker=${models.worker} Verifier=${models.verifier} Boss=${models.boss}`);
console.log('Watching persisted role/tool events. Ctrl+C to stop.\n');

const latestEvent = db.prepare('SELECT MAX(event_id) AS max_event_id FROM worker_events WHERE session_id = ?').get(sessionId);
let lastEventId = Math.max(0, Number(latestEvent?.max_event_id || 0) - 100);
let lastCodingVersion = 0;
let lastSessionVersion = -1;

function printSnapshot() {
  const current = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  if (!current) {
    console.log('[session] removed');
    return false;
  }
  const version = Number(current.version || 0);
  if (version !== lastSessionVersion) {
    lastSessionVersion = version;
    const budget = parseJson(current.budget_json, {});
    console.log(`[session] ${current.status} · v${version} · calls=${budget.modelCallsUsed || 0} · host=${budget.hostTokensUsed || 0}t worker=${budget.workerTokensUsed || 0}t verifier=${budget.verifierTokensUsed || 0}t boss=${budget.premiumTokensUsed || 0}t`);
  }

  const events = db.prepare(`
    SELECT event_id, worker_id, type, summary, metadata_json, created_at
    FROM worker_events
    WHERE session_id = ? AND event_id > ?
    ORDER BY event_id ASC
  `).all(sessionId, lastEventId);
  for (const event of events) {
    lastEventId = Math.max(lastEventId, Number(event.event_id || 0));
    const metadata = parseJson(event.metadata_json, {});
    const role = String(metadata.role || event.worker_id || 'runtime').replace(/^runtime-/, '');
    const model = metadata.model ? ` · ${metadata.model}` : '';
    const tool = metadata.tool ? ` · ${metadata.tool}:${metadata.status || event.type}` : '';
    console.log(`[${event.created_at}] ${role.toUpperCase()}${model}${tool} — ${text(event.summary, 500)}`);
  }

  const coding = hasCodingTasks ? db.prepare(`
    SELECT task_id, status, phase, state_json, updated_at
    FROM coding_tasks
    WHERE session_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(sessionId) : undefined;
  if (coding) {
    const state = parseJson(coding.state_json, {});
    const version = Number(state.version || 0);
    if (version !== lastCodingVersion) {
      lastCodingVersion = version;
      const changed = Array.isArray(state.filesChanged) ? state.filesChanged.join(', ') : '';
      const validations = Array.isArray(state.validations)
        ? state.validations.slice(-4).map((item) => `${item.kind}:${item.status}`).join(', ')
        : '';
      console.log(`[coding] ${coding.task_id} · ${coding.status}/${coding.phase} · files=${changed || 'none'} · checks=${validations || 'none'}`);
    }
  }

  return !['done', 'failed', 'cancelled'].includes(String(current.status));
}

try {
  const active = printSnapshot();
  if (once || !active) {
    db.close();
    process.exit(0);
  }
  const timer = setInterval(() => {
    try {
      if (!printSnapshot()) {
        clearInterval(timer);
        db.close();
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }, 1_000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
} catch (error) {
  db.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
