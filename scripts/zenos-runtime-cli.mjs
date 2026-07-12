#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';

const defaultConfigPath = fs.existsSync('/root/.hermes/profiles/zenos')
  ? '/root/.hermes/profiles/zenos/zenos-runtime.json'
  : path.join(os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json');
const configPath = process.env.ZENOS_RUNTIME_CONFIG_PATH || defaultConfigPath;
const [, , rawCommand, ...args] = process.argv;
const command = rawCommand || 'show';
const roles = ['host', 'worker', 'verifier', 'boss'];
const builtIns = {
  baseUrl: '',
  provider: 'etla-router',
  hostModel: 'grok',
  workerModel: 'build',
  verifierModel: 'grok',
  bossModel: 'codex',
};

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, configPath);
  fs.chmodSync(configPath, 0o600);
}

function hasAnyKey(config) {
  return Boolean(
    config.apiKey
    || config.hostApiKey
    || config.workerApiKey
    || config.verifierApiKey
    || config.bossApiKey
    || process.env.ZENOS_LLM_API_KEY
    || process.env.MEMORY_LLM_API_KEY,
  );
}

function effective(config, role, suffix) {
  const dedicated = config[`${role}${suffix}`];
  if (dedicated) return dedicated;
  if (suffix === 'Model') return config[`${role}Model`] || builtIns[`${role}Model`];
  if (suffix === 'Provider') return config.hostProvider || builtIns.provider;
  if (suffix === 'BaseUrl') return config.baseUrl || process.env.ZENOS_LLM_BASE_URL || '(Hermes CLI transport)';
  return '';
}

function roleView(config, role) {
  return {
    model: effective(config, role, 'Model'),
    provider: effective(config, role, 'Provider'),
    baseUrl: effective(config, role, 'BaseUrl'),
    dedicatedApiKey: Boolean(config[`${role}ApiKey`]),
  };
}

function printConfig(config) {
  console.log(JSON.stringify({
    configPath,
    transport: hasAnyKey(config) ? 'http' : 'hermes-cli',
    sharedBaseUrl: config.baseUrl || process.env.ZENOS_LLM_BASE_URL || '(not set)',
    sharedProvider: config.hostProvider || builtIns.provider,
    hasApiKey: hasAnyKey(config),
    roles: Object.fromEntries(roles.map((role) => [role, roleView(config, role)])),
    precedence: ['built-in', 'environment', 'global config', 'session config', 'inline request override'],
  }, null, 2));
}

function parseFlags(values) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split('=', 2);
    const next = inline ?? (values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : 'true');
    flags[rawName] = next;
  }
  return { positional, flags };
}

function assertRole(role) {
  if (!roles.includes(role)) throw new Error(`Unknown role ${role}. Use: ${roles.join(', ')}`);
}

function setRole(config, role, model, flags = {}) {
  assertRole(role);
  if (!model) throw new Error(`Missing model for ${role}`);
  config[`${role}Model`] = model;
  if (flags.provider) config[`${role}Provider`] = flags.provider;
  if (flags['base-url']) config[`${role}BaseUrl`] = flags['base-url'];
  if (flags['api-key']) config[`${role}ApiKey`] = flags['api-key'];
  return config;
}

async function wizard() {
  const current = readConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, fallback) => {
    const answer = (await rl.question(`${label} [${fallback || 'leave empty'}]: `)).trim();
    return answer || fallback || '';
  };
  try {
    console.log('\nEtla Runtime model setup');
    console.log('Host = user-facing synthesis, Worker = coding/tool work, Verifier = independent quality gate, Boss = rare premium judgment.');
    console.log('API keys are not requested by this wizard. Keep using your existing Hermes/9Router credentials or set them separately.\n');
    const provider = await ask('Shared provider', current.hostProvider || builtIns.provider);
    const baseUrl = await ask('Shared OpenAI-compatible base URL', current.baseUrl || process.env.ZENOS_LLM_BASE_URL || '');
    const next = { ...current };
    if (provider) {
      next.hostProvider = provider;
      next.workerProvider = provider;
      next.verifierProvider = provider;
      next.bossProvider = provider;
    }
    if (baseUrl) next.baseUrl = baseUrl;
    for (const role of roles) {
      next[`${role}Model`] = await ask(`${role[0].toUpperCase()}${role.slice(1)} model`, current[`${role}Model`] || builtIns[`${role}Model`]);
    }
    writeConfig(next);
    console.log('\nSaved model configuration. Restart zenos-runtime.service only when changing service-level environment; file model changes are read on new runs.\n');
    printConfig(next);
  } finally {
    rl.close();
  }
}

function doctor(config) {
  const problems = [];
  for (const role of roles) {
    if (!effective(config, role, 'Model')) problems.push(`${role} model is missing`);
  }
  if (hasAnyKey(config) && !(config.baseUrl || process.env.ZENOS_LLM_BASE_URL || process.env.MEMORY_LLM_BASE_URL)) {
    problems.push('HTTP credentials exist but no shared/dedicated base URL is configured');
  }
  const stat = (() => {
    try { return fs.statSync(configPath); } catch { return undefined; }
  })();
  if (stat && (stat.mode & 0o077) !== 0) problems.push(`config permissions are too broad: 0${(stat.mode & 0o777).toString(8)}; run runtime:config -- secure`);
  console.log(JSON.stringify({
    ok: problems.length === 0,
    configPath,
    configExists: Boolean(stat),
    configMode: stat ? `0${(stat.mode & 0o777).toString(8)}` : null,
    transport: hasAnyKey(config) ? 'http' : 'hermes-cli',
    problems,
    nextCommands: [
      'npm run runtime:setup',
      'npm run runtime:config -- role worker build --provider etla-router',
      'npm run runtime:config -- show',
    ],
  }, null, 2));
  if (problems.length) process.exitCode = 1;
}

const aliases = {
  '/hmodel': 'hostModel', hmodel: 'hostModel',
  '/wmodel': 'workerModel', wmodel: 'workerModel',
  '/bmodel': 'bossModel', bmodel: 'bossModel',
  '/vmodel': 'verifierModel', vmodel: 'verifierModel',
  '/runtime-base-url': 'baseUrl', 'runtime-base-url': 'baseUrl',
  '/runtime-api-key': 'apiKey', 'runtime-api-key': 'apiKey',
};

try {
  if (command === 'show' || command === '/show') {
    printConfig(readConfig());
  } else if (command === 'wizard' || command === 'setup') {
    await wizard();
  } else if (command === 'doctor') {
    doctor(readConfig());
  } else if (command === 'secure') {
    if (!fs.existsSync(configPath)) throw new Error(`Config file does not exist: ${configPath}`);
    fs.chmodSync(configPath, 0o600);
    console.log(`Secured ${configPath} to mode 0600.`);
    doctor(readConfig());
  } else if (command === 'role') {
    const { positional, flags } = parseFlags(args);
    const [role, model] = positional;
    const config = setRole(readConfig(), role, model, flags);
    writeConfig(config);
    printConfig(config);
  } else if (command === 'clear-role') {
    const [role] = args;
    assertRole(role);
    const config = readConfig();
    for (const suffix of ['Model', 'Provider', 'BaseUrl', 'ApiKey']) delete config[`${role}${suffix}`];
    writeConfig(config);
    printConfig(config);
  } else if (aliases[command]) {
    const value = args.join(' ').trim();
    if (!value) throw new Error(`Missing value for ${command}`);
    const config = readConfig();
    config[aliases[command]] = value;
    writeConfig(config);
    printConfig(config);
  } else {
    console.error(`Usage:
  npm run runtime:setup
  npm run runtime:config -- show
  npm run runtime:config -- doctor
  npm run runtime:config -- secure
  npm run runtime:config -- role host MODEL [--provider PROVIDER] [--base-url URL]
  npm run runtime:config -- role worker MODEL
  npm run runtime:config -- role verifier MODEL
  npm run runtime:config -- role boss MODEL
  npm run runtime:config -- clear-role ROLE
  npm run runtime:config -- /hmodel MODEL | /wmodel MODEL | /vmodel MODEL | /bmodel MODEL`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
