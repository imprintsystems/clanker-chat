import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveProfile, readProfile, launchCommand, startInstalledService } from '../src/setup.js';
import { Store } from '../src/store.js';
import { runSetup, Cancelled } from '../src/onboarding.js';
import { readAccess, enableClient, clientGrant } from '../src/access.js';

test('first-run setup persists the name, preserves device keys, and uses upgrade-stable MCP paths', t => {
  const home = mkdtempSync(join(tmpdir(), 'ap-setup-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = saveProfile(home, { name: ' Erik ' });
  assert.deepEqual(readProfile(home), { name: 'Erik' });
  assert.equal(statSync(join(home, 'profile.json')).mode & 0o777, 0o600);
  let store = new Store(home, profile.name); const identity = store.identity.public.id; store.close();
  store = new Store(home); assert.equal(store.identity.public.name, 'Erik'); store.close();
  store = new Store(home, 'David'); assert.equal(store.identity.public.id, identity); assert.equal(store.identity.public.name, 'David'); store.close();
  const launch = launchCommand(home, '/old-cellar/src/cli.js', { CLANKER_EXECUTABLE: '/opt/homebrew/opt/clanker/bin/clanker' });
  assert.equal(launch.command, '/opt/homebrew/opt/clanker/bin/clanker'); assert.deepEqual(launch.args, ['mcp']);
});
test('cancelled setup and unattended setup without an explicit selection cannot change existing connections', async t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-cancel-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profile'); const user = join(home, 'user'); mkdirSync(user);
  const cancelled = Symbol('cancel');
  const p = { isCancel: value => value === cancelled, cancel() {}, text: async () => cancelled, intro() {} };
  await assert.rejects(runSetup({ home: profile, cli: '/cli.js', interactive: true, json: true, noService: true, p, discovery: { systemHome: user, env: { PATH: '' } } }), Cancelled);
  assert.equal(existsSync(profile), false);
  await assert.rejects(runSetup({ home: profile, cli: '/cli.js', name: 'Erik', interactive: false, noService: true, discovery: { systemHome: user, env: { PATH: '' } } }), /connections were left unchanged/);
  assert.equal(existsSync(profile), false);
  saveProfile(profile, { name: 'Existing' }); enableClient(profile, 'manual', clientGrant(profile, 'manual', 'Other MCP app'));
  const before = readFileSync(join(profile, 'clients.json'), 'utf8');
  const confirm = { ...p, confirm: async () => false, note() {}, log: { info() {} } };
  await assert.rejects(runSetup({ home: profile, cli: '/cli.js', name: 'Changed', selected: ['hermes'], interactive: true, noService: true, p: confirm, discovery: { systemHome: user, env: { PATH: '' } } }), Cancelled);
  assert.equal(readProfile(profile).name, 'Existing'); assert.equal(readFileSync(join(profile, 'clients.json'), 'utf8'), before);
});
test('setup connects a healthy app while reporting a malformed app without disclosing credentials', async t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-partial-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const user = join(home, 'user'); const profile = join(home, 'profile'); mkdirSync(join(user, '.hermes'), { recursive: true }); mkdirSync(join(user, '.omp/agent'), { recursive: true });
  const broken = join(user, '.omp/agent/mcp.json'); writeFileSync(broken, '{bad');
  const p = { isCancel: () => false, log: { info() {}, success() {}, error() {} }, outro() {} };
  const result = await runSetup({ home: profile, cli: '/cli.js', name: ' Erik ', selected: ['hermes', 'omp'], interactive: true, noService: true, agentsOnly: true, p, json: true, discovery: { systemHome: user, env: { PATH: '' } } });
  assert.equal(result.name, 'Erik'); assert.equal(result.failed, 1);
  const access = readAccess(profile); assert.equal(access.clients.hermes.enabled, true); assert.equal(access.clients.omp, undefined);
  assert.equal(JSON.stringify(result).includes(access.clients.hermes.token), false);
  assert.equal(readFileSync(broken, 'utf8'), '{bad');
});
test('setup starts a scoped Homebrew service; source checkouts can configure without changing any host settings', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ap-cli-setup-'))); t.after(() => rmSync(home, { recursive: true, force: true }));
  const brew = join(home, 'brew'); writeFileSync(brew, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const calls = [];
  assert.equal((await startInstalledService('/unused', { formula: 'owner/tap/clanker', wait: false, env: { PATH: home }, run: (command, args) => calls.push({ command, args }) })).state, 'start requested');
  assert.deepEqual(calls, [{ command: brew, args: ['services', 'start', 'owner/tap/clanker'] }]);
  await assert.rejects(() => startInstalledService('/unused'), /not installed/);
  const output = execFileSync(process.execPath, [resolve('src/cli.js'), 'setup', '--name', 'David', '--client', 'manual', '--no-service', '--home', home, '--json'], { encoding: 'utf8' });
  const result = JSON.parse(output); assert.equal(result.name, 'David'); assert.equal(result.state, 'not started');
  assert.equal(result.manual, true); assert.equal(result.failed, 0);
});
