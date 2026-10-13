import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticationVariableNames, refreshAuthenticationEnvironment } from './launch.mjs';

test('launcher reads only validated configured authentication names', () => {
  const names = authenticationVariableNames({ projects: [
    { opencodePasswordEnv: 'CUSTOM_PASSWORD', opencodeUsernameEnv: "bad';Write-Output SECRET" },
    { opencodePasswordEnv: 'CUSTOM_PASSWORD' }
  ] });
  assert.equal(names.filter(name => name === 'CUSTOM_PASSWORD').length, 1);
  assert.ok(names.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
});

test('Windows refresh preserves existing environment and bounds captured secret output', () => {
  const env = refreshAuthenticationEnvironment({ platform: 'win32', env: { HOME: 'unchanged', OPENCODE_SERVER_USERNAME: 'existing' }, run(command, args, options) {
    assert.equal(command, 'powershell.exe');
    assert.ok(!args.at(-1).includes("'OPENCODE_SERVER_USERNAME'"));
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.timeout, 10000);
    return { status: 0, stdout: JSON.stringify({ OPENCODE_SERVER_PASSWORD: 'private-value', HOME: 'injected' }) };
  } });
  assert.equal(env.HOME, 'unchanged');
  assert.equal(env.OPENCODE_SERVER_USERNAME, 'existing');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'private-value');
});

test('launcher failures never include captured credentials in error text', () => {
  for (const output of [{ status: 1, stderr: 'private-value' }, { status: 0, stdout: 'private-value' }]) {
    assert.throws(() => refreshAuthenticationEnvironment({ platform: 'win32', env: {}, run: () => output }), error => !error.message.includes('private-value'));
  }
});

test('non-Windows launcher leaves native environment alone', () => {
  assert.deepEqual(refreshAuthenticationEnvironment({ platform: 'linux', env: { KEEP: 'value' }, run() { throw new Error('unexpected shell'); } }), { KEEP: 'value' });
});
