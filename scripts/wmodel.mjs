#!/usr/bin/env node

process.stderr.write([
  '/wmodel has been removed from Zenos Cognitive Runtime.',
  'Use Hermes /model to select the single session model.',
  'Native workers and explicitly requested review cycles inherit that Host model automatically.',
  '',
].join('\n'));
process.exitCode = 2;
