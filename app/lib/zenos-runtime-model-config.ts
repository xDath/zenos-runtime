import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const OptionalNonEmptyString = z.string().trim().min(1).optional();

export const RuntimeModelSlotsSchema = z.object({
  baseUrl: OptionalNonEmptyString,
  apiKey: OptionalNonEmptyString,
  hostModel: OptionalNonEmptyString,
  hostProvider: OptionalNonEmptyString,
  hostBaseUrl: OptionalNonEmptyString,
  hostApiKey: OptionalNonEmptyString,
  workerModel: OptionalNonEmptyString,
  workerProvider: OptionalNonEmptyString,
  workerBaseUrl: OptionalNonEmptyString,
  workerApiKey: OptionalNonEmptyString,
  bossModel: OptionalNonEmptyString,
  bossProvider: OptionalNonEmptyString,
  bossBaseUrl: OptionalNonEmptyString,
  bossApiKey: OptionalNonEmptyString,
  verifierModel: OptionalNonEmptyString,
  verifierProvider: OptionalNonEmptyString,
  verifierBaseUrl: OptionalNonEmptyString,
  verifierApiKey: OptionalNonEmptyString,
}).strict();

export type RuntimeModelSlots = z.infer<typeof RuntimeModelSlotsSchema>;

export const MODEL_SLOT_KEYS = ['host', 'worker', 'boss', 'verifier'] as const;
export type RuntimeModelSlot = typeof MODEL_SLOT_KEYS[number];

const SESSION_MODEL_DIR = process.env.ZENOS_RUNTIME_SESSION_MODEL_DIR
  || path.join(/* turbopackIgnore: true */ os.homedir(), '.hermes/profiles/zenos/runtime-session-models');

export function runtimeConfigPath(): string {
  return process.env.ZENOS_RUNTIME_CONFIG_PATH
    || path.join(/* turbopackIgnore: true */ os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json');
}

export function runtimeSessionConfigPath(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
  if (!safeSessionId) throw new Error('Invalid runtime session id');
  return path.join(/* turbopackIgnore: true */ SESSION_MODEL_DIR, `${safeSessionId}.json`);
}

function readSlotsFile(file: string): RuntimeModelSlots {
  try {
    if (!fs.existsSync(file)) return {};
    return RuntimeModelSlotsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function writeSlotsFile(file: string, update: RuntimeModelSlots): RuntimeModelSlots {
  const current = readSlotsFile(file);
  const next = RuntimeModelSlotsSchema.parse({ ...current, ...update });
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function readRuntimeModelSlots(): RuntimeModelSlots {
  return readSlotsFile(runtimeConfigPath());
}

export function writeRuntimeModelSlots(update: RuntimeModelSlots): RuntimeModelSlots {
  return writeSlotsFile(runtimeConfigPath(), normalizeSingleModelSlots(update));
}

export function readSessionModelSlots(sessionId?: string): RuntimeModelSlots {
  return sessionId ? readSlotsFile(runtimeSessionConfigPath(sessionId)) : {};
}

export function writeSessionModelSlots(sessionId: string, update: RuntimeModelSlots): RuntimeModelSlots {
  return writeSlotsFile(runtimeSessionConfigPath(sessionId), normalizeSingleModelSlots(update));
}

export function deleteSessionModelSlots(sessionId: string): boolean {
  const file = runtimeSessionConfigPath(sessionId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function mergeModelSlots(...configs: RuntimeModelSlots[]): RuntimeModelSlots {
  const merged: Record<string, string> = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return RuntimeModelSlotsSchema.parse(merged);
}

export function providerForSlot(config: RuntimeModelSlots, _slot: RuntimeModelSlot): string {
  // Zenos Cognitive Runtime has one session model. Legacy per-role fields are
  // still parsed so old files remain readable, but every auxiliary call and
  // native Hermes worker inherits the current Host provider.
  return config.hostProvider || 'default';
}

export function modelForSlot(config: RuntimeModelSlots, _slot: RuntimeModelSlot): string {
  return config.hostModel || '';
}

export function baseUrlForSlot(config: RuntimeModelSlots, _slot: RuntimeModelSlot): string {
  return config.hostBaseUrl || config.baseUrl || '';
}

export function apiKeyForSlot(config: RuntimeModelSlots, _slot: RuntimeModelSlot): string {
  return config.hostApiKey || config.apiKey || '';
}

export function normalizeSingleModelSlots(config: RuntimeModelSlots): RuntimeModelSlots {
  const hostModel = config.hostModel || config.workerModel || config.verifierModel || config.bossModel;
  const hostProvider = config.hostProvider || config.workerProvider || config.verifierProvider || config.bossProvider;
  const hostBaseUrl = config.hostBaseUrl || config.workerBaseUrl || config.verifierBaseUrl || config.bossBaseUrl;
  const hostApiKey = config.hostApiKey || config.workerApiKey || config.verifierApiKey || config.bossApiKey;
  return RuntimeModelSlotsSchema.parse({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    hostModel,
    hostProvider,
    hostBaseUrl,
    hostApiKey,
  });
}

export function publicModelSlots(config: RuntimeModelSlots): Omit<RuntimeModelSlots, 'apiKey' | 'hostApiKey' | 'workerApiKey' | 'bossApiKey' | 'verifierApiKey'> & { hasApiKey: boolean } {
  const { apiKey, hostApiKey, workerApiKey, bossApiKey, verifierApiKey, ...safe } = config;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey || hostApiKey || workerApiKey || bossApiKey || verifierApiKey),
  };
}
