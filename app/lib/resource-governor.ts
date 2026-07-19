import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { log, redactText } from './logger';
import { incrementMetric, observeDuration, setGauge } from './metrics';

export const ResourcePressureSchema = z.enum(['healthy', 'elevated', 'high', 'critical']);
export type ResourcePressure = z.infer<typeof ResourcePressureSchema>;

export const ResourceSnapshotSchema = z.object({
  pressure: ResourcePressureSchema,
  load1: z.number().nonnegative(),
  load5: z.number().nonnegative(),
  cpuCount: z.number().int().positive(),
  freeMemoryBytes: z.number().int().nonnegative(),
  totalMemoryBytes: z.number().int().positive(),
  freeMemoryRatio: z.number().min(0).max(1),
  swapTotalBytes: z.number().int().nonnegative(),
  swapFreeBytes: z.number().int().nonnegative(),
  swapFreeRatio: z.number().min(0).max(1),
  activeCommands: z.number().int().nonnegative(),
  measuredAt: z.string().datetime(),
});

export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;

export type GovernedCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  artifactId?: string;
  pressureAtStart: ResourcePressure;
  remoteRecommended: boolean;
  error?: string;
};

export type GovernedCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  priority?: number;
  heavy?: boolean;
  allowUnderPressure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  artifactDirectory?: string;
};

const MAX_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.ETLA_LOCAL_COMMAND_CONCURRENCY || 1)));
const waiters: Array<() => void> = [];
let activeCommands = 0;

function readSwap(): { total: number; free: number } {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const value = (name: string) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    return { total: value('SwapTotal'), free: value('SwapFree') };
  } catch {
    return { total: 0, free: 0 };
  }
}

export function resourceSnapshot(): ResourceSnapshot {
  const [load1, load5] = os.loadavg();
  const cpuCount = Math.max(1, os.cpus().length);
  const freeMemoryBytes = os.freemem();
  const totalMemoryBytes = os.totalmem();
  const freeMemoryRatio = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : 0;
  const swap = readSwap();
  const swapFreeRatio = swap.total > 0 ? swap.free / swap.total : 1;
  const normalizedLoad = load1 / cpuCount;
  let pressure: ResourcePressure = 'healthy';
  if (normalizedLoad >= 3 || freeMemoryRatio < 0.05 || swapFreeRatio < 0.02) pressure = 'critical';
  else if (normalizedLoad >= 1.8 || freeMemoryRatio < 0.1 || swapFreeRatio < 0.08) pressure = 'high';
  else if (normalizedLoad >= 1 || freeMemoryRatio < 0.2 || swapFreeRatio < 0.2) pressure = 'elevated';
  const snapshot = ResourceSnapshotSchema.parse({
    pressure,
    load1,
    load5,
    cpuCount,
    freeMemoryBytes,
    totalMemoryBytes,
    freeMemoryRatio,
    swapTotalBytes: swap.total,
    swapFreeBytes: swap.free,
    swapFreeRatio,
    activeCommands,
    measuredAt: new Date().toISOString(),
  });
  setGauge('runtime_resource_load1', load1);
  setGauge('runtime_resource_free_memory_ratio', freeMemoryRatio);
  setGauge('runtime_resource_swap_free_ratio', swapFreeRatio);
  setGauge('runtime_resource_active_commands', activeCommands);
  return snapshot;
}

async function acquireSlot(): Promise<void> {
  if (activeCommands < MAX_CONCURRENCY) {
    activeCommands += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCommands += 1;
}

function releaseSlot(): void {
  activeCommands = Math.max(0, activeCommands - 1);
  waiters.shift()?.();
}

function artifactDirectory(candidate?: string): string {
  if (candidate) return candidate;
  if (process.env.ETLA_RUNTIME_ARTIFACT_DIR) return process.env.ETLA_RUNTIME_ARTIFACT_DIR;
  if (process.env.NODE_ENV === 'production') return '/var/lib/zenos-runtime/artifacts';
  return path.join(process.cwd(), '.data', 'artifacts');
}

function saveArtifact(input: { stdout: string; stderr: string; command: string; args: string[] }, directory?: string): string | undefined {
  try {
    const root = artifactDirectory(directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const id = `artifact_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const target = `${root.replace(/[\\/]+$/, '')}${path.sep}${id}.json`;
    // Resolve the runtime writer dynamically so Next/Turbopack does not treat
    // a mutable artifact path as a build-time file-tracing glob.
    const writeRuntimeFile = Reflect.get(fs, 'writeFileSync') as typeof fs.writeFileSync;
    writeRuntimeFile(target, JSON.stringify({ ...input, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return id;
  } catch (error) {
    log('warn', 'Could not persist governed command artifact', { error });
    return undefined;
  }
}

export function shouldUseRemoteCompute(input: {
  command?: string;
  heavy?: boolean;
  estimatedSeconds?: number;
  requiresInstall?: boolean;
  fullBuild?: boolean;
}, snapshot = resourceSnapshot()): { remote: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.heavy) reasons.push('workload marked heavy');
  if (input.fullBuild) reasons.push('full build belongs on remote validation');
  if (input.requiresInstall) reasons.push('dependency installation is VPS-expensive');
  if ((input.estimatedSeconds || 0) > 120) reasons.push('estimated duration exceeds local hot-path budget');
  if (snapshot.pressure === 'high' || snapshot.pressure === 'critical') reasons.push(`resource pressure is ${snapshot.pressure}`);
  if (input.command && /\b(next\s+build|npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|cargo\s+build|docker\s+build)\b/i.test(input.command)) {
    reasons.push('command is classified as remote-preferred');
  }
  return { remote: reasons.length > 0, reasons };
}

export async function runGovernedCommand(
  command: string,
  args: string[] = [],
  options: GovernedCommandOptions = {},
): Promise<GovernedCommandResult> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const snapshot = resourceSnapshot();
  const remoteDecision = shouldUseRemoteCompute({ command: [command, ...args].join(' '), heavy: options.heavy }, snapshot);
  if (remoteDecision.remote && !options.allowUnderPressure) {
    incrementMetric('runtime_governed_commands_total', { status: 'remote_recommended', pressure: snapshot.pressure });
    return {
      ok: false,
      command,
      args,
      cwd,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
      pressureAtStart: snapshot.pressure,
      remoteRecommended: true,
      error: `Remote compute required: ${remoteDecision.reasons.join('; ')}`,
    };
  }

  await acquireSlot();
  const started = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 120_000, 15 * 60_000));
  const maxOutputBytes = Math.max(16_000, Math.min(options.maxOutputBytes || 2_000_000, 20_000_000));
  const priority = Math.max(0, Math.min(options.priority ?? 10, 19));
  const actualCommand = process.platform === 'linux' ? 'nice' : command;
  const actualArgs = process.platform === 'linux' ? ['-n', String(priority), command, ...args] : args;
  let stdout = '';
  let stderr = '';
  let totalBytes = 0;
  let truncated = false;
  let timedOut = false;

  try {
    const result = await new Promise<{ exitCode?: number; signal?: NodeJS.Signals }>((resolve, reject) => {
      const child = spawn(actualCommand, actualArgs, {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // Process already exited.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop('SIGTERM');
        setTimeout(() => stop('SIGKILL'), 2_000).unref();
      }, timeoutMs);
      const onAbort = () => stop('SIGTERM');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const text = String(chunk);
        totalBytes += Buffer.byteLength(text);
        if (totalBytes > maxOutputBytes) {
          truncated = true;
          const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
          if (remaining > 0) {
            if (target === 'stdout') stdout += text.slice(0, remaining);
            else stderr += text.slice(0, remaining);
          }
          return;
        }
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };
      child.stdout.on('data', (chunk) => collect('stdout', chunk));
      child.stderr.on('data', (chunk) => collect('stderr', chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: code === null ? undefined : code, signal: signal || undefined });
      });
    });
    const durationMs = observeDuration('runtime_governed_command_duration', started, { command, pressure: snapshot.pressure });
    const ok = result.exitCode === 0 && !timedOut;
    const artifactId = truncated || !ok ? saveArtifact({ stdout, stderr, command, args }, options.artifactDirectory) : undefined;
    incrementMetric('runtime_governed_commands_total', { status: ok ? 'success' : timedOut ? 'timeout' : 'failed', command });
    return {
      ok,
      command,
      args,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: redactText(stdout),
      stderr: redactText(stderr),
      durationMs,
      timedOut,
      truncated,
      artifactId,
      pressureAtStart: snapshot.pressure,
      remoteRecommended: remoteDecision.remote,
      error: ok ? undefined : timedOut ? `Command timed out after ${timeoutMs} ms` : `Command exited with ${result.signal || (result.exitCode ?? 'unknown')}`,
    };
  } catch (error) {
    const durationMs = observeDuration('runtime_governed_command_duration', started, { command, pressure: snapshot.pressure });
    incrementMetric('runtime_governed_commands_total', { status: 'error', command });
    return {
      ok: false,
      command,
      args,
      cwd,
      stdout: redactText(stdout),
      stderr: redactText(stderr),
      durationMs,
      timedOut,
      truncated,
      pressureAtStart: snapshot.pressure,
      remoteRecommended: remoteDecision.remote,
      error: redactText(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    releaseSlot();
  }
}

export function resourceGovernorStatus() {
  return {
    snapshot: resourceSnapshot(),
    maxConcurrency: MAX_CONCURRENCY,
    queuedCommands: waiters.length,
    remotePreferredCommands: ['dependency installs', 'full builds', 'large test matrices', 'model calibration'],
  };
}
