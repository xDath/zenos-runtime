import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  RuntimeRunRecord,
  RuntimeRunRecordSchema,
  RuntimeSessionState,
  RuntimeSessionStateSchema,
  WorkerEvent,
  WorkerEventSchema,
  WorkerLease,
  WorkerLeaseSchema,
} from './zenos-runtime-state';
import { log } from './logger';

const SCHEMA_VERSION = 5;

function defaultDatabasePath(): string {
  if (process.env.ZENOS_RUNTIME_DB_PATH) return process.env.ZENOS_RUNTIME_DB_PATH;
  if (process.env.NODE_ENV === 'production') return '/var/lib/zenos-runtime/runtime.db';
  return path.join(process.cwd(), '.data', 'runtime.db');
}

function ensureParent(file: string): void {
  if (file === ':memory:') return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

export type IdempotencyRecord = {
  key: string;
  scope: string;
  requestHash: string;
  status: 'running' | 'complete' | 'failed';
  response?: unknown;
  createdAt: string;
  expiresAt: string;
};

export type CodingTaskRecord = {
  taskId: string;
  runId?: string;
  sessionId?: string;
  status: string;
  phase: string;
  state: unknown;
  createdAt: string;
  updatedAt: string;
};

export type OutcomeLedgerRecord = {
  outcomeId: string;
  runId: string;
  sessionId?: string;
  revision: number;
  ledgerVersion: string;
  verdict: string;
  taskType: string;
  pipelineMode: string;
  record: unknown;
  createdAt: string;
};

export type TokenGovernorStoreRecord = {
  budgetId: string;
  limitTokens: number;
  reserveTokens: number;
  spentTokens: number;
  calls: number;
  reservations: Record<string, number>;
  status: 'active' | 'completed';
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
};

export class RuntimeStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(databasePath = defaultDatabasePath()) {
    this.path = databasePath;
    ensureParent(databasePath);
    this.db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    this.configure();
    this.migrate();
    this.migrateLegacyJsonStore();
  }

  private configure(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = FULL;');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000;');
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_goal TEXT NOT NULL,
        status TEXT NOT NULL,
        host_model TEXT NOT NULL,
        boss_model TEXT,
        model_overrides_json TEXT NOT NULL,
        route_decision_json TEXT,
        budget_json TEXT NOT NULL,
        final_answer TEXT,
        last_error TEXT,
        active_run_id TEXT,
        metadata_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        template TEXT NOT NULL,
        model_tier TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        max_tokens INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_session ON workers(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

      CREATE TABLE IF NOT EXISTS worker_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence REAL NOT NULL,
        needs_boss INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON worker_events(session_id, event_id);

      CREATE TABLE IF NOT EXISTS runtime_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_json TEXT,
        result_json TEXT,
        errors_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_session ON runtime_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runtime_runs(status);

      CREATE TABLE IF NOT EXISTS idempotency (
        idempotency_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (idempotency_key, scope)
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency(expires_at);

      CREATE TABLE IF NOT EXISTS auth_nonces (
        nonce TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nonces_expiry ON auth_nonces(expires_at);

      CREATE TABLE IF NOT EXISTS route_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        session_id TEXT,
        namespace TEXT NOT NULL,
        event_json TEXT NOT NULL,
        memory_status TEXT NOT NULL,
        memory_response_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_route_events_created ON route_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS coding_tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_coding_tasks_run ON coding_tasks(run_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coding_tasks_session ON coding_tasks(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coding_tasks_status ON coding_tasks(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS outcome_ledger (
        outcome_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT,
        revision INTEGER NOT NULL,
        ledger_version TEXT NOT NULL,
        verdict TEXT NOT NULL,
        task_type TEXT NOT NULL,
        pipeline_mode TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_run ON outcome_ledger(run_id, revision DESC);
      CREATE INDEX IF NOT EXISTS idx_outcomes_session ON outcome_ledger(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outcomes_task ON outcome_ledger(task_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outcomes_verdict ON outcome_ledger(verdict, created_at DESC);

      CREATE TABLE IF NOT EXISTS token_governors (
        budget_id TEXT PRIMARY KEY,
        limit_tokens INTEGER NOT NULL,
        reserve_tokens INTEGER NOT NULL,
        spent_tokens INTEGER NOT NULL,
        calls INTEGER NOT NULL,
        reservations_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_governors_expiry ON token_governors(expires_at);
      CREATE INDEX IF NOT EXISTS idx_token_governors_status ON token_governors(status, updated_at DESC);
    `);

    const current = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('schema_version');
    const version = Number(asString(current?.value, '0'));
    if (version > SCHEMA_VERSION) {
      throw new Error(`Runtime database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    this.db.prepare(`
      INSERT INTO runtime_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
  }

  private migrateLegacyJsonStore(): void {
    if (this.path === ':memory:' || process.env.ZENOS_RUNTIME_DISABLE_LEGACY_MIGRATION === 'true') return;
    const marker = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('legacy_json_migration');
    if (marker) return;

    const legacyPath = process.env.ZENOS_RUNTIME_LEGACY_STORE_PATH || '/tmp/zenos-runtime-sessions.json';
    if (!fs.existsSync(legacyPath)) return;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as unknown;
    } catch (error) {
      log('warn', 'Legacy Runtime JSON store could not be parsed', { legacyPath, error });
      return;
    }
    if (!Array.isArray(raw)) {
      log('warn', 'Legacy Runtime JSON store has an unsupported shape', { legacyPath });
      return;
    }

    let migrated = 0;
    let existing = 0;
    let skipped = 0;
    this.transaction(() => {
      for (const candidate of raw) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          skipped += 1;
          continue;
        }
        const source = candidate as Record<string, unknown>;
        const createdAt = typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString();
        const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : createdAt;
        const route = source.routeDecision && typeof source.routeDecision === 'object' && !Array.isArray(source.routeDecision)
          ? source.routeDecision as Record<string, unknown>
          : undefined;
        const workers = Array.isArray(source.workers)
          ? source.workers.map((worker) => worker && typeof worker === 'object' && !Array.isArray(worker)
            ? {
                ...(worker as Record<string, unknown>),
                attempts: (worker as Record<string, unknown>).attempts ?? 0,
                createdAt: (worker as Record<string, unknown>).createdAt ?? createdAt,
                updatedAt: (worker as Record<string, unknown>).updatedAt ?? updatedAt,
              }
            : worker)
          : [];
        const normalized = {
          ...source,
          createdAt,
          updatedAt,
          version: source.version ?? 1,
          metadata: source.metadata ?? { migratedFrom: 'legacy-json-v1' },
          workers,
          routeDecision: route ? {
            policyVersion: route.policyVersion ?? 'legacy-v1',
            useBoss: route.useBoss ?? false,
            requiresApproval: route.requiresApproval ?? false,
            requiresSourceContext: route.requiresSourceContext ?? Boolean(route.useTools),
            maxRevisionAttempts: route.maxRevisionAttempts ?? (route.useVerifier ? 1 : 0),
            ...route,
          } : undefined,
        };
        const parsed = RuntimeSessionStateSchema.safeParse(normalized);
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        const session = parsed.data;
        const present = this.db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(session.sessionId);
        if (present) {
          existing += 1;
          continue;
        }
        this.saveSession(session);
        for (const worker of session.workers) this.saveWorker(session.sessionId, worker);
        for (const event of session.events) this.insertEvent(event);
        migrated += 1;
      }
      this.db.prepare(`
        INSERT INTO runtime_meta(key, value) VALUES('legacy_json_migration', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify({ legacyPath, migrated, existing, skipped, migratedAt: new Date().toISOString() }));
    });

    log('info', 'Legacy Runtime JSON migration completed', { legacyPath, migrated, existing, skipped });
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = work();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // The original failure is more useful than a secondary rollback error.
      }
      throw error;
    }
  }

  getMetaValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key);
    return row ? asString(row.value) : undefined;
  }

  setMetaValue(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO runtime_meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getTokenGovernor(budgetId: string): TokenGovernorStoreRecord | undefined {
    const row = this.db.prepare('SELECT * FROM token_governors WHERE budget_id = ?').get(budgetId);
    if (!row || asString(row.status) !== 'active') return undefined;
    return {
      budgetId: asString(row.budget_id),
      limitTokens: asNumber(row.limit_tokens),
      reserveTokens: asNumber(row.reserve_tokens),
      spentTokens: asNumber(row.spent_tokens),
      calls: asNumber(row.calls),
      reservations: parseJson<Record<string, number>>(row.reservations_json, {}),
      status: 'active',
      updatedAt: asString(row.updated_at),
      expiresAt: asString(row.expires_at),
      completedAt: row.completed_at ? asString(row.completed_at) : undefined,
    };
  }

  saveTokenGovernor(record: TokenGovernorStoreRecord): void {
    this.db.prepare(`
      INSERT INTO token_governors(
        budget_id, limit_tokens, reserve_tokens, spent_tokens, calls,
        reservations_json, status, updated_at, expires_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(budget_id) DO UPDATE SET
        limit_tokens = excluded.limit_tokens,
        reserve_tokens = excluded.reserve_tokens,
        spent_tokens = excluded.spent_tokens,
        calls = excluded.calls,
        reservations_json = excluded.reservations_json,
        status = excluded.status,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at,
        completed_at = excluded.completed_at
    `).run(
      record.budgetId,
      record.limitTokens,
      record.reserveTokens,
      record.spentTokens,
      record.calls,
      json(record.reservations),
      record.status,
      record.updatedAt,
      record.expiresAt,
      record.completedAt || null,
    );
  }

  completeTokenGovernor(budgetId: string, completedAt = new Date().toISOString()): void {
    const retention = new Date(Date.parse(completedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    this.db.prepare(`
      UPDATE token_governors
      SET status = 'completed', reservations_json = '{}', updated_at = ?, completed_at = ?, expires_at = ?
      WHERE budget_id = ?
    `).run(completedAt, completedAt, retention, budgetId);
  }

  pruneTokenGovernors(now = new Date().toISOString()): number {
    return Number(this.db.prepare('DELETE FROM token_governors WHERE expires_at <= ?').run(now).changes);
  }

  saveSession(input: RuntimeSessionState): RuntimeSessionState {
    const session = RuntimeSessionStateSchema.parse(input);
    this.db.prepare(`
      INSERT INTO sessions(
        session_id, user_goal, status, host_model, boss_model, model_overrides_json,
        route_decision_json, budget_json, final_answer, last_error, active_run_id,
        metadata_json, version, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        user_goal = excluded.user_goal,
        status = excluded.status,
        host_model = excluded.host_model,
        boss_model = excluded.boss_model,
        model_overrides_json = excluded.model_overrides_json,
        route_decision_json = excluded.route_decision_json,
        budget_json = excluded.budget_json,
        final_answer = excluded.final_answer,
        last_error = excluded.last_error,
        active_run_id = excluded.active_run_id,
        metadata_json = excluded.metadata_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(
      session.sessionId,
      session.userGoal,
      session.status,
      session.hostModel,
      session.bossModel || null,
      json(session.modelOverrides),
      session.routeDecision ? json(session.routeDecision) : null,
      json(session.budget),
      session.finalAnswer || null,
      session.lastError || null,
      session.activeRunId || null,
      json(session.metadata),
      session.version,
      session.createdAt,
      session.updatedAt,
    );
    return session;
  }

  saveWorker(sessionId: string, input: WorkerLease): WorkerLease {
    const worker = WorkerLeaseSchema.parse(input);
    this.db.prepare(`
      INSERT INTO workers(
        worker_id, session_id, template, model_tier, task, status, max_tokens,
        attempts, result_json, error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        template = excluded.template,
        model_tier = excluded.model_tier,
        task = excluded.task,
        status = excluded.status,
        max_tokens = excluded.max_tokens,
        attempts = excluded.attempts,
        result_json = excluded.result_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      worker.workerId,
      sessionId,
      worker.template,
      worker.modelTier,
      worker.task,
      worker.status,
      worker.maxTokens,
      worker.attempts,
      worker.result === undefined ? null : json(worker.result),
      worker.error || null,
      worker.createdAt,
      worker.updatedAt,
    );
    return worker;
  }

  insertEvent(input: WorkerEvent): WorkerEvent {
    const event = WorkerEventSchema.parse(input);
    const createdAt = event.createdAt || new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO worker_events(
        session_id, worker_id, type, summary, evidence_json, severity,
        confidence, needs_boss, metadata_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.workerId,
      event.type,
      event.summary,
      json(event.evidence),
      event.severity,
      event.confidence,
      event.needsBoss ? 1 : 0,
      json(event.metadata),
      createdAt,
    );
    return WorkerEventSchema.parse({ ...event, eventId: Number(result.lastInsertRowid), createdAt });
  }

  private loadWorkers(sessionId: string): WorkerLease[] {
    return this.db.prepare('SELECT * FROM workers WHERE session_id = ? ORDER BY created_at ASC').all(sessionId).map((row) => WorkerLeaseSchema.parse({
      workerId: asString(row.worker_id),
      template: asString(row.template),
      modelTier: asString(row.model_tier),
      task: asString(row.task),
      status: asString(row.status),
      maxTokens: asNumber(row.max_tokens),
      attempts: asNumber(row.attempts),
      result: row.result_json ? parseJson(row.result_json, null) : undefined,
      error: row.error ? asString(row.error) : undefined,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  private loadEvents(sessionId: string, limit = 2_000): WorkerEvent[] {
    return this.db.prepare(`
      SELECT * FROM worker_events WHERE session_id = ? ORDER BY event_id ASC LIMIT ?
    `).all(sessionId, limit).map((row) => WorkerEventSchema.parse({
      eventId: asNumber(row.event_id),
      sessionId: asString(row.session_id),
      workerId: asString(row.worker_id),
      type: asString(row.type),
      summary: asString(row.summary),
      evidence: parseJson<string[]>(row.evidence_json, []),
      severity: asString(row.severity),
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.75,
      needsBoss: asNumber(row.needs_boss) === 1,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: asString(row.created_at),
    }));
  }

  listEvents(options: {
    limit?: number;
    sessionId?: string;
    since?: string;
    afterEventId?: number;
  } = {}): WorkerEvent[] {
    const limit = Math.min(Math.max(options.limit || 500, 1), 10_000);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.sessionId) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.since) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.afterEventId && options.afterEventId > 0) {
      clauses.push('event_id > ?');
      params.push(options.afterEventId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const ascending = Boolean(options.afterEventId);
    const rows = this.db.prepare(`
      SELECT * FROM worker_events ${where}
      ORDER BY event_id ${ascending ? 'ASC' : 'DESC'} LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => WorkerEventSchema.parse({
      eventId: asNumber(row.event_id),
      sessionId: asString(row.session_id),
      workerId: asString(row.worker_id),
      type: asString(row.type),
      summary: asString(row.summary),
      evidence: parseJson<string[]>(row.evidence_json, []),
      severity: asString(row.severity),
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.75,
      needsBoss: asNumber(row.needs_boss) === 1,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: asString(row.created_at),
    }));
  }

  private hydrateSession(row: Record<string, unknown>): RuntimeSessionState {
    const sessionId = asString(row.session_id);
    return RuntimeSessionStateSchema.parse({
      sessionId,
      userGoal: asString(row.user_goal),
      status: asString(row.status),
      hostModel: asString(row.host_model, 'standard'),
      bossModel: row.boss_model ? asString(row.boss_model) : undefined,
      modelOverrides: parseJson<Record<string, unknown>>(row.model_overrides_json, {}),
      routeDecision: row.route_decision_json ? parseJson(row.route_decision_json, undefined) : undefined,
      workers: this.loadWorkers(sessionId),
      events: this.loadEvents(sessionId),
      budget: parseJson<Record<string, unknown>>(row.budget_json, {}),
      finalAnswer: row.final_answer ? asString(row.final_answer) : undefined,
      lastError: row.last_error ? asString(row.last_error) : undefined,
      activeRunId: row.active_run_id ? asString(row.active_run_id) : undefined,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      version: asNumber(row.version, 1),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    });
  }

  getSession(sessionId: string): RuntimeSessionState | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    return row ? this.hydrateSession(row) : undefined;
  }

  listSessions(limit = 100): RuntimeSessionState[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(safeLimit).map((row) => this.hydrateSession(row));
  }

  getWorker(workerId: string): WorkerLease | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId);
    if (!row) return undefined;
    return WorkerLeaseSchema.parse({
      workerId: asString(row.worker_id),
      template: asString(row.template),
      modelTier: asString(row.model_tier),
      task: asString(row.task),
      status: asString(row.status),
      maxTokens: asNumber(row.max_tokens),
      attempts: asNumber(row.attempts),
      result: row.result_json ? parseJson(row.result_json, null) : undefined,
      error: row.error ? asString(row.error) : undefined,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    });
  }

  saveRun(input: RuntimeRunRecord): RuntimeRunRecord {
    const run = RuntimeRunRecordSchema.parse(input);
    this.db.prepare(`
      INSERT INTO runtime_runs(
        run_id, session_id, request_hash, status, decision_json, result_json,
        errors_json, started_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        session_id = excluded.session_id,
        status = excluded.status,
        decision_json = excluded.decision_json,
        result_json = excluded.result_json,
        errors_json = excluded.errors_json,
        completed_at = excluded.completed_at
    `).run(
      run.runId,
      run.sessionId || null,
      run.requestHash,
      run.status,
      run.decision ? json(run.decision) : null,
      run.result === undefined ? null : json(run.result),
      json(run.errors),
      run.startedAt,
      run.completedAt || null,
    );
    return run;
  }

  getRun(runId: string): RuntimeRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_runs WHERE run_id = ?').get(runId);
    if (!row) return undefined;
    return RuntimeRunRecordSchema.parse({
      runId: asString(row.run_id),
      sessionId: row.session_id ? asString(row.session_id) : undefined,
      requestHash: asString(row.request_hash),
      status: asString(row.status),
      decision: row.decision_json ? parseJson(row.decision_json, undefined) : undefined,
      result: row.result_json ? parseJson(row.result_json, undefined) : undefined,
      errors: parseJson<string[]>(row.errors_json, []),
      startedAt: asString(row.started_at),
      completedAt: row.completed_at ? asString(row.completed_at) : undefined,
    });
  }

  saveCodingTask(input: CodingTaskRecord): CodingTaskRecord {
    this.db.prepare(`
      INSERT INTO coding_tasks(task_id, run_id, session_id, status, phase, state_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        run_id = excluded.run_id,
        session_id = excluded.session_id,
        status = excluded.status,
        phase = excluded.phase,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(
      input.taskId,
      input.runId || null,
      input.sessionId || null,
      input.status,
      input.phase,
      json(input.state),
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getCodingTask(taskId: string): CodingTaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM coding_tasks WHERE task_id = ?').get(taskId);
    if (!row) return undefined;
    return {
      taskId: asString(row.task_id),
      runId: row.run_id ? asString(row.run_id) : undefined,
      sessionId: row.session_id ? asString(row.session_id) : undefined,
      status: asString(row.status),
      phase: asString(row.phase),
      state: parseJson(row.state_json, null),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  listCodingTasks(limit = 100, status?: string): CodingTaskRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = status
      ? this.db.prepare('SELECT * FROM coding_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, safeLimit)
      : this.db.prepare('SELECT * FROM coding_tasks ORDER BY updated_at DESC LIMIT ?').all(safeLimit);
    return rows.map((row) => ({
      taskId: asString(row.task_id),
      runId: row.run_id ? asString(row.run_id) : undefined,
      sessionId: row.session_id ? asString(row.session_id) : undefined,
      status: asString(row.status),
      phase: asString(row.phase),
      state: parseJson(row.state_json, null),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  claimIdempotency(key: string, scope: string, requestHash: string, ttlSeconds = 86_400): { state: 'claimed' | 'replay' | 'conflict' | 'running'; record?: IdempotencyRecord } {
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      this.db.prepare('DELETE FROM idempotency WHERE expires_at <= ?').run(nowIso);
      const row = this.db.prepare('SELECT * FROM idempotency WHERE idempotency_key = ? AND scope = ?').get(key, scope);
      if (row) {
        const record: IdempotencyRecord = {
          key: asString(row.idempotency_key),
          scope: asString(row.scope),
          requestHash: asString(row.request_hash),
          status: asString(row.status) as IdempotencyRecord['status'],
          response: row.response_json ? parseJson(row.response_json, undefined) : undefined,
          createdAt: asString(row.created_at),
          expiresAt: asString(row.expires_at),
        };
        if (record.requestHash !== requestHash) return { state: 'conflict', record };
        if (record.status === 'complete' || record.status === 'failed') return { state: 'replay', record };
        return { state: 'running', record };
      }
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO idempotency(idempotency_key, scope, request_hash, status, created_at, expires_at)
        VALUES(?, ?, ?, 'running', ?, ?)
      `).run(key, scope, requestHash, nowIso, expiresAt);
      return { state: 'claimed' };
    });
  }

  completeIdempotency(key: string, scope: string, response: unknown, failed = false): void {
    this.db.prepare(`
      UPDATE idempotency SET status = ?, response_json = ? WHERE idempotency_key = ? AND scope = ?
    `).run(failed ? 'failed' : 'complete', json(response), key, scope);
  }

  claimNonce(nonce: string, clientId: string, expiresAt: string): boolean {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare('DELETE FROM auth_nonces WHERE expires_at <= ?').run(now);
      const existing = this.db.prepare('SELECT nonce FROM auth_nonces WHERE nonce = ?').get(nonce);
      if (existing) return false;
      this.db.prepare('INSERT INTO auth_nonces(nonce, client_id, expires_at) VALUES(?, ?, ?)').run(nonce, clientId, expiresAt);
      return true;
    });
  }

  appendOutcome(input: Omit<OutcomeLedgerRecord, 'revision'>): OutcomeLedgerRecord {
    return this.transaction(() => {
      const latest = this.db.prepare('SELECT MAX(revision) AS revision FROM outcome_ledger WHERE run_id = ?').get(input.runId);
      const revision = asNumber(latest?.revision, 0) + 1;
      const record: OutcomeLedgerRecord = { ...input, revision };
      this.db.prepare(`
        INSERT INTO outcome_ledger(
          outcome_id, run_id, session_id, revision, ledger_version, verdict,
          task_type, pipeline_mode, record_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.outcomeId,
        record.runId,
        record.sessionId || null,
        record.revision,
        record.ledgerVersion,
        record.verdict,
        record.taskType,
        record.pipelineMode,
        json(record.record),
        record.createdAt,
      );
      return record;
    });
  }

  listOutcomes(limit = 100, filters: { runId?: string; sessionId?: string; taskType?: string; verdict?: string } = {}): OutcomeLedgerRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filters.runId) { clauses.push('run_id = ?'); values.push(filters.runId); }
    if (filters.sessionId) { clauses.push('session_id = ?'); values.push(filters.sessionId); }
    if (filters.taskType) { clauses.push('task_type = ?'); values.push(filters.taskType); }
    if (filters.verdict) { clauses.push('verdict = ?'); values.push(filters.verdict); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM outcome_ledger ${where} ORDER BY created_at DESC, revision DESC LIMIT ?`).all(...values, safeLimit);
    return rows.map((row) => ({
      outcomeId: asString(row.outcome_id),
      runId: asString(row.run_id),
      sessionId: row.session_id ? asString(row.session_id) : undefined,
      revision: asNumber(row.revision),
      ledgerVersion: asString(row.ledger_version),
      verdict: asString(row.verdict),
      taskType: asString(row.task_type),
      pipelineMode: asString(row.pipeline_mode),
      record: parseJson(row.record_json, null),
      createdAt: asString(row.created_at),
    }));
  }

  saveRouteEvent(input: {
    runId?: string;
    sessionId?: string;
    namespace: string;
    event: unknown;
    memoryStatus: string;
    memoryResponse?: unknown;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO route_events(run_id, session_id, namespace, event_json, memory_status, memory_response_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId || null,
      input.sessionId || null,
      input.namespace,
      json(input.event),
      input.memoryStatus,
      input.memoryResponse === undefined ? null : json(input.memoryResponse),
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  health(): { ok: boolean; path: string; schemaVersion: number; integrity: string; error?: string } {
    try {
      const one = this.db.prepare('SELECT 1 AS ok').get();
      const integrity = this.db.prepare('PRAGMA quick_check').get();
      const schema = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('schema_version');
      const integrityValue = asString(integrity?.quick_check, 'unknown');
      return {
        ok: asNumber(one?.ok) === 1 && integrityValue === 'ok',
        path: this.path,
        schemaVersion: Number(asString(schema?.value, '0')),
        integrity: integrityValue,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, path: this.path, schemaVersion: 0, integrity: 'error', error: message };
    }
  }

  close(): void {
    this.db.close();
  }
}

let singleton: RuntimeStore | undefined;

export function getRuntimeStore(): RuntimeStore {
  if (!singleton) {
    singleton = new RuntimeStore();
    log('info', 'Runtime SQLite store initialized', { path: singleton.path, schemaVersion: SCHEMA_VERSION });
  }
  return singleton;
}

export function resetRuntimeStoreForTests(databasePath = ':memory:'): RuntimeStore {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // Ignore test cleanup failures.
    }
  }
  singleton = new RuntimeStore(databasePath);
  return singleton;
}
