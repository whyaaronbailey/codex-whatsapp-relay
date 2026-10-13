import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = Object.freeze({
  mcp: 'plugins/whatsapp-relay/scripts/mcp-server.mjs',
  worker: 'plugins/whatsapp-relay/scripts/relay-worker.mjs',
  controller: 'plugins/whatsapp-relay/scripts/controller-daemon.mjs',
  auth: 'plugins/whatsapp-relay/scripts/whatsapp-auth.mjs',
  pair: 'scripts/pair-whatsapp.mjs',
  startup: 'scripts/start-controller.mjs'
});

export function authenticationVariableNames(config = {}) {
  const names = new Set(['OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD']);
  for (const project of Array.isArray(config.projects) ? config.projects : []) {
    for (const field of ['opencodeUsernameEnv', 'opencodePasswordEnv']) {
      const value = project[field];
      if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) names.add(value);
    }
  }
  return [...names];
}

export function refreshAuthenticationEnvironment({ config = {}, env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const result = { ...env };
  if (platform !== 'win32') return result;
  const missing = authenticationVariableNames(config).filter(name => !result[name]);
  if (!missing.length) return result;
  // Only validated identifiers enter the command. Credential values are read
  // from Windows privately; neither values nor all-environment dumps are logged.
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $relayValues=@{}; foreach($relayName in @(${missing.map(name => `'${name}'`).join(',')})) { $relayValue=[Environment]::GetEnvironmentVariable($relayName,'User'); if(-not $relayValue) { $relayValue=[Environment]::GetEnvironmentVariable($relayName,'Machine') }; if($relayValue) { $relayValues[$relayName]=$relayValue } }; ConvertTo-Json -InputObject $relayValues -Compress`;
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: result
  });
  if (output.error || output.status !== 0) throw new Error('Could not read the configured Windows authentication variables.');
  let values;
  try { values = JSON.parse(output.stdout.replace(/^\uFEFF/, '').trim()); }
  catch { throw new Error('Could not read the configured Windows authentication variables.'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid Windows authentication environment response.');
  for (const name of missing) if (typeof values[name] === 'string' && values[name]) result[name] = values[name];
  return result;
}

export function launch(mode, args = []) {
  if (!Object.hasOwn(entries, mode)) throw new Error('Usage: node scripts/launch.mjs mcp|worker|controller|auth|pair|startup [arguments]');
  let config = {};
  try { config = JSON.parse(readFileSync(new URL('../plugins/whatsapp-relay/data/controller-config.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read the relay controller configuration.'); }
  const env = refreshAuthenticationEnvironment({ config });
  // Direct native Node inheritance preserves MCP and worker JSON stdin/stdout.
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../${entries[mode]}`, import.meta.url)), ...args], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false
  });
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, listener] of listeners) process.on(signal, listener);
  const cleanup = () => { for (const [signal, listener] of listeners) process.off(signal, listener); };
  child.once('error', () => { cleanup(); process.stderr.write('Unable to start WhatsApp Relay.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { cleanup(); process.exitCode = code ?? (signal ? 1 : 0); });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { launch(process.argv[2], process.argv.slice(3)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
