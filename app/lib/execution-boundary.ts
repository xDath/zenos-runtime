import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

export const RuntimeExecutionModeSchema = z.enum(['control-plane', 'isolated-executor']);
export type RuntimeExecutionMode = z.infer<typeof RuntimeExecutionModeSchema>;

export const ExecutionActionSchema = z.enum([
  'workspace_read',
  'local_mutation',
  'rollback',
  'remote_validation',
  'production_action',
]);
export type ExecutionAction = z.infer<typeof ExecutionActionSchema>;

export type ExecutionBoundaryDecision = {
  allowed: boolean;
  mode: RuntimeExecutionMode;
  action: ExecutionAction;
  workspaceRoot?: string;
  workspaceFingerprint?: string;
  reason: string;
  requiresApproval: boolean;
};

function configuredMode(): RuntimeExecutionMode {
  const explicit = process.env.ZENOS_RUNTIME_EXECUTION_MODE;
  if (explicit) return RuntimeExecutionModeSchema.parse(explicit);
  return process.env.NODE_ENV === 'production' ? 'control-plane' : 'isolated-executor';
}

function configuredRoots(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  const roots = (raw ? raw.split(path.delimiter) : fallback)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => canonicalPath(value));
  return [...new Set(roots)];
}

const LEGACY_WORKSPACE_ROOT = '/root/openclaw-projects';
const CANONICAL_WORKSPACE_ROOT = '/srv/etla/workspaces';

export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === LEGACY_WORKSPACE_ROOT) return CANONICAL_WORKSPACE_ROOT;
  if (trimmed.startsWith(`${LEGACY_WORKSPACE_ROOT}/`)) {
    return `${CANONICAL_WORKSPACE_ROOT}${trimmed.slice(LEGACY_WORKSPACE_ROOT.length)}`;
  }
  return trimmed;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(normalizeWorkspacePath(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let ancestor = resolved;
    const missing: string[] = [];
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const canonicalAncestor = fs.realpathSync.native(ancestor);
    return path.join(canonicalAncestor, ...missing);
  }
}

function mutationRoots(): string[] {
  const developmentRoots = process.env.NODE_ENV === 'production' ? [] : [process.cwd(), '/tmp'];
  return configuredRoots('ZENOS_RUNTIME_MUTATION_ROOTS', [
    ...developmentRoots,
    path.join(process.cwd(), '.data', 'executor-workspaces'),
    '/var/lib/zenos-runtime/workspaces',
  ]);
}

function validationRoots(): string[] {
  const developmentRoots = process.env.NODE_ENV === 'production' ? [] : [process.cwd(), '/tmp'];
  return configuredRoots('ZENOS_RUNTIME_VALIDATION_ROOTS', [
    ...developmentRoots,
    path.join(process.cwd(), '.data', 'validation-workspaces'),
    '/var/lib/zenos-runtime/validation-workspaces',
  ]);
}

function readRoots(): string[] {
  return configuredRoots('ZENOS_RUNTIME_READ_ROOTS', [
    process.cwd(),
    '/usr/local/lib/hermes-agent',
    '/var/lib/zenos-runtime/workspaces',
    '/var/lib/zenos-runtime/validation-workspaces',
  ]);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function allowedByRoots(candidate: string, roots: string[]): boolean {
  const resolved = canonicalPath(candidate);
  return roots.some((root) => isInside(root, resolved));
}

export function workspaceFingerprint(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(canonicalPath(workspaceRoot)).digest('hex').slice(0, 24);
}

export function executionBoundaryStatus() {
  return {
    mode: configuredMode(),
    localMutationEnabled: configuredMode() === 'isolated-executor',
    remoteValidationEnabled: process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED === 'true',
    mutationRoots: mutationRoots(),
    validationRoots: validationRoots(),
    readRoots: readRoots(),
  };
}

export function evaluateExecutionBoundary(input: {
  action: ExecutionAction;
  workspaceRoot?: string;
  approvalGranted?: boolean;
}): ExecutionBoundaryDecision {
  const action = ExecutionActionSchema.parse(input.action);
  const mode = configuredMode();
  const requiresApproval = action !== 'workspace_read';
  const resolved = input.workspaceRoot ? canonicalPath(input.workspaceRoot) : undefined;
  const base = {
    mode,
    action,
    workspaceRoot: resolved,
    workspaceFingerprint: resolved ? workspaceFingerprint(resolved) : undefined,
    requiresApproval,
  };

  if (requiresApproval && !input.approvalGranted) {
    return { ...base, allowed: false, reason: 'Explicit approval is required for this execution action.' };
  }

  if (action === 'workspace_read') {
    if (!resolved) return { ...base, allowed: false, reason: 'A workspace root is required for repository inspection.' };
    return allowedByRoots(resolved, readRoots())
      ? { ...base, allowed: true, reason: 'Workspace is inside an approved read-only root.' }
      : { ...base, allowed: false, reason: 'Workspace is outside the approved read-only roots.' };
  }

  if (action === 'remote_validation') {
    if (process.env.ZENOS_RUNTIME_REMOTE_VALIDATION_ENABLED !== 'true') {
      return { ...base, allowed: false, reason: 'Remote validation dispatch is disabled for this Runtime instance.' };
    }
    if (!resolved || !allowedByRoots(resolved, validationRoots())) {
      return { ...base, allowed: false, reason: 'Remote validation requires an isolated workspace inside the validation allowlist.' };
    }
    return { ...base, allowed: true, reason: 'Approved isolated validation workspace may dispatch a temporary GitHub branch.' };
  }

  if (mode !== 'isolated-executor') {
    return {
      ...base,
      allowed: false,
      reason: 'The production Runtime is a control plane; local mutation belongs to an isolated executor.',
    };
  }

  if (!resolved || !allowedByRoots(resolved, mutationRoots())) {
    return { ...base, allowed: false, reason: 'Local mutation is restricted to isolated executor workspaces.' };
  }

  if (action === 'production_action' && process.env.ZENOS_RUNTIME_ALLOW_PRODUCTION_ACTIONS !== 'true') {
    return { ...base, allowed: false, reason: 'Production actions are disabled for this executor.' };
  }

  return { ...base, allowed: true, reason: 'Approved action is inside an isolated executor workspace.' };
}

export function assertExecutionBoundary(input: {
  action: ExecutionAction;
  workspaceRoot?: string;
  approvalGranted?: boolean;
}): ExecutionBoundaryDecision {
  const decision = evaluateExecutionBoundary(input);
  if (!decision.allowed) throw new Error(`Execution boundary blocked ${decision.action}: ${decision.reason}`);
  return decision;
}
