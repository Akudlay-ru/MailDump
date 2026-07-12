'use strict';

const Module = require('module');
const path = require('path');

class CliError extends Error {
  constructor(code, message, exitCode = 2, details = null) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = Array.from(argv || []);
  if (args.shift() !== 'run') {
    throw new CliError('invalid_arguments', 'Expected command: run');
  }
  let selector = '';
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--preset' && args.length) {
      selector = args.shift();
      continue;
    }
    throw new CliError('invalid_arguments', `Unknown or incomplete argument: ${arg}`);
  }
  return { command: 'run', selector, json };
}

function loadHeadlessApi() {
  const originalLoad = Module._load;
  class Empty {}
  Module._load = function patchedLoad(request) {
    if (request === 'obsidian') {
      return {
        Plugin: Empty,
        PluginSettingTab: Empty,
        Setting: Empty,
        ItemView: Empty,
        Notice: Empty,
        setIcon() {}
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const mainPath = path.join(__dirname, 'main.js');
    delete require.cache[require.resolve(mainPath)];
    const PluginClass = require(mainPath);
    if (!PluginClass.headless?.run) {
      throw new CliError('headless_unavailable', 'MailDump headless API is unavailable');
    }
    return PluginClass.headless;
  } finally {
    Module._load = originalLoad;
  }
}

async function executeCli(argv, dependencies = {}) {
  let parsed = { json: true };
  try {
    parsed = parseArgs(argv);
    const api = (dependencies.loadHeadlessApi || loadHeadlessApi)();
    const basePath = dependencies.basePath || path.resolve(__dirname, '..', '..', '..');
    const payload = await api.run({
      basePath,
      selector: parsed.selector,
      source: 'cli',
      onProgress: dependencies.onProgress
    });
    return { exitCode: 0, payload, json: parsed.json };
  } catch (error) {
    const payload = {
      ok: false,
      code: error?.code || 'unexpected_error',
      message: String(error?.message || error),
      ...(error?.details ? { details: error.details } : {})
    };
    return { exitCode: Number(error?.exitCode || 4), payload, json: parsed.json };
  }
}

async function main() {
  const result = await executeCli(process.argv.slice(2), {
    onProgress: value => {
      if (value) process.stderr.write(`${value}\n`);
    }
  });
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  process.exitCode = result.exitCode;
}

if (require.main === module) main();

module.exports = { CliError, parseArgs, loadHeadlessApi, executeCli };
