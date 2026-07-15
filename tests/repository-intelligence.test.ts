import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeChangeImpact,
  buildRepositoryIndex,
  findRepositoryReferences,
  findRepositorySymbols,
  searchRepository,
} from '../app/lib/repository-intelligence';
import { createDefaultToolBroker } from '../app/lib/tool-broker';

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-repo-index-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: {
      test: 'node --test',
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      build: 'next build',
    },
    dependencies: { zod: '^3.25.0' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), [
    'export function alpha(value: number): number {',
    '  return value + 1;',
    '}',
    '',
    'export const ALPHA_VERSION = 1;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), [
    "import { alpha } from './alpha';",
    '',
    'export function consume(): number {',
    '  return alpha(2);',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'tests', 'alpha.test.ts'), [
    "import { alpha } from '../src/alpha';",
    '',
    "test('alpha', () => {",
    '  if (alpha(1) !== 2) throw new Error(\'failed\');',
    '});',
    '',
  ].join('\n'));
  return root;
}

test('repository intelligence builds symbols, references, imports, tests, scripts, and incremental reuse', async (context) => {
  const root = createFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await buildRepositoryIndex(root);
  assert.equal(first.files.length, 5);
  assert.equal(first.packageScripts.build, 'next build');
  assert.equal(first.packageDependencies.zod, '^3.25.0');
  assert.ok(first.configFiles.includes('package.json'));
  assert.ok(first.configFiles.includes('tsconfig.json'));

  const alpha = findRepositorySymbols(first, 'alpha');
  assert.ok(alpha.some((symbol) => symbol.file === 'src/alpha.ts' && symbol.kind === 'function' && symbol.exported));
  const references = findRepositoryReferences(first, 'alpha');
  assert.ok(references.some((reference) => reference.file === 'src/consumer.ts'));
  assert.ok(first.reverseImportGraph['src/alpha.ts'].includes('src/consumer.ts'));
  assert.ok(first.testRelationships['src/alpha.ts'].includes('tests/alpha.test.ts'));

  const matches = searchRepository(first, 'return alpha', 10);
  assert.deepEqual(matches.map((match) => match.file), ['src/consumer.ts']);

  const second = await buildRepositoryIndex(root);
  assert.equal(second.stats.changedFiles, 0);
  assert.equal(second.stats.reusedFiles, 5);

  fs.appendFileSync(path.join(root, 'src', 'consumer.ts'), '\nexport const extra = alpha(4);\n');
  const third = await buildRepositoryIndex(root);
  assert.equal(third.stats.changedFiles, 1);
  assert.equal(third.stats.reusedFiles, 4);

  const impact = analyzeChangeImpact(third, ['src/alpha.ts']);
  assert.ok(impact.directDependents.includes('src/consumer.ts'));
  assert.ok(impact.relatedTests.includes('tests/alpha.test.ts'));
  assert.ok(impact.affectedFiles.includes('src/alpha.ts'));
});

test('production repository index persists outside the read-only checkout', async (context) => {
  const root = createFixture();
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etla-repo-cache-'));
  const previousCacheRoot = process.env.ZENOS_RUNTIME_REPOSITORY_INDEX_DIR;
  context.after(() => {
    if (previousCacheRoot === undefined) delete process.env.ZENOS_RUNTIME_REPOSITORY_INDEX_DIR;
    else process.env.ZENOS_RUNTIME_REPOSITORY_INDEX_DIR = previousCacheRoot;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  process.env.ZENOS_RUNTIME_REPOSITORY_INDEX_DIR = cacheRoot;
  await buildRepositoryIndex(root);

  const persisted = fs.readdirSync(cacheRoot).filter((name) => name.endsWith('.json'));
  assert.equal(persisted.length, 1);
  assert.equal(fs.existsSync(path.join(root, '.data')), false);
});

test('default tool broker exposes real repository and validation tools', async (context) => {
  const root = createFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = createDefaultToolBroker();
  const names = broker.list().map((tool) => tool.name);
  for (const expected of [
    'repo.index',
    'repo.search',
    'repo.read',
    'repo.symbol',
    'repo.references',
    'repo.diff',
    'repo.patch',
    'test.run',
    'typecheck.run',
    'lint.run',
    'build.run',
    'service.status',
    'service.logs',
    'service.restart',
    'port.inspect',
    'json.validate',
    'schema.validate',
    'secret.scan',
  ]) assert.ok(names.includes(expected), `missing tool ${expected}`);

  const toolContext = { cwd: root, approvalGranted: false, allowProduction: false };
  const symbol = await broker.execute('repo.symbol', { name: 'alpha' }, toolContext);
  assert.equal(symbol.status, 'success');
  const symbolResults = symbol.details.symbols as Array<{ name: string; file: string }>;
  assert.ok(symbolResults.some((entry) => entry.name === 'alpha' && entry.file === 'src/alpha.ts'));

  const read = await broker.execute('repo.read', { path: 'src/alpha.ts', startLine: 1, endLine: 3 }, toolContext);
  assert.equal(read.status, 'success');
  assert.match(String(read.details.content), /export function alpha/);

  const build = await broker.execute('build.run', {}, toolContext);
  assert.equal(build.status, 'remote_required');
  assert.match(build.summary, /Remote validation required/);

  const schema = await broker.execute('schema.validate', {
    value: { name: 'Etla', count: 2 },
    schema: {
      type: 'object',
      required: ['name', 'count'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2 },
        count: { type: 'integer', minimum: 1 },
      },
    },
  }, toolContext);
  assert.equal(schema.status, 'success');
});
