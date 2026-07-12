import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { incrementMetric, observeDuration } from './metrics';
import {
  buildRepositoryIndex,
  findRepositoryReferences,
  findRepositorySymbols,
  resolveRepositoryPath,
  searchRepository,
} from './repository-intelligence';
import {
  GovernedCommandResult,
  runGovernedCommand,
  shouldUseRemoteCompute,
} from './resource-governor';

export const ToolRiskSchema = z.enum(['read_only', 'write_local', 'destructive', 'production', 'secret_sensitive']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolEvidenceSchema = z.object({
  tool: z.string().min(1),
  status: z.enum(['success', 'failed', 'blocked', 'remote_required']),
  summary: z.string().max(12_000),
  details: z.record(z.string(), z.unknown()).default({}),
  artifactId: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  cacheable: z.boolean(),
  evidence: z.boolean(),
});
export type ToolEvidence = z.infer<typeof ToolEvidenceSchema>;

export type ToolContext = {
  cwd: string;
  approvalGranted: boolean;
  allowProduction: boolean;
  signal?: AbortSignal;
};

export type ToolDefinition<TInput = unknown> = {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: z.ZodType<TInput>;
  cacheable: boolean;
  producesEvidence: boolean;
  remotePreferred?: boolean;
  requiresApproval?: boolean;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<ToolEvidence>;
};

export class ToolBroker {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.tools.has(definition.name)) throw new Error(`Tool ${definition.name} is already registered`);
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  list(): Array<Pick<ToolDefinition,
    'name' | 'description' | 'risk' | 'cacheable' | 'producesEvidence' | 'remotePreferred' | 'requiresApproval' | 'timeoutMs'>> {
    return [...this.tools.values()].map(({
      name,
      description,
      risk,
      cacheable,
      producesEvidence,
      remotePreferred,
      requiresApproval,
      timeoutMs,
    }) => ({
      name,
      description,
      risk,
      cacheable,
      producesEvidence,
      remotePreferred,
      requiresApproval: requiresApproval ?? (risk === 'destructive' || risk === 'production'),
      timeoutMs,
    }));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolEvidence> {
    const definition = this.tools.get(name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    const requiresApproval = definition.requiresApproval ?? (definition.risk === 'destructive' || definition.risk === 'production');
    if (requiresApproval && !context.approvalGranted) {
      incrementMetric('runtime_tool_calls_total', { tool: name, status: 'blocked' });
      return ToolEvidenceSchema.parse({
        tool: name,
        status: 'blocked',
        summary: 'Explicit approval is required before this tool may execute.',
        details: { risk: definition.risk },
        durationMs: 0,
        cacheable: false,
        evidence: true,
      });
    }
    if (definition.risk === 'production' && !context.allowProduction) {
      return ToolEvidenceSchema.parse({
        tool: name,
        status: 'blocked',
        summary: 'Production tools are disabled for this runtime request.',
        details: { risk: definition.risk },
        durationMs: 0,
        cacheable: false,
        evidence: true,
      });
    }
    const parsed = definition.inputSchema.parse(input);
    const started = Date.now();
    try {
      const result = ToolEvidenceSchema.parse(await definition.execute(parsed, context));
      incrementMetric('runtime_tool_calls_total', { tool: name, status: result.status });
      observeDuration('runtime_tool_call_duration', started, { tool: name, status: result.status });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      incrementMetric('runtime_tool_calls_total', { tool: name, status: 'failed' });
      return ToolEvidenceSchema.parse({
        tool: name,
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
        details: {},
        durationMs,
        cacheable: false,
        evidence: true,
      });
    }
  }
}

const CommandInputSchema = z.object({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(2_000)).max(128).default([]),
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  heavy: z.boolean().optional().default(false),
});

const RepositoryIndexInputSchema = z.object({
  forceFull: z.boolean().optional().default(false),
});

const RepositorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

const RepositoryReadInputSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  startLine: z.number().int().min(1).optional().default(1),
  endLine: z.number().int().min(1).max(200_000).optional(),
  maxBytes: z.number().int().min(1_000).max(1_000_000).optional().default(250_000),
});

const RepositorySymbolInputSchema = z.object({
  name: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

const RepositoryDiffInputSchema = z.object({
  staged: z.boolean().optional().default(false),
  path: z.string().trim().min(1).max(4_096).optional(),
  maxOutputBytes: z.number().int().min(16_000).max(8_000_000).optional().default(1_000_000),
});

const RepositoryPatchInputSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  expectedHash: z.string().length(64).optional(),
  replacements: z.array(z.object({
    oldText: z.string().min(1).max(500_000),
    newText: z.string().max(500_000),
  })).min(1).max(50),
  dryRun: z.boolean().optional().default(false),
});

const PackageScriptInputSchema = z.object({
  args: z.array(z.string().max(2_000)).max(64).optional().default([]),
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
});

const TestRunInputSchema = PackageScriptInputSchema.extend({
  script: z.string().regex(/^[A-Za-z0-9:_-]+$/).optional().default('test'),
});

const ServiceInputSchema = z.object({
  service: z.string().regex(/^[A-Za-z0-9@_.:-]+$/).max(200),
});

const ServiceLogsInputSchema = ServiceInputSchema.extend({
  lines: z.number().int().min(1).max(2_000).optional().default(200),
  since: z.string().max(100).optional(),
});

const PortInspectInputSchema = z.object({
  port: z.number().int().min(1).max(65_535).optional(),
});

const JsonValidateInputSchema = z.object({
  text: z.string().max(2_000_000),
});

const SchemaValidateInputSchema = z.object({
  value: z.unknown(),
  schema: z.record(z.string(), z.unknown()),
});

const SecretScanInputSchema = z.object({
  paths: z.array(z.string().trim().min(1).max(4_096)).max(500).optional(),
  maxFiles: z.number().int().min(1).max(10_000).optional().default(2_000),
});

function outputSummary(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`;
}

function governedCommandEvidence(
  tool: string,
  result: GovernedCommandResult,
  options: { cacheable?: boolean; successSummary?: string } = {},
): ToolEvidence {
  return ToolEvidenceSchema.parse({
    tool,
    status: result.ok ? 'success' : result.remoteRecommended ? 'remote_required' : 'failed',
    summary: result.ok
      ? options.successSummary || `Command completed successfully with exit code ${result.exitCode ?? 0}.`
      : result.error || outputSummary(result.stderr, 2_000) || 'Command failed.',
    details: {
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      stdout: outputSummary(result.stdout, 12_000),
      stderr: outputSummary(result.stderr, 12_000),
      truncated: result.truncated,
      timedOut: result.timedOut,
      pressureAtStart: result.pressureAtStart,
      remoteRecommended: result.remoteRecommended,
    },
    artifactId: result.artifactId,
    durationMs: result.durationMs,
    cacheable: Boolean(options.cacheable && result.ok),
    evidence: true,
  });
}

function readPackageScripts(cwd: string): Record<string, string> {
  const packagePath = path.join(cwd, 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.scripts || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

async function runPackageScript(
  tool: string,
  script: string,
  args: string[],
  context: ToolContext,
  options: { timeoutMs?: number; heavy?: boolean; remotePreferred?: boolean } = {},
): Promise<ToolEvidence> {
  const scripts = readPackageScripts(context.cwd);
  if (!scripts[script]) {
    return ToolEvidenceSchema.parse({
      tool,
      status: 'failed',
      summary: `Package script ${script} is not defined.`,
      details: { availableScripts: Object.keys(scripts).sort() },
      durationMs: 0,
      cacheable: false,
      evidence: true,
    });
  }
  if (options.remotePreferred) {
    const remote = shouldUseRemoteCompute({ command: `npm run ${script}`, heavy: options.heavy, fullBuild: true });
    if (remote.remote) {
      return ToolEvidenceSchema.parse({
        tool,
        status: 'remote_required',
        summary: `Remote validation required: ${remote.reasons.join('; ')}`,
        details: { script, reasons: remote.reasons },
        durationMs: 0,
        cacheable: false,
        evidence: true,
      });
    }
  }
  const commandArgs = ['run', script];
  if (args.length) commandArgs.push('--', ...args);
  const result = await runGovernedCommand('npm', commandArgs, {
    cwd: context.cwd,
    timeoutMs: options.timeoutMs,
    heavy: options.heavy,
    signal: context.signal,
  });
  return governedCommandEvidence(tool, result, {
    cacheable: result.ok,
    successSummary: `${script} completed successfully.`,
  });
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWrite(target: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, target);
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === expected;
}

function validateSchemaSubset(value: unknown, schema: Record<string, unknown>, pointer = '$'): string[] {
  const errors: string[] = [];
  const expectedType = typeof schema.type === 'string' ? schema.type : undefined;
  if (expectedType && !typeMatches(value, expectedType)) {
    errors.push(`${pointer}: expected ${expectedType}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${pointer}: value is not in enum`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${pointer}: shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${pointer}: longer than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: does not match pattern`);
      } catch {
        errors.push(`${pointer}: schema pattern is invalid`);
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${pointer}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${pointer}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    value.forEach((entry, index) => errors.push(...validateSchemaSubset(entry, schema.items as Record<string, unknown>, `${pointer}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) errors.push(`${pointer}.${key}: required property is missing`);
    }
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in objectValue) || !childSchema || typeof childSchema !== 'object' || Array.isArray(childSchema)) continue;
      errors.push(...validateSchemaSubset(objectValue[key], childSchema as Record<string, unknown>, `${pointer}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) errors.push(`${pointer}.${key}: additional property is not allowed`);
      }
    }
  }
  return errors.slice(0, 500);
}

const SECRET_PATTERNS: Array<{ kind: string; expression: RegExp }> = [
  { kind: 'private_key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: 'openai_key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github_token', expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google_api_key', expression: /\bAIza[0-9A-Za-z_-]{25,}\b/g },
  { kind: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'assigned_secret', expression: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi },
];

function secretFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function createDefaultToolBroker(): ToolBroker {
  const broker = new ToolBroker();

  broker.register({
    name: 'command.run',
    description: 'Run a bounded local command under the Runtime resource governor.',
    risk: 'write_local',
    inputSchema: CommandInputSchema,
    cacheable: false,
    producesEvidence: true,
    timeoutMs: 120_000,
    async execute(input, context) {
      const args = input.args ?? [];
      const remote = shouldUseRemoteCompute({ command: [input.command, ...args].join(' '), heavy: input.heavy });
      if (remote.remote) {
        return ToolEvidenceSchema.parse({
          tool: 'command.run',
          status: 'remote_required',
          summary: `Remote compute required: ${remote.reasons.join('; ')}`,
          details: { reasons: remote.reasons, command: input.command },
          durationMs: 0,
          cacheable: false,
          evidence: true,
        });
      }
      const result = await runGovernedCommand(input.command, args, {
        cwd: context.cwd,
        timeoutMs: input.timeoutMs,
        heavy: input.heavy,
        signal: context.signal,
      });
      return governedCommandEvidence('command.run', result);
    },
  });

  broker.register({
    name: 'repo.index',
    description: 'Build or incrementally refresh deterministic repository intelligence.',
    risk: 'read_only',
    inputSchema: RepositoryIndexInputSchema,
    cacheable: true,
    producesEvidence: true,
    timeoutMs: 120_000,
    async execute(input, context) {
      const started = Date.now();
      const index = await buildRepositoryIndex(context.cwd, { forceFull: input.forceFull });
      return ToolEvidenceSchema.parse({
        tool: 'repo.index',
        status: 'success',
        summary: `Indexed ${index.files.length} files at revision ${index.revision.slice(0, 12)}.`,
        details: {
          revision: index.revision,
          git: index.git,
          stats: index.stats,
          languageMap: index.languageMap,
          configFiles: index.configFiles,
          packageScripts: index.packageScripts,
        },
        durationMs: Date.now() - started,
        cacheable: true,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'repo.search',
    description: 'Search indexed repository text without using an LLM.',
    risk: 'read_only',
    inputSchema: RepositorySearchInputSchema,
    cacheable: true,
    producesEvidence: true,
    timeoutMs: 120_000,
    async execute(input, context) {
      const started = Date.now();
      const index = await buildRepositoryIndex(context.cwd);
      const matches = searchRepository(index, input.query, input.limit);
      return ToolEvidenceSchema.parse({
        tool: 'repo.search',
        status: 'success',
        summary: `Found ${matches.length} repository matches for ${JSON.stringify(input.query)}.`,
        details: { revision: index.revision, matches },
        durationMs: Date.now() - started,
        cacheable: true,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'repo.read',
    description: 'Read a bounded line range from a repository file.',
    risk: 'read_only',
    inputSchema: RepositoryReadInputSchema,
    cacheable: true,
    producesEvidence: true,
    async execute(input, context) {
      const started = Date.now();
      const absolute = resolveRepositoryPath(context.cwd, input.path);
      const stat = fs.statSync(absolute);
      const maxBytes = input.maxBytes ?? 250_000;
      if (!stat.isFile()) throw new Error(`Not a file: ${input.path}`);
      if (stat.size > maxBytes) throw new Error(`File exceeds bounded read limit of ${maxBytes} bytes`);
      const content = fs.readFileSync(absolute, 'utf8');
      const lines = content.split('\n');
      const startLine = Math.min(input.startLine ?? 1, Math.max(1, lines.length));
      const endLine = Math.min(input.endLine || startLine + 399, lines.length);
      const rawContent = lines.slice(startLine - 1, endLine).join('\n');
      const selected = lines.slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
      return ToolEvidenceSchema.parse({
        tool: 'repo.read',
        status: 'success',
        summary: `Read ${input.path}:${startLine}-${endLine}.`,
        details: {
          path: input.path,
          startLine,
          endLine,
          lineCount: lines.length,
          hash: hashText(content),
          content: selected,
          rawContent,
        },
        durationMs: Date.now() - started,
        cacheable: true,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'repo.symbol',
    description: 'Resolve deterministic symbol definitions from the repository index.',
    risk: 'read_only',
    inputSchema: RepositorySymbolInputSchema,
    cacheable: true,
    producesEvidence: true,
    async execute(input, context) {
      const started = Date.now();
      const index = await buildRepositoryIndex(context.cwd);
      const symbols = findRepositorySymbols(index, input.name, input.limit);
      return ToolEvidenceSchema.parse({
        tool: 'repo.symbol',
        status: 'success',
        summary: `Resolved ${symbols.length} symbol definitions for ${input.name}.`,
        details: { revision: index.revision, symbols },
        durationMs: Date.now() - started,
        cacheable: true,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'repo.references',
    description: 'Resolve deterministic symbol references from the repository index.',
    risk: 'read_only',
    inputSchema: RepositorySymbolInputSchema,
    cacheable: true,
    producesEvidence: true,
    async execute(input, context) {
      const started = Date.now();
      const index = await buildRepositoryIndex(context.cwd);
      const references = findRepositoryReferences(index, input.name, input.limit);
      return ToolEvidenceSchema.parse({
        tool: 'repo.references',
        status: 'success',
        summary: `Resolved ${references.length} references for ${input.name}.`,
        details: { revision: index.revision, references },
        durationMs: Date.now() - started,
        cacheable: true,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'repo.diff',
    description: 'Read a bounded Git diff through the Resource Governor.',
    risk: 'read_only',
    inputSchema: RepositoryDiffInputSchema,
    cacheable: false,
    producesEvidence: true,
    timeoutMs: 30_000,
    async execute(input, context) {
      const args = ['diff', '--no-ext-diff'];
      if (input.staged) args.push('--cached');
      if (input.path) {
        resolveRepositoryPath(context.cwd, input.path);
        args.push('--', input.path);
      }
      const result = await runGovernedCommand('git', args, {
        cwd: context.cwd,
        timeoutMs: 30_000,
        maxOutputBytes: input.maxOutputBytes,
        signal: context.signal,
      });
      return governedCommandEvidence('repo.diff', result, { cacheable: false, successSummary: 'Git diff captured.' });
    },
  });

  broker.register({
    name: 'repo.patch',
    description: 'Apply exact, bounded, atomic text replacements to one repository file.',
    risk: 'write_local',
    inputSchema: RepositoryPatchInputSchema,
    cacheable: false,
    producesEvidence: true,
    async execute(input, context) {
      const started = Date.now();
      const absolute = resolveRepositoryPath(context.cwd, input.path);
      const existed = fs.existsSync(absolute);
      const original = existed ? fs.readFileSync(absolute, 'utf8') : '';
      const originalHash = hashText(original);
      if (input.expectedHash && input.expectedHash !== originalHash) {
        throw new Error(`File hash mismatch for ${input.path}; expected ${input.expectedHash}, got ${originalHash}`);
      }
      let updated = original;
      for (const replacement of input.replacements) {
        const first = updated.indexOf(replacement.oldText);
        if (first < 0) throw new Error(`Patch text was not found in ${input.path}`);
        if (updated.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
          throw new Error(`Patch text is not unique in ${input.path}`);
        }
        updated = `${updated.slice(0, first)}${replacement.newText}${updated.slice(first + replacement.oldText.length)}`;
      }
      const updatedHash = hashText(updated);
      if (!input.dryRun && updated !== original) {
        const mode = existed ? fs.statSync(absolute).mode : 0o600;
        atomicWrite(absolute, updated, mode);
      }
      return ToolEvidenceSchema.parse({
        tool: 'repo.patch',
        status: 'success',
        summary: input.dryRun
          ? `Patch for ${input.path} validated without writing.`
          : `Applied ${input.replacements.length} exact replacements to ${input.path}.`,
        details: {
          path: input.path,
          dryRun: input.dryRun,
          replacementsApplied: input.replacements.length,
          originalHash,
          updatedHash,
          changed: updated !== original,
          bytesBefore: Buffer.byteLength(original),
          bytesAfter: Buffer.byteLength(updated),
        },
        durationMs: Date.now() - started,
        cacheable: false,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'test.run',
    description: 'Run a bounded package test script through the Resource Governor.',
    risk: 'write_local',
    inputSchema: TestRunInputSchema,
    cacheable: true,
    producesEvidence: true,
    timeoutMs: 180_000,
    async execute(input, context) {
      return runPackageScript('test.run', input.script ?? 'test', input.args ?? [], context, { timeoutMs: input.timeoutMs || 180_000 });
    },
  });

  broker.register({
    name: 'typecheck.run',
    description: 'Run the package typecheck script through the Resource Governor.',
    risk: 'read_only',
    inputSchema: PackageScriptInputSchema,
    cacheable: true,
    producesEvidence: true,
    timeoutMs: 180_000,
    async execute(input, context) {
      return runPackageScript('typecheck.run', 'typecheck', input.args ?? [], context, { timeoutMs: input.timeoutMs || 180_000 });
    },
  });

  broker.register({
    name: 'lint.run',
    description: 'Run the package lint script through the Resource Governor.',
    risk: 'read_only',
    inputSchema: PackageScriptInputSchema,
    cacheable: true,
    producesEvidence: true,
    timeoutMs: 180_000,
    async execute(input, context) {
      return runPackageScript('lint.run', 'lint', input.args ?? [], context, { timeoutMs: input.timeoutMs || 180_000 });
    },
  });

  broker.register({
    name: 'build.run',
    description: 'Request a full package build, preferring remote validation instead of VPS execution.',
    risk: 'write_local',
    inputSchema: PackageScriptInputSchema,
    cacheable: true,
    producesEvidence: true,
    remotePreferred: true,
    timeoutMs: 900_000,
    async execute(input, context) {
      return runPackageScript('build.run', 'build', input.args ?? [], context, {
        timeoutMs: input.timeoutMs || 900_000,
        heavy: true,
        remotePreferred: true,
      });
    },
  });

  broker.register({
    name: 'service.status',
    description: 'Inspect a systemd service status without mutating it.',
    risk: 'read_only',
    inputSchema: ServiceInputSchema,
    cacheable: false,
    producesEvidence: true,
    timeoutMs: 20_000,
    async execute(input, context) {
      const result = await runGovernedCommand('systemctl', [
        'show', input.service,
        '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,ExecMainStatus,MemoryCurrent,TasksCurrent',
      ], { cwd: context.cwd, timeoutMs: 20_000, signal: context.signal });
      return governedCommandEvidence('service.status', result, { successSummary: `Service status captured for ${input.service}.` });
    },
  });

  broker.register({
    name: 'service.logs',
    description: 'Read bounded systemd journal lines for one service.',
    risk: 'read_only',
    inputSchema: ServiceLogsInputSchema,
    cacheable: false,
    producesEvidence: true,
    timeoutMs: 30_000,
    async execute(input, context) {
      const args = ['-u', input.service, '-n', String(input.lines), '--no-pager', '--output=short-iso'];
      if (input.since) args.push('--since', input.since);
      const result = await runGovernedCommand('journalctl', args, {
        cwd: context.cwd,
        timeoutMs: 30_000,
        maxOutputBytes: 2_000_000,
        signal: context.signal,
      });
      return governedCommandEvidence('service.logs', result, { successSummary: `Captured ${input.lines} bounded log lines for ${input.service}.` });
    },
  });

  broker.register({
    name: 'service.restart',
    description: 'Restart one systemd service after explicit production approval.',
    risk: 'production',
    inputSchema: ServiceInputSchema,
    cacheable: false,
    producesEvidence: true,
    requiresApproval: true,
    timeoutMs: 60_000,
    async execute(input, context) {
      const result = await runGovernedCommand('systemctl', ['restart', input.service], {
        cwd: context.cwd,
        timeoutMs: 60_000,
        signal: context.signal,
      });
      return governedCommandEvidence('service.restart', result, { successSummary: `Service ${input.service} restarted.` });
    },
  });

  broker.register({
    name: 'port.inspect',
    description: 'Inspect listening TCP ports and owning processes.',
    risk: 'read_only',
    inputSchema: PortInspectInputSchema,
    cacheable: false,
    producesEvidence: true,
    timeoutMs: 20_000,
    async execute(input, context) {
      const result = await runGovernedCommand('ss', ['-ltnp'], { cwd: context.cwd, timeoutMs: 20_000, signal: context.signal });
      if (!result.ok || !input.port) return governedCommandEvidence('port.inspect', result, { successSummary: 'Listening TCP ports captured.' });
      const lines = result.stdout.split('\n').filter((line) => new RegExp(`[:.]${input.port}\\b`).test(line));
      return ToolEvidenceSchema.parse({
        tool: 'port.inspect',
        status: 'success',
        summary: lines.length ? `Port ${input.port} is present in ${lines.length} listening socket record(s).` : `No listener found for port ${input.port}.`,
        details: { port: input.port, records: lines.slice(0, 100) },
        durationMs: result.durationMs,
        cacheable: false,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'json.validate',
    description: 'Parse JSON deterministically and report syntax location on failure.',
    risk: 'read_only',
    inputSchema: JsonValidateInputSchema,
    cacheable: true,
    producesEvidence: true,
    async execute(input) {
      const started = Date.now();
      try {
        const value = JSON.parse(input.text) as unknown;
        return ToolEvidenceSchema.parse({
          tool: 'json.validate',
          status: 'success',
          summary: 'JSON is syntactically valid.',
          details: { valueType: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value, bytes: Buffer.byteLength(input.text) },
          durationMs: Date.now() - started,
          cacheable: true,
          evidence: true,
        });
      } catch (error) {
        return ToolEvidenceSchema.parse({
          tool: 'json.validate',
          status: 'failed',
          summary: error instanceof Error ? error.message : String(error),
          details: { bytes: Buffer.byteLength(input.text) },
          durationMs: Date.now() - started,
          cacheable: false,
          evidence: true,
        });
      }
    },
  });

  broker.register({
    name: 'schema.validate',
    description: 'Validate a value against a deterministic JSON Schema subset.',
    risk: 'read_only',
    inputSchema: SchemaValidateInputSchema,
    cacheable: true,
    producesEvidence: true,
    async execute(input) {
      const started = Date.now();
      const errors = validateSchemaSubset(input.value, input.schema);
      return ToolEvidenceSchema.parse({
        tool: 'schema.validate',
        status: errors.length ? 'failed' : 'success',
        summary: errors.length ? `Schema validation failed with ${errors.length} error(s).` : 'Schema validation passed.',
        details: { errors },
        durationMs: Date.now() - started,
        cacheable: !errors.length,
        evidence: true,
      });
    },
  });

  broker.register({
    name: 'secret.scan',
    description: 'Scan repository files for likely secrets while returning fingerprints instead of secret values.',
    risk: 'secret_sensitive',
    inputSchema: SecretScanInputSchema,
    cacheable: false,
    producesEvidence: true,
    requiresApproval: false,
    timeoutMs: 120_000,
    async execute(input, context) {
      const started = Date.now();
      const index = await buildRepositoryIndex(context.cwd);
      const maxFiles = input.maxFiles ?? 2_000;
      const requested = input.paths?.length
        ? input.paths.map((candidate) => {
            resolveRepositoryPath(context.cwd, candidate);
            return candidate.split(path.sep).join('/');
          })
        : index.files.filter((file) => !file.binary).map((file) => file.path);
      const findings: Array<{ file: string; line: number; kind: string; fingerprint: string }> = [];
      for (const relativePath of requested.slice(0, maxFiles)) {
        const absolute = resolveRepositoryPath(context.cwd, relativePath);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 2_000_000) continue;
        let text: string;
        try {
          text = fs.readFileSync(absolute, 'utf8');
        } catch {
          continue;
        }
        for (const pattern of SECRET_PATTERNS) {
          pattern.expression.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.expression.exec(text)) && findings.length < 1_000) {
            const value = match[1] || match[0];
            const line = text.slice(0, match.index).split('\n').length;
            findings.push({ file: relativePath, line, kind: pattern.kind, fingerprint: secretFingerprint(value) });
          }
        }
      }
      return ToolEvidenceSchema.parse({
        tool: 'secret.scan',
        status: findings.length ? 'failed' : 'success',
        summary: findings.length
          ? `Detected ${findings.length} potential secret occurrence(s); values were not returned.`
          : 'No likely secrets were detected by the configured patterns.',
        details: { scannedFiles: Math.min(requested.length, maxFiles), findings },
        durationMs: Date.now() - started,
        cacheable: false,
        evidence: true,
      });
    },
  });

  return broker;
}
