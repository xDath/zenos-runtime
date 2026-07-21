import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

const SCHEMA_VERSION = 12;

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

function continuationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function continuationTokenMatches(token: string | undefined, expectedHash: string): boolean {
  if (!expectedHash) return true; // compatibility with leases created before schema v10
  if (!token) return false;
  const actual = Buffer.from(continuationTokenHash(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

export type CognitiveTaskRecord = {
  taskId: string;
  rootRunId?: string;
  activeRunId?: string;
  sessionId: string;
  status: string;
  phase: string;
  capsule: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ContinuationQueueRecord = {
  continuationId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  status: 'queued' | 'leased' | 'completed' | 'cancelled';
  prompt: string;
  reason: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  leaseHeartbeatAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

function continuationRecordFromRow(row: Record<string, unknown>): ContinuationQueueRecord {
  return {
    continuationId: asString(row.continuation_id),
    taskId: asString(row.task_id),
    runId: asString(row.run_id),
    sessionId: asString(row.session_id),
    status: asString(row.status) as ContinuationQueueRecord['status'],
    prompt: asString(row.prompt),
    reason: asString(row.reason),
    attempt: asNumber(row.attempt),
    maxAttempts: asNumber(row.max_attempts),
    leaseOwner: row.lease_owner ? asString(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? asString(row.lease_expires_at) : undefined,
    leaseHeartbeatAt: row.lease_heartbeat_at ? asString(row.lease_heartbeat_at) : undefined,
    executionStartedAt: row.execution_started_at ? asString(row.execution_started_at) : undefined,
    completedAt: row.completed_at ? asString(row.completed_at) : undefined,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function continuityCheckpointFromRow(row: Record<string, unknown>): ContinuityCheckpointRecord {
  return {
    sessionId: asString(row.session_id),
    sourceCursor: asString(row.source_cursor),
    packetHash: asString(row.packet_hash),
    signalHash: asString(row.signal_hash),
    checkpointId: asString(row.checkpoint_id),
    previousCheckpointId: row.previous_checkpoint_id ? asString(row.previous_checkpoint_id) : undefined,
    pressureLevel: asString(row.pressure_level) as ContinuityCheckpointRecord['pressureLevel'],
    estimatedTokens: asNumber(row.estimated_tokens),
    strategy: row.strategy ? asString(row.strategy) : undefined,
    coverage: row.coverage_json ? parseJson(row.coverage_json, undefined) : undefined,
    context: asString(row.context),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function commandJobFromRow(row: Record<string, unknown>): CommandJobRecord {
  return {
    jobId: asString(row.job_id),
    sessionId: asString(row.session_id),
    userTurnId: asString(row.user_turn_id),
    requestHash: asString(row.request_hash),
    taskContract: parseJson(row.task_contract_json, null),
    status: asString(row.status) as CommandJobRecord['status'],
    checkpointId: row.checkpoint_id ? asString(row.checkpoint_id) : undefined,
    activeStepId: row.active_step_id ? asString(row.active_step_id) : undefined,
    budget: parseJson(row.budget_json, {}),
    cognitiveTaskId: row.cognitive_task_id ? asString(row.cognitive_task_id) : undefined,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function commandStepFromRow(row: Record<string, unknown>): CommandStepRecord {
  return {
    stepId: asString(row.step_id),
    jobId: asString(row.job_id),
    ordinal: asNumber(row.ordinal),
    kind: asString(row.kind) as CommandStepRecord['kind'],
    inputHash: asString(row.input_hash),
    status: asString(row.status) as CommandStepRecord['status'],
    resultRef: row.result_ref ? asString(row.result_ref) : undefined,
    retryCount: asNumber(row.retry_count),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export type ContinuityCheckpointRecord = {
  sessionId: string;
  sourceCursor: string;
  packetHash: string;
  signalHash: string;
  checkpointId: string;
  previousCheckpointId?: string;
  pressureLevel: 'observe' | 'checkpoint' | 'compression' | 'emergency';
  estimatedTokens: number;
  strategy?: string;
  coverage?: unknown;
  context: string;
  createdAt: string;
  updatedAt: string;
};

export type CommandJobRecord = {
  jobId: string;
  sessionId: string;
  userTurnId: string;
  requestHash: string;
  taskContract: unknown;
  status: 'queued' | 'running' | 'paused_for_compaction' | 'waiting_for_approval' | 'retry_pending' | 'completed' | 'failed' | 'cancelled';
  checkpointId?: string;
  activeStepId?: string;
  budget: unknown;
  cognitiveTaskId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommandStepRecord = {
  stepId: string;
  jobId: string;
  ordinal: number;
  kind: 'route' | 'inspect' | 'plan' | 'patch' | 'validate' | 'verify' | 'deliver';
  inputHash: string;
  status: 'queued' | 'running' | 'done' | 'retry_pending' | 'blocked' | 'failed';
  resultRef?: string;
  retryCount: number;
  metadata: unknown;
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
  anomalyCount: number;
  invalidSamples: number;
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
    const recoveredRuns = this.reconcileAbandonedRuns();
    if (recoveredRuns > 0) {
      log('warn', 'Recovered abandoned Runtime runs after process restart', { recoveredRuns });
    }
    const recoveredCodingTasks = this.reconcileInactiveCodingTasks(
      'Coding task cancelled because its Runtime run was missing or terminated unsuccessfully.',
    );
    if (recoveredCodingTasks > 0) {
      log('warn', 'Recovered orphaned coding tasks after process restart', { recoveredCodingTasks });
    }
    const continuationRecovery = this.reconcileContinuationState();
    if (
      continuationRecovery.requeued
      || continuationRecovery.cancelled
      || continuationRecovery.tasksCancelled
      || continuationRecovery.sessionsTerminalized
    ) {
      log('warn', 'Reconciled durable continuation state after process restart', continuationRecovery);
    }
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
        heartbeat_at TEXT,
        lease_expires_at TEXT,
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

      CREATE TABLE IF NOT EXISTS cognitive_tasks (
        task_id TEXT PRIMARY KEY,
        root_run_id TEXT,
        active_run_id TEXT,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        capsule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cognitive_tasks_session ON cognitive_tasks(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cognitive_tasks_status ON cognitive_tasks(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS continuation_queue (
        continuation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        lease_token_hash TEXT,
        lease_expires_at TEXT,
        lease_heartbeat_at TEXT,
        execution_started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_continuation_queue_session ON continuation_queue(session_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_continuation_queue_lease ON continuation_queue(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS continuity_checkpoints (
        session_id TEXT NOT NULL,
        source_cursor TEXT NOT NULL,
        packet_hash TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        previous_checkpoint_id TEXT,
        pressure_level TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        strategy TEXT,
        coverage_json TEXT,
        context TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, source_cursor)
      );

      CREATE INDEX IF NOT EXISTS idx_continuity_checkpoints_session
        ON continuity_checkpoints(session_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_continuity_checkpoints_id
        ON continuity_checkpoints(checkpoint_id);

      CREATE TABLE IF NOT EXISTS command_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_turn_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        task_contract_json TEXT NOT NULL,
        status TEXT NOT NULL,
        checkpoint_id TEXT,
        active_step_id TEXT,
        budget_json TEXT NOT NULL,
        cognitive_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, user_turn_id, request_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_command_jobs_session ON command_jobs(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_command_jobs_status ON command_jobs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_command_jobs_cognitive ON command_jobs(cognitive_task_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS command_steps (
        step_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES command_jobs(job_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_ref TEXT,
        retry_count INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_command_steps_job ON command_steps(job_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_command_steps_status ON command_steps(status, updated_at DESC);

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
        reported_spent_tokens INTEGER,
        calls INTEGER NOT NULL,
        anomaly_count INTEGER NOT NULL DEFAULT 0,
        invalid_samples INTEGER NOT NULL DEFAULT 0,
        reservations_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_governors_expiry ON token_governors(expires_at);
      CREATE INDEX IF NOT EXISTS idx_token_governors_status ON token_governors(status, updated_at DESC);
    `);

    const runColumns = new Set(
      this.db.prepare('PRAGMA table_info(runtime_runs)').all().map((row) => asString(row.name)),
    );
    if (!runColumns.has('heartbeat_at')) this.db.exec('ALTER TABLE runtime_runs ADD COLUMN heartbeat_at TEXT;');
    if (!runColumns.has('lease_expires_at')) this.db.exec('ALTER TABLE runtime_runs ADD COLUMN lease_expires_at TEXT;');
    const continuationColumns = new Set(
      this.db.prepare('PRAGMA table_info(continuation_queue)').all().map((row) => asString(row.name)),
    );
    if (!continuationColumns.has('lease_owner')) this.db.exec('ALTER TABLE continuation_queue ADD COLUMN lease_owner TEXT;');
    if (!continuationColumns.has('lease_token_hash')) this.db.exec('ALTER TABLE continuation_queue ADD COLUMN lease_token_hash TEXT;');
    if (!continuationColumns.has('lease_heartbeat_at')) this.db.exec('ALTER TABLE continuation_queue ADD COLUMN lease_heartbeat_at TEXT;');
    if (!continuationColumns.has('execution_started_at')) this.db.exec('ALTER TABLE continuation_queue ADD COLUMN execution_started_at TEXT;');
    if (!continuationColumns.has('completed_at')) this.db.exec('ALTER TABLE continuation_queue ADD COLUMN completed_at TEXT;');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_continuation_queue_task_attempt ON continuation_queue(task_id, attempt, status);');

    const governorColumns = new Set(
      this.db.prepare('PRAGMA table_info(token_governors)').all().map((row) => asString(row.name)),
    );
    if (!governorColumns.has('anomaly_count')) {
      this.db.exec('ALTER TABLE token_governors ADD COLUMN anomaly_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!governorColumns.has('invalid_samples')) {
      this.db.exec('ALTER TABLE token_governors ADD COLUMN invalid_samples INTEGER NOT NULL DEFAULT 0;');
    }
    if (!governorColumns.has('reported_spent_tokens')) {
      this.db.exec('ALTER TABLE token_governors ADD COLUMN reported_spent_tokens INTEGER;');
    }

    const current = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('schema_version');
    const version = Number(asString(current?.value, '0'));
    if (version > SCHEMA_VERSION) {
      throw new Error(`Runtime database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (version < 8) {
      const migratedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE token_governors
        SET reported_spent_tokens = spent_tokens,
            spent_tokens = limit_tokens,
            anomaly_count = anomaly_count + 1,
            invalid_samples = invalid_samples + 1,
            status = 'expired',
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE spent_tokens > limit_tokens
          AND reported_spent_tokens IS NULL
      `).run(migratedAt, migratedAt);
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

  reconcileAbandonedRuns(): number {
    const abandoned = this.db.prepare(`
      SELECT run_id, errors_json
      FROM runtime_runs
      WHERE status = 'running'
    `).all().map((row) => ({
      runId: asString(row.run_id),
      errors: parseJson<string[]>(row.errors_json, []),
    }));
    if (abandoned.length === 0) return 0;

    const completedAt = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE runtime_runs
      SET status = 'abandoned', errors_json = ?, completed_at = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status = 'running'
    `);
    this.transaction(() => {
      for (const run of abandoned) {
        const message = 'Runtime process exited before this run completed.';
        const errors = run.errors.includes(message) ? run.errors : [...run.errors, message];
        update.run(json(errors), completedAt, completedAt, completedAt, run.runId);
      }
    });
    return abandoned.length;
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
      anomalyCount: asNumber(row.anomaly_count),
      invalidSamples: asNumber(row.invalid_samples),
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
        anomaly_count, invalid_samples, reservations_json, status, updated_at, expires_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(budget_id) DO UPDATE SET
        limit_tokens = excluded.limit_tokens,
        reserve_tokens = excluded.reserve_tokens,
        spent_tokens = excluded.spent_tokens,
        calls = excluded.calls,
        anomaly_count = excluded.anomaly_count,
        invalid_samples = excluded.invalid_samples,
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
      record.anomalyCount,
      record.invalidSamples,
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
    const active = ['queued', 'running', 'revising', 'escalated'].includes(run.status);
    const heartbeatAt = active ? (run.heartbeatAt || new Date().toISOString()) : run.heartbeatAt;
    const leaseExpiresAt = active
      ? (run.leaseExpiresAt || new Date(Date.now() + 10 * 60_000).toISOString())
      : run.leaseExpiresAt;
    this.db.prepare(`
      INSERT INTO runtime_runs(
        run_id, session_id, request_hash, status, decision_json, result_json,
        errors_json, started_at, heartbeat_at, lease_expires_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        session_id = excluded.session_id,
        status = excluded.status,
        decision_json = excluded.decision_json,
        result_json = excluded.result_json,
        errors_json = excluded.errors_json,
        heartbeat_at = excluded.heartbeat_at,
        lease_expires_at = excluded.lease_expires_at,
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
      heartbeatAt || null,
      leaseExpiresAt || null,
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
      heartbeatAt: row.heartbeat_at ? asString(row.heartbeat_at) : undefined,
      leaseExpiresAt: row.lease_expires_at ? asString(row.lease_expires_at) : undefined,
      completedAt: row.completed_at ? asString(row.completed_at) : undefined,
    });
  }

  heartbeatRun(runId: string, leaseMs = 10 * 60_000): RuntimeRunRecord | undefined {
    const heartbeatAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + Math.max(60_000, leaseMs)).toISOString();
    this.db.prepare(`
      UPDATE runtime_runs
      SET heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'revising', 'escalated')
    `).run(heartbeatAt, leaseExpiresAt, runId);
    return this.getRun(runId);
  }

  reconcileExpiredRuns(nowIso = new Date().toISOString(), excludeRunId?: string): number {
    const rows = this.db.prepare(`
      SELECT run_id, errors_json
      FROM runtime_runs
      WHERE status IN ('queued', 'running', 'revising', 'escalated')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND (? IS NULL OR run_id <> ?)
    `).all(nowIso, excludeRunId || null, excludeRunId || null).map((row) => ({
      runId: asString(row.run_id),
      errors: parseJson<string[]>(row.errors_json, []),
    }));
    if (!rows.length) return 0;
    const update = this.db.prepare(`
      UPDATE runtime_runs
      SET status = 'abandoned', errors_json = ?, completed_at = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'revising', 'escalated')
    `);
    this.transaction(() => {
      for (const row of rows) {
        const reason = 'Runtime run lease expired before postflight completed.';
        const errors = row.errors.includes(reason) ? row.errors : [...row.errors, reason];
        update.run(json(errors), nowIso, nowIso, nowIso, row.runId);
      }
    });
    this.reconcileInactiveCodingTasks('Coding task cancelled because its Runtime run lease expired.');
    return rows.length;
  }

  abandonRun(runId: string, reason: string): RuntimeRunRecord | undefined {
    const run = this.getRun(runId);
    if (!run || !['queued', 'running', 'revising', 'escalated'].includes(run.status)) return run;
    const completedAt = new Date().toISOString();
    const errors = run.errors.includes(reason) ? run.errors : [...run.errors, reason];
    this.db.prepare(`
      UPDATE runtime_runs
      SET status = 'abandoned', errors_json = ?, completed_at = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ?
    `).run(json(errors), completedAt, completedAt, completedAt, runId);
    return this.getRun(runId);
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

  findActiveCodingTaskBySession(sessionId: string): CodingTaskRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM coding_tasks
      WHERE session_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId);
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

  cancelCodingTasksForRun(runId: string, reason: string): CodingTaskRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM coding_tasks
      WHERE run_id = ? AND status = 'active'
      ORDER BY updated_at
    `).all(runId);
    if (!rows.length) return [];
    const updatedAt = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE coding_tasks
      SET status = 'cancelled', state_json = ?, updated_at = ?
      WHERE task_id = ? AND status = 'active'
    `);
    const taskIds: string[] = [];
    this.transaction(() => {
      for (const row of rows) {
        const taskId = asString(row.task_id);
        const state = parseJson<Record<string, unknown>>(row.state_json, {});
        const currentRisks = Array.isArray(state.unresolvedRisks)
          ? state.unresolvedRisks.filter((value): value is string => typeof value === 'string')
          : [];
        const nextState = {
          ...state,
          version: Math.max(1, asNumber(state.version, 1)) + 1,
          status: 'cancelled',
          unresolvedRisks: [...new Set([...currentRisks, reason])],
          updatedAt,
        };
        if (Number(update.run(json(nextState), updatedAt, taskId).changes) > 0) taskIds.push(taskId);
      }
    });
    return taskIds.map((taskId) => this.getCodingTask(taskId)).filter((task): task is CodingTaskRecord => Boolean(task));
  }

  reconcileInactiveCodingTasks(reason: string): number {
    const runIds = this.db.prepare(`
      SELECT DISTINCT c.run_id
      FROM coding_tasks c
      LEFT JOIN runtime_runs r ON r.run_id = c.run_id
      WHERE c.status = 'active'
        AND c.run_id IS NOT NULL
        AND (r.run_id IS NULL OR r.status IN ('failed', 'blocked', 'abandoned'))
    `).all().map((row) => asString(row.run_id)).filter(Boolean);
    let reconciled = 0;
    for (const runId of runIds) reconciled += this.cancelCodingTasksForRun(runId, reason).length;
    return reconciled;
  }

  saveCognitiveTask(input: CognitiveTaskRecord): CognitiveTaskRecord {
    this.db.prepare(`
      INSERT INTO cognitive_tasks(task_id, root_run_id, active_run_id, session_id, status, phase, capsule_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        root_run_id = excluded.root_run_id,
        active_run_id = excluded.active_run_id,
        session_id = excluded.session_id,
        status = excluded.status,
        phase = excluded.phase,
        capsule_json = excluded.capsule_json,
        updated_at = excluded.updated_at
    `).run(
      input.taskId,
      input.rootRunId || null,
      input.activeRunId || null,
      input.sessionId,
      input.status,
      input.phase,
      json(input.capsule),
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getCognitiveTask(taskId: string): CognitiveTaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM cognitive_tasks WHERE task_id = ?').get(taskId);
    if (!row) return undefined;
    return {
      taskId: asString(row.task_id),
      rootRunId: row.root_run_id ? asString(row.root_run_id) : undefined,
      activeRunId: row.active_run_id ? asString(row.active_run_id) : undefined,
      sessionId: asString(row.session_id),
      status: asString(row.status),
      phase: asString(row.phase),
      capsule: parseJson(row.capsule_json, null),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  findActiveCognitiveTaskBySession(sessionId: string): CognitiveTaskRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM cognitive_tasks
      WHERE session_id = ? AND status IN ('active', 'waiting_for_user')
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId);
    if (!row) return undefined;
    return {
      taskId: asString(row.task_id),
      rootRunId: row.root_run_id ? asString(row.root_run_id) : undefined,
      activeRunId: row.active_run_id ? asString(row.active_run_id) : undefined,
      sessionId: asString(row.session_id),
      status: asString(row.status),
      phase: asString(row.phase),
      capsule: parseJson(row.capsule_json, null),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  listCognitiveTasks(limit = 100, status?: string): CognitiveTaskRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = status
      ? this.db.prepare('SELECT * FROM cognitive_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, safeLimit)
      : this.db.prepare('SELECT * FROM cognitive_tasks ORDER BY updated_at DESC LIMIT ?').all(safeLimit);
    return rows.map((row) => ({
      taskId: asString(row.task_id),
      rootRunId: row.root_run_id ? asString(row.root_run_id) : undefined,
      activeRunId: row.active_run_id ? asString(row.active_run_id) : undefined,
      sessionId: asString(row.session_id),
      status: asString(row.status),
      phase: asString(row.phase),
      capsule: parseJson(row.capsule_json, null),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  enqueueContinuation(input: ContinuationQueueRecord): ContinuationQueueRecord {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM continuation_queue
        WHERE task_id = ? AND attempt = ? AND status IN ('queued', 'leased')
        ORDER BY created_at ASC LIMIT 1
      `).get(input.taskId, input.attempt);
      if (existing) return continuationRecordFromRow(existing);
      this.db.prepare(`
        INSERT INTO continuation_queue(
          continuation_id, task_id, run_id, session_id, status, prompt, reason,
          attempt, max_attempts, lease_owner, lease_token_hash, lease_expires_at,
          lease_heartbeat_at, execution_started_at, completed_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(continuation_id) DO UPDATE SET
          status = excluded.status,
          prompt = excluded.prompt,
          reason = excluded.reason,
          attempt = excluded.attempt,
          max_attempts = excluded.max_attempts,
          lease_owner = excluded.lease_owner,
          lease_token_hash = excluded.lease_token_hash,
          lease_expires_at = excluded.lease_expires_at,
          lease_heartbeat_at = excluded.lease_heartbeat_at,
          execution_started_at = excluded.execution_started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `).run(
        input.continuationId,
        input.taskId,
        input.runId,
        input.sessionId,
        input.status,
        input.prompt,
        input.reason,
        input.attempt,
        input.maxAttempts,
        input.leaseOwner || null,
        input.leaseToken ? continuationTokenHash(input.leaseToken) : null,
        input.leaseExpiresAt || null,
        input.leaseHeartbeatAt || null,
        input.executionStartedAt || null,
        input.completedAt || null,
        input.createdAt,
        input.updatedAt,
      );
      return input;
    });
  }

  claimContinuationForSession(
    sessionId: string,
    leaseMs = 30 * 60_000,
    recoverLeasedBefore?: string,
    leaseOwner = 'hermes-gateway',
  ): ContinuationQueueRecord | undefined {
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + Math.max(60_000, leaseMs)).toISOString();
      this.db.prepare(`
        UPDATE continuation_queue
        SET status = 'queued', lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, lease_heartbeat_at = NULL,
            execution_started_at = NULL, updated_at = ?
        WHERE session_id = ? AND status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(nowIso, sessionId, nowIso);
      if (recoverLeasedBefore) {
        this.db.prepare(`
          UPDATE continuation_queue
          SET status = 'queued', lease_owner = NULL, lease_token_hash = NULL,
              lease_expires_at = NULL, lease_heartbeat_at = NULL,
              execution_started_at = NULL, updated_at = ?
          WHERE session_id = ? AND status = 'leased' AND updated_at <= ?
        `).run(nowIso, sessionId, recoverLeasedBefore);
      }
      const row = this.db.prepare(`
        SELECT q.* FROM continuation_queue q
        JOIN cognitive_tasks t ON t.task_id = q.task_id
        JOIN sessions s ON s.session_id = q.session_id
        WHERE q.session_id = ? AND q.status = 'queued'
          AND t.status = 'active' AND s.status = 'working'
        ORDER BY q.created_at ASC LIMIT 1
      `).get(sessionId);
      if (!row) return undefined;
      const continuationId = asString(row.continuation_id);
      const leaseToken = randomBytes(32).toString('base64url');
      const safeOwner = String(leaseOwner || 'hermes-gateway').trim().slice(0, 220) || 'hermes-gateway';
      const changed = this.db.prepare(`
        UPDATE continuation_queue
        SET status = 'leased', lease_owner = ?, lease_token_hash = ?,
            lease_expires_at = ?, lease_heartbeat_at = ?, execution_started_at = COALESCE(execution_started_at, ?),
            updated_at = ?
        WHERE continuation_id = ? AND status = 'queued'
      `).run(
        safeOwner,
        continuationTokenHash(leaseToken),
        leaseExpiresAt,
        nowIso,
        nowIso,
        nowIso,
        continuationId,
      );
      if (Number(changed.changes || 0) !== 1) return undefined;
      return {
        ...continuationRecordFromRow(row),
        status: 'leased',
        leaseOwner: safeOwner,
        leaseToken,
        leaseExpiresAt,
        leaseHeartbeatAt: nowIso,
        executionStartedAt: row.execution_started_at ? asString(row.execution_started_at) : nowIso,
        updatedAt: nowIso,
      };
    });
  }

  heartbeatContinuation(
    continuationId: string,
    leaseToken: string,
    leaseMs = 30 * 60_000,
  ): ContinuationQueueRecord | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM continuation_queue WHERE continuation_id = ?').get(continuationId);
      if (!row) return undefined;
      if (asString(row.status) !== 'leased') throw new Error('Continuation is not actively leased');
      if (!continuationTokenMatches(leaseToken, asString(row.lease_token_hash))) {
        throw new Error('Continuation lease token is invalid');
      }
      const updatedAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + Math.max(60_000, leaseMs)).toISOString();
      this.db.prepare(`
        UPDATE continuation_queue
        SET lease_expires_at = ?, lease_heartbeat_at = ?, updated_at = ?
        WHERE continuation_id = ? AND status = 'leased'
      `).run(leaseExpiresAt, updatedAt, updatedAt, continuationId);
      const updated = this.db.prepare('SELECT * FROM continuation_queue WHERE continuation_id = ?').get(continuationId);
      return updated ? continuationRecordFromRow(updated) : undefined;
    });
  }

  completeContinuation(
    continuationId: string,
    cancelled = false,
    leaseToken?: string,
  ): ContinuationQueueRecord | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM continuation_queue WHERE continuation_id = ?').get(continuationId);
      if (!row) return undefined;
      const currentStatus = asString(row.status) as ContinuationQueueRecord['status'];
      if (currentStatus === 'completed' || currentStatus === 'cancelled') return continuationRecordFromRow(row);
      if (currentStatus !== 'leased') throw new Error('Continuation must be leased before acknowledgement');
      if (!continuationTokenMatches(leaseToken, asString(row.lease_token_hash))) {
        throw new Error('Continuation lease token is invalid');
      }
      const updatedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE continuation_queue
        SET status = ?, lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, lease_heartbeat_at = NULL,
            completed_at = ?, updated_at = ?
        WHERE continuation_id = ? AND status = 'leased'
      `).run(cancelled ? 'cancelled' : 'completed', updatedAt, updatedAt, continuationId);
      const updated = this.db.prepare('SELECT * FROM continuation_queue WHERE continuation_id = ?').get(continuationId);
      return updated ? continuationRecordFromRow(updated) : undefined;
    });
  }

  reconcileContinuationState(nowIso = new Date().toISOString()): {
    requeued: number;
    cancelled: number;
    tasksCancelled: number;
    sessionsTerminalized: number;
  } {
    return this.transaction(() => {
      const requeued = this.db.prepare(`
        UPDATE continuation_queue
        SET status = 'queued', lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, lease_heartbeat_at = NULL,
            execution_started_at = NULL, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND EXISTS (SELECT 1 FROM cognitive_tasks t WHERE t.task_id = continuation_queue.task_id AND t.status = 'active')
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = continuation_queue.session_id AND s.status = 'working')
      `).run(nowIso, nowIso);
      const cancelled = this.db.prepare(`
        UPDATE continuation_queue
        SET status = 'cancelled', lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, lease_heartbeat_at = NULL,
            completed_at = ?, updated_at = ?
        WHERE (
          status = 'queued'
          OR (
            status = 'leased'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          )
        ) AND (
          NOT EXISTS (SELECT 1 FROM cognitive_tasks t WHERE t.task_id = continuation_queue.task_id AND t.status = 'active')
          OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = continuation_queue.session_id AND s.status = 'working')
        )
      `).run(nowIso, nowIso, nowIso);

      const orphanTasks = this.db.prepare(`
        SELECT t.* FROM cognitive_tasks t
        LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE t.status = 'active'
          AND (s.session_id IS NULL OR s.status NOT IN ('working', 'paused'))
          AND NOT EXISTS (
            SELECT 1 FROM continuation_queue q
            WHERE q.task_id = t.task_id AND q.status IN ('queued', 'leased')
          )
      `).all();
      const updateTask = this.db.prepare(`
        UPDATE cognitive_tasks
        SET status = 'cancelled', capsule_json = ?, updated_at = ?
        WHERE task_id = ? AND status = 'active'
      `);
      let tasksCancelled = 0;
      for (const row of orphanTasks) {
        const capsule = parseJson<Record<string, unknown>>(row.capsule_json, {});
        const nextCapsule = {
          ...capsule,
          status: 'cancelled',
          updatedAt: nowIso,
        };
        const result = updateTask.run(json(nextCapsule), nowIso, asString(row.task_id));
        tasksCancelled += Number(result.changes || 0);
      }

      // A crashed or explicitly cancelled continuation can leave the parent
      // session marked `working` even after every child saga is terminal. Such
      // rows are operationally misleading and can suppress future recovery.
      // Terminalize only when there is no live run, cognitive task, or queued
      // continuation left for the session.
      const strandedSessions = this.db.prepare(`
        SELECT s.*
        FROM sessions s
        WHERE s.status = 'working'
          AND NOT EXISTS (
            SELECT 1 FROM runtime_runs r
            WHERE r.session_id = s.session_id
              AND r.status IN ('queued', 'running', 'revising', 'escalated')
          )
          AND NOT EXISTS (
            SELECT 1 FROM cognitive_tasks t
            WHERE t.session_id = s.session_id AND t.status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM continuation_queue q
            WHERE q.session_id = s.session_id AND q.status IN ('queued', 'leased')
          )
          AND (
            EXISTS (SELECT 1 FROM cognitive_tasks t WHERE t.session_id = s.session_id)
            OR EXISTS (SELECT 1 FROM continuation_queue q WHERE q.session_id = s.session_id)
          )
      `).all();
      const latestTaskStatus = this.db.prepare(`
        SELECT status FROM cognitive_tasks
        WHERE session_id = ?
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `);
      const latestContinuationStatus = this.db.prepare(`
        SELECT status FROM continuation_queue
        WHERE session_id = ?
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `);
      const updateSession = this.db.prepare(`
        UPDATE sessions
        SET status = ?, active_run_id = NULL, last_error = ?, metadata_json = ?,
            version = version + 1, updated_at = ?
        WHERE session_id = ? AND status = 'working'
      `);
      let sessionsTerminalized = 0;
      for (const row of strandedSessions) {
        const sessionId = asString(row.session_id);
        const taskStatus = asString(latestTaskStatus.get(sessionId)?.status);
        const continuationStatus = asString(latestContinuationStatus.get(sessionId)?.status);
        const status = taskStatus === 'completed'
          ? 'done'
          : taskStatus === 'failed'
            ? 'failed'
            : taskStatus === 'cancelled'
              ? 'cancelled'
              : continuationStatus === 'completed'
                ? 'done'
                : 'cancelled';
        const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
        const reason = status === 'done'
          ? 'All continuation work reached a terminal completed state.'
          : status === 'failed'
            ? 'The root cognitive task failed and no live continuation remains.'
            : 'The root cognitive task was cancelled and no live continuation remains.';
        const lastError = status === 'done'
          ? (row.last_error ? asString(row.last_error) : null)
          : (row.last_error ? asString(row.last_error) : reason);
        const result = updateSession.run(
          status,
          lastError,
          json({
            ...metadata,
            continuationJanitor: {
              terminalizedAt: nowIso,
              terminalStatus: status,
              reason,
            },
          }),
          nowIso,
          sessionId,
        );
        sessionsTerminalized += Number(result.changes || 0);
      }
      return {
        requeued: Number(requeued.changes || 0),
        cancelled: Number(cancelled.changes || 0),
        tasksCancelled,
        sessionsTerminalized,
      };
    });
  }

  cancelContinuationsForRun(runId: string): ContinuationQueueRecord[] {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE continuation_queue
      SET status = 'cancelled', lease_owner = NULL, lease_token_hash = NULL,
          lease_expires_at = NULL, lease_heartbeat_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'leased')
    `).run(updatedAt, updatedAt, runId);
    return this.db.prepare(`
      SELECT * FROM continuation_queue WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId).map(continuationRecordFromRow);
  }

  saveContinuityCheckpoint(input: ContinuityCheckpointRecord): ContinuityCheckpointRecord {
    this.db.prepare(`
      INSERT INTO continuity_checkpoints(
        session_id, source_cursor, packet_hash, signal_hash, checkpoint_id,
        previous_checkpoint_id, pressure_level, estimated_tokens, strategy,
        coverage_json, context, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, source_cursor) DO UPDATE SET
        packet_hash = excluded.packet_hash,
        signal_hash = excluded.signal_hash,
        checkpoint_id = excluded.checkpoint_id,
        previous_checkpoint_id = excluded.previous_checkpoint_id,
        pressure_level = excluded.pressure_level,
        estimated_tokens = excluded.estimated_tokens,
        strategy = excluded.strategy,
        coverage_json = excluded.coverage_json,
        context = excluded.context,
        updated_at = excluded.updated_at
    `).run(
      input.sessionId,
      input.sourceCursor,
      input.packetHash,
      input.signalHash,
      input.checkpointId,
      input.previousCheckpointId || null,
      input.pressureLevel,
      input.estimatedTokens,
      input.strategy || null,
      input.coverage === undefined ? null : json(input.coverage),
      input.context,
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getContinuityCheckpoint(sessionId: string, sourceCursor: string): ContinuityCheckpointRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM continuity_checkpoints WHERE session_id = ? AND source_cursor = ?
    `).get(sessionId, sourceCursor);
    return row ? continuityCheckpointFromRow(row) : undefined;
  }

  getLatestContinuityCheckpoint(sessionId: string): ContinuityCheckpointRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM continuity_checkpoints
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(sessionId);
    return row ? continuityCheckpointFromRow(row) : undefined;
  }

  saveCommandJob(input: CommandJobRecord): CommandJobRecord {
    this.db.prepare(`
      INSERT INTO command_jobs(
        job_id, session_id, user_turn_id, request_hash, task_contract_json,
        status, checkpoint_id, active_step_id, budget_json, cognitive_task_id,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        task_contract_json = excluded.task_contract_json,
        status = excluded.status,
        checkpoint_id = excluded.checkpoint_id,
        active_step_id = excluded.active_step_id,
        budget_json = excluded.budget_json,
        cognitive_task_id = excluded.cognitive_task_id,
        updated_at = excluded.updated_at
    `).run(
      input.jobId,
      input.sessionId,
      input.userTurnId,
      input.requestHash,
      json(input.taskContract),
      input.status,
      input.checkpointId || null,
      input.activeStepId || null,
      json(input.budget),
      input.cognitiveTaskId || null,
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getCommandJob(jobId: string): CommandJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM command_jobs WHERE job_id = ?').get(jobId);
    return row ? commandJobFromRow(row) : undefined;
  }

  findCommandJob(sessionId: string, userTurnId: string, requestHash: string): CommandJobRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM command_jobs
      WHERE session_id = ? AND user_turn_id = ? AND request_hash = ?
      LIMIT 1
    `).get(sessionId, userTurnId, requestHash);
    return row ? commandJobFromRow(row) : undefined;
  }

  findCommandJobByCognitiveTask(cognitiveTaskId: string): CommandJobRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM command_jobs
      WHERE cognitive_task_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(cognitiveTaskId);
    return row ? commandJobFromRow(row) : undefined;
  }

  findActiveCommandJobBySession(sessionId: string): CommandJobRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM command_jobs
      WHERE session_id = ?
        AND status IN ('queued', 'running', 'paused_for_compaction', 'waiting_for_approval', 'retry_pending')
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId);
    return row ? commandJobFromRow(row) : undefined;
  }

  listCommandJobs(limit = 100, status?: string): CommandJobRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = status
      ? this.db.prepare('SELECT * FROM command_jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, safeLimit)
      : this.db.prepare('SELECT * FROM command_jobs ORDER BY updated_at DESC LIMIT ?').all(safeLimit);
    return rows.map(commandJobFromRow);
  }

  saveCommandStep(input: CommandStepRecord): CommandStepRecord {
    this.db.prepare(`
      INSERT INTO command_steps(
        step_id, job_id, ordinal, kind, input_hash, status, result_ref,
        retry_count, metadata_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(step_id) DO UPDATE SET
        input_hash = excluded.input_hash,
        status = excluded.status,
        result_ref = excluded.result_ref,
        retry_count = excluded.retry_count,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.stepId,
      input.jobId,
      input.ordinal,
      input.kind,
      input.inputHash,
      input.status,
      input.resultRef || null,
      input.retryCount,
      json(input.metadata),
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getCommandStep(stepId: string): CommandStepRecord | undefined {
    const row = this.db.prepare('SELECT * FROM command_steps WHERE step_id = ?').get(stepId);
    return row ? commandStepFromRow(row) : undefined;
  }

  listCommandSteps(jobId: string): CommandStepRecord[] {
    return this.db.prepare(`
      SELECT * FROM command_steps WHERE job_id = ? ORDER BY ordinal ASC
    `).all(jobId).map(commandStepFromRow);
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
