import * as fs from 'node:fs';
import { z } from 'zod';
import { RuntimeSessionState, RuntimeSessionStateSchema } from './zenos-runtime-three-agent';

const STORE_PATH = process.env.ZENOS_RUNTIME_STORE_PATH || '/tmp/zenos-runtime-sessions.json';

export function loadRuntimeSessionsFromDisk(): RuntimeSessionState[] {
  if (process.env.ZENOS_RUNTIME_DISABLE_FILE_STORE === 'true') return [];
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as unknown;
    return z.array(RuntimeSessionStateSchema).parse(raw);
  } catch {
    return [];
  }
}

export function saveRuntimeSessionsToDisk(sessions: RuntimeSessionState[]): void {
  if (process.env.ZENOS_RUNTIME_DISABLE_FILE_STORE === 'true') return;
  try {
    fs.mkdirSync(STORE_PATH.slice(0, STORE_PATH.lastIndexOf('/')) || '.', { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(sessions, null, 2));
  } catch {
    // Persistence is best-effort so API calls do not fail on filesystem issues.
  }
}

export function runtimeFileStoreInfo() {
  return {
    durable: process.env.ZENOS_RUNTIME_DISABLE_FILE_STORE !== 'true',
    path: STORE_PATH,
  };
}
