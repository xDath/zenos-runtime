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
      'credential_pool_strategies:',
      '  freemodel:',
      '    keys:',
      '      - pool-key-one',
      '      - pool-key-two',
      '    strategy: failover',
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
    const preparedRuntimeModels = JSON.parse(readFileSync(modelOutput, 'utf8')) as Record<string, string>;
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
    assert.equal(hermes.HERMES_CONFIG_CREDENTIAL_POOL_STRATEGIES_FREEMODEL_KEYS_0, 'pool-key-one');
    assert.equal(hermes.HERMES_CONFIG_CREDENTIAL_POOL_STRATEGIES_FREEMODEL_KEYS_1, 'pool-key-two');
    assert.match(preparedHermesConfig, /\$\{HERMES_CONFIG_CREDENTIAL_POOL_STRATEGIES_FREEMODEL_KEYS_0\}/);
    assert.match(preparedHermesConfig, /\$\{HERMES_CONFIG_CREDENTIAL_POOL_STRATEGIES_FREEMODEL_KEYS_1\}/);
    assert.doesNotMatch(preparedHermesConfig, /pool-key-one|pool-key-two/);
    assert.match(preparedRuntimeConfig, /base_url: http:\/\/127\.0\.0\.1:20128\/v1/);
    assert.equal(preparedRuntimeModels.verifierModel, 'verifier-grok43-deepseek');
    assert.equal(preparedRuntimeModels.verifierProvider, 'etla-router');
    assert.match(preparedHermesConfig, /base_url: http:\/\/127\.0\.0\.1:20128\/v1/);
    assert.match(preparedHermesConfig, /cwd: \/root\/openclaw-projects/);
    assert.match(preparedHermesConfig, /mode: ['"]?off['"]?/);
    assert.match(preparedHermesConfig, /cron_mode: approve/);
    assert.match(preparedHermesConfig, /hooks_auto_accept: true/);
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

test('Hermes gateway remains root-authoritative across Runtime deployments', () => {
  const unit = readFileSync('hermes-gateway-zenos.service', 'utf8');
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  assert.match(unit, /^User=root$/m);
  assert.match(unit, /^Group=root$/m);
  assert.match(unit, /^Environment=HOME=\/root$/m);
  assert.match(unit, /^Environment=USER=root$/m);
  assert.match(unit, /^Environment=LOGNAME=root$/m);
  assert.match(unit, /^NoNewPrivileges=false$/m);
  assert.match(unit, /^ProtectHome=false$/m);
  assert.match(unit, /^ProtectSystem=off$/m);
  assert.match(unit, /^PrivateDevices=false$/m);
  assert.match(unit, /^ProtectKernelModules=false$/m);
  assert.match(unit, /^ProtectControlGroups=false$/m);
  assert.match(unit, /^RestrictNamespaces=false$/m);
  assert.doesNotMatch(unit, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(unit, /^ReadOnlyPaths=/m);
  assert.doesNotMatch(unit, /^ReadWritePaths=/m);
  assert.match(installer, /^HERMES_SERVICE_USER="root"$/m);
  assert.match(installer, /^HERMES_SERVICE_GROUP="root"$/m);
  assert.match(installer, /^HERMES_SERVICE_HOME="\/root"$/m);
  assert.match(installer, /assert_hermes_root_authority\(\)/);
  assert.match(installer, /awk '\/\^Uid:\/ \{print \$2\}' "\/proc\/\$\{hermes_pid\}\/status"/);
  assert.match(installer, /nsenter -t "\$\{hermes_pid\}" -m -- test -w \/root/);
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

test('Hermes runtime path migration rewrites active operations and instructions but preserves history', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zenos-hermes-path-migration-'));
  try {
    const cronDirectory = path.join(directory, 'cron');
    const scriptsDirectory = path.join(directory, 'scripts');
    const skillsDirectory = path.join(directory, 'skills', 'runtime-help');
    const memoriesDirectory = path.join(directory, 'memories');
    mkdirSync(cronDirectory, { recursive: true });
    mkdirSync(scriptsDirectory, { recursive: true });
    mkdirSync(skillsDirectory, { recursive: true });
    mkdirSync(memoriesDirectory, { recursive: true });
    const jobsPath = path.join(cronDirectory, 'jobs.json');
    const scriptPath = path.join(scriptsDirectory, 'batang_hunt.sh');
    const agentsPath = path.join(directory, 'AGENTS.md');
    const memoryPath = path.join(directory, 'MEMORY.md');
    const skillPath = path.join(skillsDirectory, 'SKILL.md');
    const historicalPath = path.join(memoriesDirectory, '2026-07-01.md');
    writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: 'job-1',
        workdir: '/root/openclaw-projects/karir-vpn',
        prompt: 'Use /root/.hermes/scripts/batang_hunt.sh from /root/openclaw-projects/karir-vpn.',
        last_error: "Historical failure at /root/openclaw-projects/karir-vpn",
      }],
    }));
    writeFileSync(scriptPath, '#!/bin/sh\nexec /root/openclaw-projects/karir-vpn/run_hunt.sh\n');
    writeFileSync(agentsPath, [
      'Use `/root/openclaw-projects` as the only project root.',
      'Treat `/root/openclaw-projects` as a historical alias that is inaccessible inside the hardened Hermes service. Never send that legacy path to tools.',
      'Use that explicit path for live Hermes profile files; `/var/lib/hermes/.hermes/profiles/zenos` is only a compatibility symlink.',
    ].join('\n'));
    writeFileSync(memoryPath, 'Canonical repo: /root/openclaw-projects/zenos-runtime\n');
    writeFileSync(skillPath, 'Use /root/openclaw-projects/zenos-memory for active work.\n');
    writeFileSync(historicalPath, 'Historical evidence at /root/openclaw-projects/old-repo\n');

    const first = spawnSync('python3', ['scripts/migrate-hermes-runtime-paths.py', directory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout) as { changedFileCount: number; replacementCount: number };
    assert.equal(firstResult.changedFileCount, 2);
    assert.ok(firstResult.replacementCount >= 3);
    const jobs = readFileSync(jobsPath, 'utf8');
    const script = readFileSync(scriptPath, 'utf8');
    const agents = readFileSync(agentsPath, 'utf8');
    const memory = readFileSync(memoryPath, 'utf8');
    const skill = readFileSync(skillPath, 'utf8');
    const historical = readFileSync(historicalPath, 'utf8');
    assert.match(jobs, /"workdir": "\/root\/openclaw-projects\/karir-vpn"/);
    assert.match(jobs, new RegExp(`${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/batang_hunt\\.sh`));
    assert.doesNotMatch(jobs, /\/root\/\.hermes\/scripts/);
    assert.match(jobs, /Historical failure at \/root\/openclaw-projects\/karir-vpn/);
    assert.match(script, /\/root\/openclaw-projects\/karir-vpn\/run_hunt\.sh/);
    assert.match(agents, /Use `\/root\/openclaw-projects` as the only project root/);
    assert.match(agents, /Hermes gateway runs as root and may read or write `\/root`/);
    assert.doesNotMatch(agents, /inaccessible inside the hardened Hermes service/);
    assert.match(agents, /`\$HOME\/\.hermes\/profiles\/zenos` is only a compatibility symlink/);
    assert.match(memory, /\/root\/openclaw-projects\/zenos-runtime/);
    assert.match(skill, /\/root\/openclaw-projects\/zenos-memory/);
    assert.match(historical, /\/root\/openclaw-projects\/old-repo/);

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

test('Runtime deployment never overwrites authoritative live 9Router state with stale checkout data', () => {
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  assert.match(installer, /if \[\[ ! -s \/var\/lib\/9router\/db\/data\.sqlite && -d \/opt\/9router\/data \]\]; then/);
  assert.equal((installer.match(/rsync -a \/opt\/9router\/data\/ \/var\/lib\/9router\//g) || []).length, 1);
  assert.ok(installer.indexOf('! -s /var/lib/9router/db/data.sqlite') < installer.indexOf('rsync -a /opt/9router/data/ /var/lib/9router/'));
});

test('Runtime stores mutable intelligence and checkpoints outside the read-only checkout', () => {
  const unit = readFileSync('zenos-runtime.service', 'utf8');
  assert.match(unit, /^SupplementaryGroups=etla-ops$/m);
  assert.match(unit, /^Environment=ZENOS_RUNTIME_REPOSITORY_INDEX_DIR=\/var\/cache\/zenos-runtime\/repository-index$/m);
  assert.match(unit, /^Environment=ZENOS_RUNTIME_CODING_CHECKPOINT_DIR=\/var\/lib\/zenos-runtime\/coding-checkpoints$/m);
  assert.match(unit, /^Environment=ZENOS_RUNTIME_CONFIG_PATH=\/var\/lib\/zenos-runtime\/models\.json$/m);
  assert.match(unit, /^Environment=ZENOS_ORCHESTRATION_MODE=host-led$/m);
  assert.match(unit, /^Environment=ZENOS_COGNITIVE_MAX_CONTINUATIONS=6$/m);
  assert.match(unit, /^Environment=ZENOS_COGNITIVE_COMPACT_AT_TOKENS=140000$/m);
  assert.match(unit, /^Environment=ZENOS_HOST_CONTEXT_SOFT_LIMIT_TOKENS=140000$/m);
  assert.doesNotMatch(unit, /^Environment=ZENOS_(?:WORKER|VERIFIER|BOSS)_MODEL=/m);
  assert.match(unit, /^ReadOnlyPaths=.*\/srv\/etla\/workspaces$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/zenos-runtime \/var\/cache\/zenos-runtime$/m);
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');
  assert.match(installer, /RUNTIME_MODELS_SOURCE=\/var\/lib\/zenos-runtime\/models\.json/);
  assert.match(installer, /"\$\{SANITIZED_MODELS_TMP\}" \/var\/lib\/zenos-runtime\/models\.json/);
});

test('Runtime operational clients can consume the encrypted credential directory', () => {
  for (const file of ['scripts/smoke-live-orchestration.mjs', 'scripts/zenos-runtime-local-client.mjs']) {
    const script = readFileSync(file, 'utf8');
    assert.match(script, /process\.env\.CREDENTIALS_DIRECTORY/);
    assert.match(script, /zenos-runtime\.env/);
    assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*(?:apiKey|secret)/);
  }
});

test('Memory prewarm uses scoped Runtime credentials and a recurring hardened timer', () => {
  const service = readFileSync('zenos-memory-prewarm.service', 'utf8');
  const timer = readFileSync('zenos-memory-prewarm.timer', 'utf8');
  const script = readFileSync('scripts/prewarm-zenos-memory.mjs', 'utf8');
  const runtimeUnit = readFileSync('zenos-runtime.service', 'utf8');
  const installer = readFileSync('scripts/install-control-plane-service.sh', 'utf8');

  assert.match(service, /^User=zenos-runtime$/m);
  assert.match(service, /^LoadCredentialEncrypted=zenos-runtime\.env:/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(script, /x-etla-requested-scopes': 'memory:read'/);
  assert.match(script, /\/api\/memory\/authenticated-status/);
  assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*(?:auth\.token|secret)/);
  assert.match(runtimeUnit, /^Environment=ZENOS_MEMORY_TIMEOUT_MS=20000$/m);
  assert.match(runtimeUnit, /^Environment=ZENOS_MEMORY_HEALTH_TIMEOUT_MS=25000$/m);
  assert.match(runtimeUnit, /^Environment=ZENOS_RUNTIME_AUTHORITATIVE_HOST=true$/m);
  assert.match(installer, /zenos-memory-prewarm\.timer/);
  assert.match(installer, /systemctl start zenos-memory-prewarm\.timer/);
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
