import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function parseEnvironment(filename: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, index)] = value;
  }
  return values;
}

test('deployment prepares separate least-privilege Runtime and full Hermes credentials', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zenos-credentials-'));
  try {
    const runtimeEnvironment = path.join(directory, 'zenos-runtime.env');
    const runtimeConfig = path.join(directory, 'runtime-config.yaml');
    const sourceConfig = path.join(directory, 'config.yaml');
    const modelOutput = path.join(directory, 'models-output.json');
    const modelInput = path.join(directory, 'models-input.json');
    const hermesConfig = path.join(directory, 'hermes-config.yaml');
    const hermesEnvironment = path.join(directory, 'hermes-zenos.env');
    const sourceEnvironment = path.join(directory, 'source.env');

    writeFileSync(sourceConfig, [
      'model:',
      '  default: grok',
      '  provider: etla-router',
      'providers:',
      '  etla-router:',
      '    base_url: http://127.0.0.1:20128/model',
      '    default_model: grok',
      '    api_key: ${HERMES_CONFIG_PROVIDERS_ETLA_ROUTER_API_KEY}',
      'telegram:',
      '  token: ${TELEGRAM_BOT_TOKEN}',
      'wallet:',
      '  private_key: ${PRIVATE_KEY}',
      '',
    ].join('\n'));
    writeFileSync(modelInput, JSON.stringify({
      hostModel: 'grok',
      workerModel: 'build',
      bossModel: 'codex',
      verifierModel: 'ag/gemini-3.5-flash-low',
    }));
    writeFileSync(sourceEnvironment, [
      'ETLA_MASTER_SECRET=runtime-auth-secret',
      'ZENOS_RUNTIME_API_KEY=runtime-api-secret',
      'ZENOS_MEMORY_API_KEY=memory-api-secret',
      'HERMES_CONFIG_PROVIDERS_ETLA_ROUTER_API_KEY=router-api-secret',
      'TELEGRAM_BOT_TOKEN=telegram-secret',
      'PRIVATE_KEY=wallet-private-key',
      'MNEMONIC=wallet-mnemonic',
      'X_PASSWORD=social-password',
      '',
    ].join('\n'));

    const result = spawnSync('python3', [
      'scripts/prepare-runtime-service-files.py',
      runtimeEnvironment,
      runtimeConfig,
      sourceConfig,
      modelOutput,
      modelInput,
      hermesConfig,
      hermesEnvironment,
      sourceEnvironment,
    ], { cwd: path.resolve('.'), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const runtime = parseEnvironment(runtimeEnvironment);
    const hermes = parseEnvironment(hermesEnvironment);

    assert.equal(runtime.ETLA_MASTER_SECRET, 'runtime-auth-secret');
    assert.equal(runtime.ZENOS_RUNTIME_API_KEY, 'runtime-api-secret');
    assert.equal(runtime.ZENOS_MEMORY_API_KEY, 'memory-api-secret');
    assert.equal(runtime.ZENOS_LLM_API_KEY, 'router-api-secret');
    assert.equal(runtime.ZENOS_LLM_BASE_URL, 'http://127.0.0.1:20128/model');
    assert.equal(runtime.ZENOS_MEMORY_URL, 'http://127.0.0.1:3091');

    for (const forbidden of ['TELEGRAM_BOT_TOKEN', 'PRIVATE_KEY', 'MNEMONIC', 'X_PASSWORD']) {
      assert.equal(runtime[forbidden], undefined, `${forbidden} leaked into Runtime credentials`);
      assert.ok(hermes[forbidden], `${forbidden} must remain available to Hermes`);
    }
    assert.equal(hermes.HERMES_CONFIG_PROVIDERS_ETLA_ROUTER_API_KEY, 'router-api-secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Hermes gateway consumes only its dedicated credential bundle', () => {
  const unit = readFileSync('hermes-gateway-zenos.service', 'utf8');
  const launcher = readFileSync('scripts/run-hermes-gateway-with-credential.py', 'utf8');
  assert.match(unit, /LoadCredentialEncrypted=hermes-zenos\.env:/);
  assert.match(unit, /HERMES_CREDENTIAL_NAME=hermes-zenos\.env/);
  assert.match(unit, /run-hermes-gateway-with-credential\.py/);
  assert.match(launcher, /HERMES_CREDENTIAL_NAME/);
  assert.doesNotMatch(unit, /LoadCredentialEncrypted=zenos-runtime\.env:/);
});

test('Runtime deployment activates the release only after preparation completes', () => {
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  const releaseCreated = installer.indexOf('mv "${STAGING}" "${RELEASE_ROOT}"');
  const credentialPrepared = installer.indexOf('prepare-runtime-service-files.py');
  const unitInstalled = installer.indexOf('hermes-gateway.service');
  const releaseActivated = installer.indexOf('ln -sfn "${RELEASE_ROOT}" /opt/zenos-runtime/current');
  const serviceRestarted = installer.indexOf('systemctl restart zenos-runtime.service', releaseActivated);

  assert.ok(releaseCreated >= 0);
  assert.ok(credentialPrepared > releaseCreated);
  assert.ok(unitInstalled > credentialPrepared);
  assert.ok(releaseActivated > unitInstalled);
  assert.ok(serviceRestarted > releaseActivated);
});
