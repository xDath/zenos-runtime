import * as crypto from 'node:crypto';
import { RuntimeAuditRecord, RuntimeStore, getRuntimeStore } from './zenos-runtime-store';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runtimeAuditHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export function recordRuntimeConfigAudit(input: {
  category: RuntimeAuditRecord['category'];
  action: string;
  actor: string;
  details: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  store?: RuntimeStore;
}): RuntimeAuditRecord | undefined {
  const store = input.store || getRuntimeStore();
  const currentHash = runtimeAuditHash(input.details);
  const previous = store.listRuntimeAudit(200, input.category)
    .find((item) => item.sessionId === input.sessionId);
  if (previous?.currentHash === currentHash) return undefined;
  const createdAt = new Date().toISOString();
  return store.appendRuntimeAudit({
    auditId: `audit_${runtimeAuditHash({
      category: input.category,
      action: input.action,
      sessionId: input.sessionId || '',
      currentHash,
      createdAt,
    }).slice(0, 40)}`,
    category: input.category,
    action: input.action,
    actor: input.actor,
    sessionId: input.sessionId,
    requestId: input.requestId,
    previousHash: previous?.currentHash,
    currentHash,
    details: input.details,
    createdAt,
  });
}

export function auditAvailabilityPolicy(input: {
  sessionId: string;
  requestId?: string;
  store?: RuntimeStore;
}) {
  return recordRuntimeConfigAudit({
    category: 'availability_policy',
    action: 'availability-policy-observed',
    actor: 'zenos-runtime-gateway',
    sessionId: input.sessionId,
    requestId: input.requestId,
    details: {
      failOpenReadOnly: process.env.ZENOS_RUNTIME_FAIL_OPEN_READ_ONLY !== 'false',
      failClosedMutations: process.env.ZENOS_RUNTIME_FAIL_CLOSED_MUTATIONS !== 'false',
      authoritativeHost: process.env.ZENOS_RUNTIME_AUTHORITATIVE_HOST !== 'false',
      continuityCoordinator: process.env.ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED !== 'false',
      commandJobs: process.env.ZENOS_RUNTIME_COMMAND_JOBS_ENABLED !== 'false',
    },
    store: input.store,
  });
}

export function auditNamespaceAccess(input: {
  sessionId: string;
  primary: string;
  shared?: string;
  workspaceRoot?: string;
  requestId?: string;
  store?: RuntimeStore;
}) {
  return recordRuntimeConfigAudit({
    category: 'namespace_access',
    action: 'memory-namespace-access-observed',
    actor: 'zenos-runtime-memory-compiler',
    sessionId: input.sessionId,
    requestId: input.requestId,
    details: {
      primary: input.primary,
      shared: input.shared || null,
      workspaceRoot: input.workspaceRoot || null,
      projectNamespacesEnabled: process.env.ZENOS_MEMORY_PROJECT_NAMESPACES !== 'false',
    },
    store: input.store,
  });
}
