import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const modelCatalog = path.join(directory, 'models.json');

    writeFileSync(sourceConfig, [
      'model:',
      '  default: grok',
      '  provider: etla-router',
      'providers:',
      '  etla-router:',
      '    base_url: https://router.etla.me/v1',
      '    default_model: grok',
      '    api_key: ${HERMES_CONFIG_PROVIDERS_ETLA_ROUTER_API_KEY}',
      'telegram:',
      '  token: ${TELEGRAM_BOT_TOKEN}',
      'wallet:',
      '  private_key: ${PRIVATE_KEY}',
      '',
    ].join('\n'));
    writeFileSync(modelCatalog, JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek', object: 'model', owned_by: 'combo' },
        { id: 'dsw/deepseek-v4-pro', object: 'model', owned_by: 'dsw' },
        { id: 'grok', object: 'model', owned_by: 'combo' },
      ],
    }));
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
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        ZENOS_ROUTER_BASE_URL: 'http://127.0.0.1:20128/v1',
        ZENOS_ROUTER_MODELS_URL: pathToFileURL(modelCatalog).href,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const runtime = parseEnvironment(runtimeEnvironment);
    const hermes = parseEnvironment(hermesEnvironment);
    const preparedRuntimeConfig = readFileSync(runtimeConfig, 'utf8');
    const preparedHermesConfig = readFileSync(hermesConfig, 'utf8');

    assert.equal(runtime.ETLA_MASTER_SECRET, 'runtime-auth-secret');
    assert.equal(runtime.ZENOS_RUNTIME_API_KEY, 'runtime-api-secret');
    assert.equal(runtime.ZENOS_MEMORY_API_KEY, 'memory-api-secret');
    assert.equal(runtime.ZENOS_LLM_API_KEY, 'router-api-secret');
    assert.equal(runtime.ZENOS_LLM_BASE_URL, 'http://127.0.0.1:20128/v1');
    assert.equal(runtime.ZENOS_MEMORY_URL, 'https://zenos-memory.vercel.app');
    assert.ok(runtime.ZENOS_BACKUP_ENCRYPTION_KEY?.length >= 48);
    assert.equal(hermes.ZENOS_MEMORY_URL, 'https://zenos-memory.vercel.app');

    for (const forbidden of ['TELEGRAM_BOT_TOKEN', 'PRIVATE_KEY', 'MNEMONIC', 'X_PASSWORD']) {
      assert.equal(runtime[forbidden], undefined, `${forbidden} leaked into Runtime credentials`);
      assert.ok(hermes[forbidden], `${forbidden} must remain available to Hermes`);
    }
    assert.equal(hermes.HERMES_CONFIG_PROVIDERS_ETLA_ROUTER_API_KEY, 'router-api-secret');
    assert.match(preparedRuntimeConfig, /base_url: http:\/\/127\.0\.0\.1:20128\/v1/);
    assert.match(preparedHermesConfig, /base_url: http:\/\/127\.0\.0\.1:20128\/v1/);
    assert.match(preparedHermesConfig, /discover_models: true/);
    assert.match(preparedHermesConfig, /\n\s+deepseek:\n/);
    assert.match(preparedHermesConfig, /\n\s+dsw\/deepseek-v4-pro:\n/);
    assert.doesNotMatch(preparedHermesConfig, /ag\/claude-opus-4-6-thinking/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Hermes gateway consumes only its dedicated credential bundle', () => {
  const unit = readFileSync('hermes-gateway-zenos.service', 'utf8');
  const launcher = readFileSync('scripts/run-hermes-gateway-with-credential.py', 'utf8');
  assert.match(unit, /LoadCredentialEncrypted=hermes-zenos\.env:/);
  assert.match(unit, /HERMES_CREDENTIAL_NAME=hermes-zenos\.env/);
  assert.match(unit, /\/usr\/local\/sbin\/run-hermes-gateway-with-credential/);
  assert.match(launcher, /HERMES_CREDENTIAL_NAME/);
  assert.doesNotMatch(unit, /LoadCredentialEncrypted=zenos-runtime\.env:/);
});

test('Hermes gateway runs non-root and delegates only narrow privileged operations', () => {
  const unit = readFileSync('hermes-gateway-zenos.service', 'utf8');
  const broker = readFileSync('scripts/etla-ops-broker.py', 'utf8');
  assert.match(unit, /^User=hermes$/m);
  assert.match(unit, /^Group=hermes$/m);
  assert.match(unit, /^SupplementaryGroups=etla-ops$/m);
  assert.match(unit, /^Environment=USER=hermes$/m);
  assert.match(unit, /^Environment=LOGNAME=hermes$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^ProtectProc=invisible$/m);
  assert.match(unit, /^ProcSubset=all$/m);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/hermes \/srv\/etla\/workspaces/);
  assert.match(broker, /ALLOWED_UNITS/);
  assert.doesNotMatch(broker, /shell=True|os\.system\(|subprocess\.(?:call|run)\([^\n]*shell/);
});

test('privileged broker keeps cloud deployment outside its AF_UNIX-only sandbox', () => {
  const broker = readFileSync('scripts/etla-ops-broker.py', 'utf8');
  const unit = readFileSync('etla-ops-broker.service', 'utf8');
  assert.match(unit, /^Group=etla-ops$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0750$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(broker, /OPS_GROUP = "etla-ops"/);
  assert.match(broker, /for name in \("hermes", "zenos-runtime"\)/);
  assert.match(broker, /"rh-copybot\.service"/);
  assert.match(broker, /os\.chown\(SOCKET_PATH\.parent, 0, group\.gr_gid\)/);
  assert.match(broker, /os\.chmod\(SOCKET_PATH\.parent, 0o750\)/);
  assert.match(broker, /os\.chmod\(SOCKET_PATH, 0o660\)/);
  assert.match(broker, /\/usr\/bin\/systemd-run/);
  assert.match(broker, /--wait/);
  assert.match(broker, /--collect/);
  assert.match(broker, /ZENOS_DEPLOY_RESTART_BROKER=false/);
  assert.doesNotMatch(broker, /"zenos-memory\.service"/);
});

test('Hermes runtime path migration rewrites only active cron metadata and scripts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zenos-hermes-path-migration-'));
  try {
    const cronDirectory = path.join(directory, 'cron');
    const scriptsDirectory = path.join(directory, 'scripts');
    mkdirSync(cronDirectory, { recursive: true });
    mkdirSync(scriptsDirectory, { recursive: true });
    const jobsPath = path.join(cronDirectory, 'jobs.json');
    const scriptPath = path.join(scriptsDirectory, 'batang_hunt.sh');
    writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: 'job-1',
        workdir: '/root/openclaw-projects/karir-vpn',
        prompt: 'Use /root/.hermes/scripts/batang_hunt.sh from /root/openclaw-projects/karir-vpn.',
        last_error: "Historical failure at /root/openclaw-projects/karir-vpn",
      }],
    }));
    writeFileSync(scriptPath, '#!/bin/sh\nexec /root/openclaw-projects/karir-vpn/run_hunt.sh\n');

    const first = spawnSync('python3', ['scripts/migrate-hermes-runtime-paths.py', directory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout) as { changedFileCount: number; replacementCount: number };
    assert.equal(firstResult.changedFileCount, 2);
    assert.ok(firstResult.replacementCount >= 3);
    const jobs = readFileSync(jobsPath, 'utf8');
    const script = readFileSync(scriptPath, 'utf8');
    assert.match(jobs, /\/srv\/etla\/workspaces\/karir-vpn/);
    assert.match(jobs, new RegExp(`${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/batang_hunt\\.sh`));
    assert.doesNotMatch(jobs, /"workdir": "\/root\/openclaw-projects|\/root\/\.hermes\/scripts/);
    assert.match(jobs, /Historical failure at \/root\/openclaw-projects\/karir-vpn/);
    assert.match(script, /\/srv\/etla\/workspaces\/karir-vpn\/run_hunt\.sh/);

    const second = spawnSync('python3', ['scripts/migrate-hermes-runtime-paths.py', directory], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    const secondResult = JSON.parse(second.stdout) as { changedFileCount: number };
    assert.equal(secondResult.changedFileCount, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Runtime deployment is idempotent before any gateway interruption', () => {
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  const activeReleaseGuard = installer.indexOf('Runtime release is already active:');
  const gatewayStop = installer.indexOf('systemctl stop hermes-gateway.service');
  assert.ok(activeReleaseGuard >= 0);
  assert.ok(gatewayStop > activeReleaseGuard);
  assert.match(installer, /if \[\[ "\$\{ZENOS_DEPLOY_RESTART_HERMES:-true\}" == "true" \]\]; then\n  systemctl stop hermes-gateway\.service/);
  assert.equal((installer.match(/systemctl stop hermes-gateway\.service/g) || []).length, 1);
});

test('Runtime stores mutable intelligence and checkpoints outside the read-only checkout', () => {
  const unit = readFileSync('zenos-runtime.service', 'utf8');
  assert.match(unit, /^SupplementaryGroups=etla-ops$/m);
  assert.match(unit, /^Environment=ZENOS_RUNTIME_REPOSITORY_INDEX_DIR=\/var\/cache\/zenos-runtime\/repository-index$/m);
  assert.match(unit, /^Environment=ZENOS_RUNTIME_CODING_CHECKPOINT_DIR=\/var\/lib\/zenos-runtime\/coding-checkpoints$/m);
  assert.match(unit, /^ReadOnlyPaths=.*\/srv\/etla\/workspaces$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/zenos-runtime \/var\/cache\/zenos-runtime$/m);
});

test('Runtime deployment retries transient backup gates before rollback', () => {
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  assert.match(installer, /start_oneshot_with_retry\(\)/);
  assert.match(installer, /start_oneshot_with_retry zenos-runtime-backup\.service 6 30/);
  assert.match(installer, /start_oneshot_with_retry zenos-memory-secondary-backup\.service 3 10/);
  assert.match(installer, /systemctl reset-failed "\$\{unit\}"/);
  assert.match(installer, /if systemctl start "\$\{unit\}"; then/);
});

test('Runtime deployment activates the release only after preparation completes', () => {
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  const releaseCreated = installer.indexOf('mv "${STAGING}" "${RELEASE_ROOT}"');
  const credentialPrepared = installer.indexOf('prepare-runtime-service-files.py');
  const unitInstalled = installer.indexOf('/etc/systemd/system/hermes-gateway.service');
  const releaseActivated = installer.indexOf('ln -sfn "${RELEASE_ROOT}" /opt/zenos-runtime/current');
  const serviceRestarted = installer.indexOf('systemctl restart zenos-runtime.service', releaseActivated);

  assert.ok(releaseCreated >= 0);
  assert.ok(credentialPrepared > releaseCreated);
  assert.ok(unitInstalled > credentialPrepared);
  assert.ok(releaseActivated > unitInstalled);
  assert.ok(serviceRestarted > releaseActivated);
});
