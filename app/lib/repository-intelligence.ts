import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { runGovernedCommand } from './resource-governor';

const INDEX_VERSION = 1;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.data',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'tmp',
]);

export const RepositoryLanguageSchema = z.enum([
  'typescript',
  'javascript',
  'json',
  'markdown',
  'css',
  'html',
  'python',
  'shell',
  'yaml',
  'toml',
  'sql',
  'other',
]);
export type RepositoryLanguage = z.infer<typeof RepositoryLanguageSchema>;

export const RepositorySymbolSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable', 'method', 'python_function', 'python_class']),
  file: z.string().min(1),
  line: z.number().int().positive(),
  exported: z.boolean(),
});
export type RepositorySymbol = z.infer<typeof RepositorySymbolSchema>;

export const RepositoryReferenceSchema = z.object({
  symbol: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
});
export type RepositoryReference = z.infer<typeof RepositoryReferenceSchema>;

export const RepositoryFileRecordSchema = z.object({
  path: z.string().min(1),
  hash: z.string().length(64),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
  language: RepositoryLanguageSchema,
  binary: z.boolean(),
  imports: z.array(z.string()),
  resolvedImports: z.array(z.string()),
  symbols: z.array(RepositorySymbolSchema),
  references: z.array(RepositoryReferenceSchema),
});
export type RepositoryFileRecord = z.infer<typeof RepositoryFileRecordSchema>;

export const RepositoryGitStateSchema = z.object({
  available: z.boolean(),
  head: z.string(),
  branch: z.string(),
  changedFiles: z.array(z.string()),
  stagedFiles: z.array(z.string()),
  untrackedFiles: z.array(z.string()),
});
export type RepositoryGitState = z.infer<typeof RepositoryGitStateSchema>;

export const RepositoryIndexSchema = z.object({
  version: z.literal(INDEX_VERSION),
  root: z.string().min(1),
  revision: z.string().min(1),
  generatedAt: z.string().datetime(),
  files: z.array(RepositoryFileRecordSchema),
  languageMap: z.record(z.string(), z.number().int().nonnegative()),
  symbols: z.array(RepositorySymbolSchema),
  references: z.record(z.string(), z.array(RepositoryReferenceSchema)),
  importGraph: z.record(z.string(), z.array(z.string())),
  reverseImportGraph: z.record(z.string(), z.array(z.string())),
  testRelationships: z.record(z.string(), z.array(z.string())),
  packageScripts: z.record(z.string(), z.string()),
  packageDependencies: z.record(z.string(), z.string()),
  configFiles: z.array(z.string()),
  git: RepositoryGitStateSchema,
  stats: z.object({
    scannedFiles: z.number().int().nonnegative(),
    parsedFiles: z.number().int().nonnegative(),
    reusedFiles: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    removedFiles: z.number().int().nonnegative(),
    skippedLargeFiles: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
});
export type RepositoryIndex = z.infer<typeof RepositoryIndexSchema>;

export const ChangeImpactSchema = z.object({
  changedFiles: z.array(z.string()),
  changedSymbols: z.array(z.string()),
  directDependents: z.array(z.string()),
  relatedTests: z.array(z.string()),
  affectedFiles: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()),
});
export type ChangeImpact = z.infer<typeof ChangeImpactSchema>;

export type RepositoryIndexOptions = {
  cachePath?: string;
  persist?: boolean;
  forceFull?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  ignoredDirectories?: string[];
};

type IdentifierOccurrence = { name: string; line: number };
type ParsedFile = { record: RepositoryFileRecord; identifiers: IdentifierOccurrence[]; text?: string };

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function defaultCachePath(root: string): string {
  const workspaceKey = sha256(path.resolve(root)).slice(0, 16);
  return path.join(root, '.data', 'repository-index', `${workspaceKey}.json`);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveRepositoryPath(root: string, relativePath: string): string {
  const absoluteRoot = fs.realpathSync.native(path.resolve(root));
  const unresolved = path.resolve(absoluteRoot, relativePath);
  if (!isInsideRoot(absoluteRoot, unresolved)) throw new Error(`Path escapes repository root: ${relativePath}`);
  let ancestor = unresolved;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Could not resolve repository path: ${relativePath}`);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const candidate = path.join(fs.realpathSync.native(ancestor), ...missing);
  if (!isInsideRoot(absoluteRoot, candidate)) throw new Error(`Path resolves outside repository root: ${relativePath}`);
  return candidate;
}

function languageForFile(relativePath: string): RepositoryLanguage {
  const basename = path.basename(relativePath).toLowerCase();
  const extension = path.extname(basename);
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  if (extension === '.json' || basename.endsWith('.jsonc')) return 'json';
  if (['.md', '.mdx'].includes(extension)) return 'markdown';
  if (['.css', '.scss', '.sass', '.less'].includes(extension)) return 'css';
  if (['.html', '.htm'].includes(extension)) return 'html';
  if (extension === '.py') return 'python';
  if (['.sh', '.bash', '.zsh'].includes(extension) || basename === 'dockerfile') return 'shell';
  if (['.yaml', '.yml'].includes(extension)) return 'yaml';
  if (extension === '.toml') return 'toml';
  if (extension === '.sql') return 'sql';
  return 'other';
}

function isConfigFile(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  return /^(package(?:-lock)?\.json|tsconfig(?:\..+)?\.json|eslint\.config\..+|next\.config\..+|vite\.config\..+|vitest\.config\..+|jest\.config\..+|dockerfile|docker-compose.*\.ya?ml|compose.*\.ya?ml|vercel\.json|\.github|\.env\.example|pyproject\.toml|cargo\.toml|go\.mod)$/.test(basename)
    || relativePath.startsWith('.github/workflows/');
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(relativePath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relativePath)
    || /_test\.py$/i.test(relativePath);
}

function likelyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return !sample.includes(0);
}

function enumerateFiles(root: string, options: RepositoryIndexOptions): string[] {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const ignored = new Set([...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignoredDirectories || [])]);
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    if (!directory) break;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return files;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(normalizeRelative(path.relative(root, absolute)));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function parseSymbols(text: string, relativePath: string, language: RepositoryLanguage): RepositorySymbol[] {
  const symbols: RepositorySymbol[] = [];
  const seen = new Set<string>();
  const addMatches = (
    expression: RegExp,
    kind: RepositorySymbol['kind'],
    nameGroup: number,
    exported: (match: RegExpExecArray) => boolean,
  ) => {
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
      const name = match[nameGroup];
      if (!name) continue;
      const line = lineAt(text, match.index);
      const key = `${name}:${kind}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, file: relativePath, line, exported: exported(match) });
    }
  };

  if (language === 'typescript' || language === 'javascript') {
    addMatches(/(^|\n)\s*(export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, 'function', 3, (match) => Boolean(match[2]));
    addMatches(/(^|\n)\s*(export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\b/g, 'class', 3, (match) => Boolean(match[2]));
    addMatches(/(^|\n)\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/g, 'interface', 3, (match) => Boolean(match[2]));
    addMatches(/(^|\n)\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, 'type', 3, (match) => Boolean(match[2]));
    addMatches(/(^|\n)\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/g, 'enum', 3, (match) => Boolean(match[2]));
    addMatches(/(^|\n)\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g, 'variable', 3, (match) => Boolean(match[2]));
  } else if (language === 'python') {
    addMatches(/(^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g, 'python_function', 2, () => false);
    addMatches(/(^|\n)\s*class\s+([A-Za-z_][\w]*)\b/g, 'python_class', 2, () => false);
  }
  return symbols.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}

function parseImports(text: string, language: RepositoryLanguage): string[] {
  const imports: string[] = [];
  const collect = (expression: RegExp, group: number) => {
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
      if (match[group]) imports.push(match[group]);
    }
  };
  if (language === 'typescript' || language === 'javascript') {
    collect(/\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g, 1);
    collect(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, 1);
    collect(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, 1);
  } else if (language === 'python') {
    collect(/(^|\n)\s*from\s+([.\w]+)\s+import\s+/g, 2);
    collect(/(^|\n)\s*import\s+([\w.]+)/g, 2);
  }
  return stableUnique(imports);
}

function parseIdentifiers(text: string, maxOccurrences = 100_000): IdentifierOccurrence[] {
  const output: IdentifierOccurrence[] = [];
  const expression = /\b[A-Za-z_$][\w$]*\b/g;
  let match: RegExpExecArray | null;
  let line = 1;
  let cursor = 0;
  while ((match = expression.exec(text)) && output.length < maxOccurrences) {
    for (let index = cursor; index < match.index; index += 1) {
      if (text.charCodeAt(index) === 10) line += 1;
    }
    cursor = match.index + match[0].length;
    output.push({ name: match[0], line });
  }
  return output;
}

function loadPreviousIndex(cachePath: string): RepositoryIndex | undefined {
  try {
    if (!fs.existsSync(cachePath)) return undefined;
    return RepositoryIndexSchema.parse(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } catch {
    return undefined;
  }
}

function persistIndex(cachePath: string, index: RepositoryIndex): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index), { mode: 0o600 });
  fs.renameSync(temporary, cachePath);
}

function resolveImportPath(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalizeRelative(path.join(path.dirname(fromFile), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

async function readGitState(root: string): Promise<RepositoryGitState> {
  const [headResult, branchResult, statusResult] = await Promise.all([
    runGovernedCommand('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 }),
    runGovernedCommand('git', ['branch', '--show-current'], { cwd: root, timeoutMs: 10_000 }),
    runGovernedCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, timeoutMs: 15_000 }),
  ]);
  if (!headResult.ok || !statusResult.ok) {
    return {
      available: false,
      head: '',
      branch: '',
      changedFiles: [],
      stagedFiles: [],
      untrackedFiles: [],
    };
  }
  const changedFiles: string[] = [];
  const stagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (const rawLine of statusResult.stdout.split('\n')) {
    if (rawLine.length < 4) continue;
    const x = rawLine[0];
    const y = rawLine[1];
    let file = rawLine.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').at(-1) || file;
    file = file.replace(/^"|"$/g, '');
    if (!file) continue;
    changedFiles.push(normalizeRelative(file));
    if (x === '?' && y === '?') untrackedFiles.push(normalizeRelative(file));
    else if (x !== ' ') stagedFiles.push(normalizeRelative(file));
  }
  return {
    available: true,
    head: headResult.stdout.trim(),
    branch: branchResult.ok ? branchResult.stdout.trim() : '',
    changedFiles: stableUnique(changedFiles),
    stagedFiles: stableUnique(stagedFiles),
    untrackedFiles: stableUnique(untrackedFiles),
  };
}

function readPackageMetadata(root: string): { scripts: Record<string, string>; dependencies: Record<string, string> } {
  const packagePath = path.join(root, 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const scripts = Object.fromEntries(Object.entries(parsed.scripts || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const dependencies = Object.fromEntries(
      Object.entries({
        ...(parsed.dependencies || {}),
        ...(parsed.devDependencies || {}),
        ...(parsed.peerDependencies || {}),
        ...(parsed.optionalDependencies || {}),
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    return { scripts, dependencies };
  } catch {
    return { scripts: {}, dependencies: {} };
  }
}

function deriveTestRelationships(files: RepositoryFileRecord[]): Record<string, string[]> {
  const relationships = new Map<string, Set<string>>();
  const fileSet = new Set(files.map((file) => file.path));
  const byStem = new Map<string, string[]>();
  for (const file of files) {
    const basename = path.basename(file.path).replace(/\.(?:test|spec)(?=\.)/i, '').replace(/\.[^.]+$/, '');
    const candidates = byStem.get(basename) || [];
    candidates.push(file.path);
    byStem.set(basename, candidates);
  }
  for (const testFile of files.filter((file) => isTestFile(file.path))) {
    for (const imported of testFile.resolvedImports) {
      if (isTestFile(imported)) continue;
      const current = relationships.get(imported) || new Set<string>();
      current.add(testFile.path);
      relationships.set(imported, current);
    }
    const stem = path.basename(testFile.path).replace(/\.(?:test|spec)(?=\.)/i, '').replace(/_test(?=\.)/i, '').replace(/\.[^.]+$/, '');
    for (const candidate of byStem.get(stem) || []) {
      if (candidate === testFile.path || isTestFile(candidate) || !fileSet.has(candidate)) continue;
      const current = relationships.get(candidate) || new Set<string>();
      current.add(testFile.path);
      relationships.set(candidate, current);
    }
  }
  return Object.fromEntries([...relationships.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, tests]) => [source, [...tests].sort((left, right) => left.localeCompare(right))]));
}

export async function buildRepositoryIndex(root: string, options: RepositoryIndexOptions = {}): Promise<RepositoryIndex> {
  const started = Date.now();
  const absoluteRoot = path.resolve(root);
  const stat = fs.statSync(absoluteRoot);
  if (!stat.isDirectory()) throw new Error(`Repository root is not a directory: ${absoluteRoot}`);
  const cachePath = options.cachePath || defaultCachePath(absoluteRoot);
  const previous = options.forceFull ? undefined : loadPreviousIndex(cachePath);
  const previousByPath = new Map((previous?.root === absoluteRoot ? previous.files : []).map((file) => [file.path, file]));
  const relativeFiles = enumerateFiles(absoluteRoot, options);
  const maxFileBytes = Math.max(1_024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const parsedFiles: ParsedFile[] = [];
  let reusedFiles = 0;
  let changedFiles = 0;
  let skippedLargeFiles = 0;

  for (const relativePath of relativeFiles) {
    const absolutePath = resolveRepositoryPath(absoluteRoot, relativePath);
    const fileStat = fs.statSync(absolutePath);
    if (fileStat.size > maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    const buffer = fs.readFileSync(absolutePath);
    const hash = sha256(buffer);
    const language = languageForFile(relativePath);
    const binary = !likelyText(buffer);
    const previousRecord = previousByPath.get(relativePath);
    const unchanged = previousRecord?.hash === hash;
    const text = binary ? undefined : buffer.toString('utf8');
    if (unchanged && previousRecord) reusedFiles += 1;
    else changedFiles += 1;
    const record: RepositoryFileRecord = unchanged && previousRecord
      ? { ...previousRecord, modifiedAtMs: fileStat.mtimeMs, sizeBytes: fileStat.size }
      : {
          path: relativePath,
          hash,
          sizeBytes: fileStat.size,
          modifiedAtMs: fileStat.mtimeMs,
          language,
          binary,
          imports: text ? parseImports(text, language) : [],
          resolvedImports: [],
          symbols: text ? parseSymbols(text, relativePath, language) : [],
          references: [],
        };
    parsedFiles.push({
      record,
      identifiers: text && !unchanged && ['typescript', 'javascript', 'python'].includes(language) ? parseIdentifiers(text) : [],
      text,
    });
  }

  const files = parsedFiles.map((parsed) => parsed.record);
  const fileSet = new Set(files.map((file) => file.path));
  const importGraph: Record<string, string[]> = {};
  const reverseMap = new Map<string, Set<string>>();
  for (const file of files) {
    file.resolvedImports = stableUnique(file.imports.map((specifier) => resolveImportPath(file.path, specifier, fileSet)).filter((value): value is string => Boolean(value)));
    importGraph[file.path] = file.resolvedImports;
    for (const imported of file.resolvedImports) {
      const dependents = reverseMap.get(imported) || new Set<string>();
      dependents.add(file.path);
      reverseMap.set(imported, dependents);
    }
  }
  const reverseImportGraph = Object.fromEntries([...reverseMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, dependents]) => [file, [...dependents].sort((left, right) => left.localeCompare(right))]));

  const symbols = files.flatMap((file) => file.symbols)
    .sort((left, right) => left.name.localeCompare(right.name) || left.file.localeCompare(right.file) || left.line - right.line);
  const symbolNames = new Set(symbols.map((symbol) => symbol.name));
  const previousSymbolNames = new Set((previous?.symbols || []).map((symbol) => symbol.name));
  const symbolUniverseChanged = symbolNames.size !== previousSymbolNames.size
    || [...symbolNames].some((name) => !previousSymbolNames.has(name));
  const references: Record<string, RepositoryReference[]> = {};
  for (const parsed of parsedFiles) {
    const previousRecord = previousByPath.get(parsed.record.path);
    const canReuseReferences = !symbolUniverseChanged && previousRecord?.hash === parsed.record.hash;
    const identifiers = !canReuseReferences && !parsed.identifiers.length && parsed.text
      ? parseIdentifiers(parsed.text)
      : parsed.identifiers;
    const fileReferences = canReuseReferences
      ? previousRecord.references
      : identifiers
          .filter((occurrence) => symbolNames.has(occurrence.name))
          .map((occurrence) => ({ symbol: occurrence.name, file: parsed.record.path, line: occurrence.line }));
    parsed.record.references = fileReferences;
    for (const reference of fileReferences) {
      const definitionAtSameLine = parsed.record.symbols.some((symbol) => symbol.name === reference.symbol && symbol.line === reference.line);
      if (definitionAtSameLine) continue;
      const current = references[reference.symbol] || [];
      current.push(reference);
      references[reference.symbol] = current;
    }
  }
  for (const symbol of Object.keys(references)) {
    references[symbol] = references[symbol]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
      .filter((reference, index, all) => index === 0 || reference.file !== all[index - 1].file || reference.line !== all[index - 1].line);
  }

  const languageMap: Record<string, number> = {};
  for (const file of files) languageMap[file.language] = (languageMap[file.language] || 0) + 1;
  const packageMetadata = readPackageMetadata(absoluteRoot);
  const git = await readGitState(absoluteRoot);
  const revisionMaterial = files.map((file) => `${file.path}:${file.hash}`).join('\n');
  const dirtyMaterial = git.changedFiles.join('\n');
  const revision = sha256(`${git.head}\n${dirtyMaterial}\n${revisionMaterial}`);
  const previousPaths = new Set(previous?.files.map((file) => file.path) || []);
  const removedFiles = [...previousPaths].filter((file) => !fileSet.has(file)).length;
  const index = RepositoryIndexSchema.parse({
    version: INDEX_VERSION,
    root: absoluteRoot,
    revision,
    generatedAt: new Date().toISOString(),
    files,
    languageMap,
    symbols,
    references,
    importGraph,
    reverseImportGraph,
    testRelationships: deriveTestRelationships(files),
    packageScripts: packageMetadata.scripts,
    packageDependencies: packageMetadata.dependencies,
    configFiles: files.map((file) => file.path).filter(isConfigFile).sort((left, right) => left.localeCompare(right)),
    git,
    stats: {
      scannedFiles: relativeFiles.length,
      parsedFiles: files.length,
      reusedFiles,
      changedFiles,
      removedFiles,
      skippedLargeFiles,
      durationMs: Date.now() - started,
    },
  });
  if (options.persist !== false) persistIndex(cachePath, index);
  return index;
}

export function findRepositorySymbols(index: RepositoryIndex, name: string, limit = 50): RepositorySymbol[] {
  const query = name.trim().toLowerCase();
  if (!query) return [];
  return index.symbols
    .filter((symbol) => symbol.name.toLowerCase() === query || symbol.name.toLowerCase().includes(query))
    .sort((left, right) => Number(left.name.toLowerCase() !== query) - Number(right.name.toLowerCase() !== query)
      || left.name.localeCompare(right.name)
      || left.file.localeCompare(right.file))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function findRepositoryReferences(index: RepositoryIndex, name: string, limit = 200): RepositoryReference[] {
  const exact = index.references[name] || [];
  if (exact.length) return exact.slice(0, Math.max(1, Math.min(limit, 2_000)));
  const query = name.trim().toLowerCase();
  return Object.entries(index.references)
    .filter(([symbol]) => symbol.toLowerCase().includes(query))
    .flatMap(([, references]) => references)
    .slice(0, Math.max(1, Math.min(limit, 2_000)));
}

export function searchRepository(index: RepositoryIndex, query: string, limit = 50): Array<{ file: string; line: number; snippet: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  const output: Array<{ file: string; line: number; snippet: string }> = [];
  const maxResults = Math.max(1, Math.min(limit, 500));
  for (const file of index.files) {
    if (output.length >= maxResults || file.binary) break;
    const absolute = resolveRepositoryPath(index.root, file.path);
    let text: string;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length && output.length < maxResults; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      output.push({ file: file.path, line: lineIndex + 1, snippet: line.trim().slice(0, 500) });
    }
  }
  return output;
}

export function analyzeChangeImpact(index: RepositoryIndex, changedFilesInput?: string[]): ChangeImpact {
  const changedFiles = stableUnique((changedFilesInput?.length ? changedFilesInput : index.git.changedFiles)
    .map(normalizeRelative)
    .filter((file) => index.files.some((entry) => entry.path === file) || index.git.changedFiles.includes(file)));
  const changedSymbols = stableUnique(index.symbols.filter((symbol) => changedFiles.includes(symbol.file)).map((symbol) => symbol.name));
  const directDependents = stableUnique(changedFiles.flatMap((file) => index.reverseImportGraph[file] || []));
  const relatedTests = stableUnique([...changedFiles, ...directDependents].flatMap((file) => index.testRelationships[file] || []));
  const affectedFiles = stableUnique([...changedFiles, ...directDependents, ...relatedTests]);
  const reasons: string[] = [];
  let risk: ChangeImpact['risk'] = 'low';
  if (changedFiles.some((file) => isConfigFile(file) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file))) {
    risk = 'high';
    reasons.push('configuration or dependency metadata changed');
  }
  if (affectedFiles.length > 12 || directDependents.length > 8) {
    risk = 'high';
    reasons.push('change fan-out exceeds the bounded local impact threshold');
  } else if (risk !== 'high' && (affectedFiles.length > 4 || directDependents.length > 2 || changedFiles.length > 2)) {
    risk = 'medium';
    reasons.push('change affects multiple files or direct dependents');
  }
  if (changedSymbols.length > 10 && risk === 'low') {
    risk = 'medium';
    reasons.push('many symbol definitions are touched');
  }
  if (!relatedTests.length && changedFiles.some((file) => ['typescript', 'javascript', 'python'].includes(index.files.find((entry) => entry.path === file)?.language || 'other'))) {
    if (risk === 'low') risk = 'medium';
    reasons.push('no related tests were discovered for changed source files');
  }
  if (!reasons.length) reasons.push('bounded change with limited dependency fan-out');
  return ChangeImpactSchema.parse({ changedFiles, changedSymbols, directDependents, relatedTests, affectedFiles, risk, reasons });
}

export function renderRepositoryContext(index: RepositoryIndex, impact?: ChangeImpact): string {
  const selectedImpact = impact || analyzeChangeImpact(index);
  const importantFiles = stableUnique([
    ...selectedImpact.changedFiles,
    ...selectedImpact.directDependents,
    ...selectedImpact.relatedTests,
    ...index.configFiles.slice(0, 12),
  ]).slice(0, 40);
  const relevantSymbols = index.symbols
    .filter((symbol) => importantFiles.includes(symbol.file))
    .slice(0, 80)
    .map((symbol) => `${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`);
  return [
    `Repository root: ${index.root}`,
    `Repository revision: ${index.revision}`,
    `Git: ${index.git.available ? `${index.git.branch || 'detached'}@${index.git.head.slice(0, 12)}` : 'unavailable'}`,
    `Indexed files: ${index.files.length}; reused: ${index.stats.reusedFiles}; changed: ${index.stats.changedFiles}; removed: ${index.stats.removedFiles}`,
    `Languages: ${Object.entries(index.languageMap).map(([language, count]) => `${language}=${count}`).join(', ') || 'none'}`,
    `Package scripts: ${Object.keys(index.packageScripts).join(', ') || 'none'}`,
    `Current changed files: ${index.git.changedFiles.join(', ') || 'none'}`,
    `Impact risk: ${selectedImpact.risk}; affected files: ${selectedImpact.affectedFiles.join(', ') || 'none'}`,
    `Impact reasons: ${selectedImpact.reasons.join('; ')}`,
    `Relevant symbols:\n${relevantSymbols.join('\n') || 'none'}`,
  ].join('\n');
}
