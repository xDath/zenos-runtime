#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const defaultConfigPath = fs.existsSync('/root/.hermes/profiles/zenos')
  ? '/root/.hermes/profiles/zenos/zenos-runtime.json'
  : path.join(os.homedir(), '.hermes/profiles/zenos/zenos-runtime.json');
const configPath = process.env.ZENOS_RUNTIME_CONFIG_PATH || defaultConfigPath;
const [, , command, ...args] = process.argv;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function printConfig(config) {
  console.log(JSON.stringify({
    configPath,
    baseUrl: config.baseUrl || '(hermes default)',
    hasApiKey: Boolean(config.apiKey),
    hostModel: config.hostModel || '(hermes default)',
    workerModel: config.workerModel || '(hermes default)',
    verifierModel: config.verifierModel || '(hermes default)',
  }, null, 2));
}

const aliases = {
  '/hmodel': 'hostModel',
  'hmodel': 'hostModel',
  '/wmodel': 'workerModel',
  'wmodel': 'workerModel',
  '/vmodel': 'verifierModel',
  'vmodel': 'verifierModel',
  '/runtime-base-url': 'baseUrl',
  'runtime-base-url': 'baseUrl',
  '/runtime-api-key': 'apiKey',
  'runtime-api-key': 'apiKey',
};

if (!command || command === 'show' || command === '/show') {
  printConfig(readConfig());
  process.exit(0);
}

const key = aliases[command];
if (!key) {
  console.error('Usage: npm run runtime:config -- show | /hmodel MODEL | /wmodel MODEL | /vmodel MODEL | /runtime-base-url URL | /runtime-api-key KEY');
  process.exit(2);
}

const value = args.join(' ').trim();
if (!value) {
  console.error(`Missing value for ${command}`);
  process.exit(2);
}

const config = readConfig();
config[key] = value;
writeConfig(config);
printConfig(config);
