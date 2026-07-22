import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditAvailabilityPolicy,
  auditNamespaceAccess,
  recordRuntimeConfigAudit,
} from '../app/lib/runtime-audit';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

test.beforeEach(() => resetRuntimeStoreForTests(':memory:'));

test('Runtime audit ledger records config changes immutably and suppresses identical snapshots', () => {
  const store = getRuntimeStore();
  const first = recordRuntimeConfigAudit({
    category: 'model_config',
    action: 'global-model-config-updated',
    actor: 'test-client',
    details: { host: 'grok', worker: 'build' },
    store,
  });
  const duplicate = recordRuntimeConfigAudit({
    category: 'model_config',
    action: 'global-model-config-updated',
    actor: 'test-client',
    details: { worker: 'build', host: 'grok' },
    store,
  });
  const changed = recordRuntimeConfigAudit({
    category: 'model_config',
    action: 'global-model-config-updated',
    actor: 'test-client',
    details: { host: 'grok', worker: 'build-v2' },
    store,
  });
  assert.ok(first);
  assert.equal(duplicate, undefined);
  assert.ok(changed);
  assert.equal(changed?.previousHash, first?.currentHash);
  assert.equal(store.listRuntimeAudit(10, 'model_config').length, 2);
});

test('availability policy and namespace access changes are auditable per session', () => {
  const store = getRuntimeStore();
  auditAvailabilityPolicy({ sessionId: 'audit-session', requestId: 'turn-1', store });
  auditNamespaceAccess({
    sessionId: 'audit-session',
    requestId: 'turn-1',
    primary: 'zenos.project.runtime',
    shared: 'zenos',
    workspaceRoot: '/srv/etla/workspaces/zenos-runtime',
    store,
  });
  auditAvailabilityPolicy({ sessionId: 'newer-other-session', requestId: 'turn-2', store });
  assert.equal(store.listRuntimeAudit(10, 'availability_policy').length, 2);
  assert.equal(store.latestRuntimeAudit('availability_policy', 'audit-session')?.sessionId, 'audit-session');
  const namespace = store.listRuntimeAudit(10, 'namespace_access')[0];
  assert.equal(namespace.sessionId, 'audit-session');
  assert.deepEqual(namespace.details, {
    primary: 'zenos.project.runtime',
    shared: 'zenos',
    workspaceRoot: '/srv/etla/workspaces/zenos-runtime',
    projectNamespacesEnabled: true,
  });
});
