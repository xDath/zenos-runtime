/**
 * @deprecated Zenos Runtime v0.2 uses the transactional SQLite store in
 * `zenos-runtime-store.ts`. This compatibility module remains only so older
 * local imports fail safely instead of silently reviving the former JSON store.
 */
import { getRuntimeStore } from './zenos-runtime-store';
import { RuntimeSessionState } from './zenos-runtime-state';

export function loadRuntimeSessionsFromDisk(): RuntimeSessionState[] {
  return getRuntimeStore().listSessions(500);
}

export function saveRuntimeSessionsToDisk(sessions: RuntimeSessionState[]): void {
  const store = getRuntimeStore();
  store.transaction(() => {
    for (const session of sessions) store.saveSession(session);
  });
}

export function runtimeFileStoreInfo() {
  const health = getRuntimeStore().health();
  return {
    durable: health.ok,
    engine: 'sqlite-wal',
    path: health.path,
    integrity: health.integrity,
    schemaVersion: health.schemaVersion,
  };
}
