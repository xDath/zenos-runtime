import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

export const RuntimeModelSlotsSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  hostModel: z.string().optional(),
  hostProvider: z.string().optional(),
  workerModel: z.string().optional(),
  workerProvider: z.string().optional(),
  bossModel: z.string().optional(),
  bossProvider: z.string().optional(),
  verifierModel: z.string().optional(),
  verifierProvider: z.string().optional(),
});

export type RuntimeModelSlots = z.infer<typeof RuntimeModelSlotsSchema>;

export const MODEL_SLOT_KEYS = ['host', 'worker', 'boss', 'verifier'] as const;
export type RuntimeModelSlot = typeof MODEL_SLOT_KEYS[number];

export function runtimeConfigPath(): string {
  return process.env.ZENOS_RUNTIME_CONFIG_PATH
    || path.join(os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json');
}

export function readRuntimeModelSlots(): RuntimeModelSlots {
  const file = runtimeConfigPath();
  try {
    if (!fs.existsSync(file)) return {};
    return RuntimeModelSlotsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

export function writeRuntimeModelSlots(update: RuntimeModelSlots): RuntimeModelSlots {
  const file = runtimeConfigPath();
  const current = readRuntimeModelSlots();
  const next = RuntimeModelSlotsSchema.parse({ ...current, ...update });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function providerForSlot(config: RuntimeModelSlots, slot: RuntimeModelSlot): string {
  return config[`${slot}Provider` as keyof RuntimeModelSlots] || config.hostProvider || 'default';
}

export function modelForSlot(config: RuntimeModelSlots, slot: RuntimeModelSlot): string {
  return config[`${slot}Model` as keyof RuntimeModelSlots] || '';
}
