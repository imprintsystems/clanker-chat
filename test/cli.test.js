import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { authorizeClient, readAccess } from '../src/access.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    HOME: home, XDG_CONFIG_HOME: join(home, 'config'), CLANKER_HOME: join(home, '.clanker'),
    CODEX_HOME: join(home, '.codex'), HERMES_HOME: join(home, '.hermes'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: dirname(process.execPath), TERM: 'xterm-256color', NO_COLOR: '1', CLANKER_NO_UPDATE_CHECK: '1'
  };
  const run = (args = [], overrides = {}) => spawnSync(process.execPath, [resolve('src/cli.js'), ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
  return { home, env, run };
}

test('root introduction and help never set up or modify an absent or existing profile', t => {
  const { home, env, run } = fixture(t);
  for (const args of [[], ['--help'], ['--json'], ['help'], ['setup', '--help'], ['agents', '--help']]) {
    const result = run(args, { CLANKER_BREW_FORMULA: 'test/tap/clanker' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(home), []);
  }
  mkdirSync(env.CLANKER_HOME);
  const profile = join(env.CLANKER_HOME, 'profile.json');
  writeFileSync(profile, '{"name":"Existing"}\n');
  const before = readFileSync(profile, 'utf8');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(profile, 'utf8'), before);
  assert.deepEqual(readdirSync(env.CLANKER_HOME), ['profile.json']);
});

test('unknown help fails without creating or changing a profile', t => {
  const { home, env, run } = fixture(t);
  assert.equal(run(['help', 'not-a-command']).status, 1);
  assert.deepEqual(readdirSync(home), []);
  mkdirSync(env.CLANKER_HOME);
  const profile = join(env.CLANKER_HOME, 'profile.json');
  writeFileSync(profile, '{"name":"Existing"}\n');
  const before = readFileSync(profile, 'utf8');
  assert.equal(run(['not-a-command', '--help']).status, 1);
  assert.equal(readFileSync(profile, 'utf8'), before);
  assert.deepEqual(readdirSync(env.CLANKER_HOME), ['profile.json']);
});

test('root and all help layouts fit narrow terminals with and without colour', t => {
  const { run } = fixture(t);
  for (const columns of [48, 60, 80, 100]) {
    for (const colour of [false, true]) {
      for (const args of [[], ['help', '--all'], ['bridge', '--help'], ['send', '--help'], ['setup', '--help']]) {
        const result = run(args, { COLUMNS: String(columns), NO_COLOR: colour ? undefined : '1', FORCE_COLOR: colour ? '3' : undefined, COLORTERM: 'truecolor' });
        assert.equal(result.status, 0, result.stderr);
        const text = stripVTControlCharacters(result.stdout);
        for (const row of text.split('\n')) assert.ok(row.length <= columns, `${columns} columns: ${row}`);
        if (!colour) assert.equal(result.stdout, text);
      }
    }
  }
});

test('explicit home rejects noninteractive input without changing configuration', t => {
  const { home, run } = fixture(t);
  const result = run(['home']);
  assert.equal(result.status, 1);
  assert.deepEqual(readdirSync(home), []);
});

test('explicit setup persists identity and deselecting the manual app revokes its credential', t => {
  const { env, run } = fixture(t);
  const setup = run(['setup', '--name', 'Synthetic', '--client', 'manual', '--no-service', '--json']);
  assert.equal(setup.status, 0, setup.stderr);
  const result = JSON.parse(setup.stdout);
  assert.equal(result.name, 'Synthetic');
  assert.equal(result.state, 'not started');
  assert.equal(result.manual, true);
  assert.equal(result.failed, 0);
  assert.equal(JSON.parse(readFileSync(join(env.CLANKER_HOME, 'profile.json'), 'utf8')).name, 'Synthetic');
  const config = run(['config']);
  assert.equal(config.status, 0, config.stderr);
  const credential = JSON.parse(config.stdout).mcpServers.clanker.env;
  authorizeClient(env.CLANKER_HOME, credential.CLANKER_CLIENT_ID, credential.CLANKER_CLIENT_TOKEN);
  const change = run(['agents', '--client', 'none', '--no-service', '--json']);
  assert.equal(change.status, 0, change.stderr);
  assert.equal(JSON.parse(change.stdout).manual, false);
  assert.equal(readAccess(env.CLANKER_HOME).clients.manual.enabled, false);
  assert.throws(() => authorizeClient(env.CLANKER_HOME, credential.CLANKER_CLIENT_ID, credential.CLANKER_CLIENT_TOKEN));
  const revokedConfig = run(['config']);
  assert.equal(revokedConfig.status, 1);
  assert.equal(revokedConfig.stdout, '');
});
