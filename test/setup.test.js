import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveProfile, readProfile, launchCommand, registerClient, startInstalledService } from '../src/setup.js';
import { Store } from '../src/store.js';

test('first-run setup persists the name, preserves device keys, and uses upgrade-stable MCP paths', t => {
  const home = mkdtempSync(join(tmpdir(), 'ap-setup-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = saveProfile(home, { name: ' Erik ' });
  assert.deepEqual(readProfile(home), { name: 'Erik' });
  assert.equal(statSync(join(home, 'profile.json')).mode & 0o777, 0o600);
  let store = new Store(home, profile.name); const identity = store.identity.public.id; store.close();
  store = new Store(home); assert.equal(store.identity.public.name, 'Erik'); store.close();
  store = new Store(home, 'David'); assert.equal(store.identity.public.id, identity); assert.equal(store.identity.public.name, 'David'); store.close();
  const launch = launchCommand(home, '/old-cellar/src/cli.js', { AGENT_POST_EXECUTABLE: '/opt/homebrew/opt/agent-post/bin/agent-post' });
  assert.equal(launch.command, '/opt/homebrew/opt/agent-post/bin/agent-post'); assert.deepEqual(launch.args, ['mcp']);
});
test('Codex registration is idempotent, passes literal arguments and refuses to overwrite another configuration', () => {
  const launch = { command: '/path with spaces/agent-post', args: ['mcp'], env: { AGENT_POST_HOME: '/profiles/user $(literal)' } };
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (args[1] === 'get') { const error = new Error('not found'); error.stderr = 'No MCP server named agent-post found'; throw error; }
    return '';
  };
  assert.equal(registerClient('codex', launch, { run }).state, 'configured');
  assert.deepEqual(calls[1], { command: 'codex', args: ['mcp', 'add', 'agent-post', '--env', 'AGENT_POST_HOME=/profiles/user $(literal)', '--', '/path with spaces/agent-post', 'mcp'] });
  assert.equal(registerClient('codex', launch, { run: () => JSON.stringify({ transport: launch }) }).state, 'already configured');
  assert.throws(() => registerClient('codex', launch, { run: () => JSON.stringify({ transport: { command: 'another-command' } }) }), /left unchanged/);
  assert.throws(() => registerClient('codex', launch, { run: () => { throw new Error('configuration parse failed'); } }), /left unchanged/);
});
test('Claude registration uses user scope and preserves an existing conflicting entry', t => {
  const home = mkdtempSync(join(tmpdir(), 'ap-claude-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'claude.json'); const launch = { command: '/app/agent-post', args: ['mcp'], env: { AGENT_POST_HOME: home } };
  const calls = [];
  registerClient('claude', launch, { claudeSettings: file, run: (command, args) => { calls.push({ command, args }); } });
  assert.deepEqual(calls[0].args.slice(0, 7), ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'agent-post']);
  writeFileSync(file, JSON.stringify({ mcpServers: { 'agent-post': { command: 'other' } }, unrelated: true }));
  const previous = readFileSync(file, 'utf8');
  assert.throws(() => registerClient('claude', launch, { claudeSettings: file, run: () => assert.fail('must not run') }), /left unchanged/);
  assert.equal(readFileSync(file, 'utf8'), previous);
});
test('setup starts a scoped Homebrew service; source checkouts can configure without changing any host settings', async t => {
  const calls = [];
  assert.equal((await startInstalledService('/unused', { formula: 'owner/tap/agent-post', wait: false, run: (command, args) => calls.push({ command, args }) })).state, 'start requested');
  assert.deepEqual(calls, [{ command: 'brew', args: ['services', 'start', 'owner/tap/agent-post'] }]);
  await assert.rejects(() => startInstalledService('/unused'), /not installed/);
  const home = mkdtempSync(join(tmpdir(), 'ap-cli-setup-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [resolve('src/cli.js'), 'setup', '--name', 'David', '--client', 'manual', '--no-service', '--home', home], { encoding: 'utf8' });
  const result = JSON.parse(output); assert.equal(result.name, 'David'); assert.equal(result.state, 'not started');
  assert.deepEqual(result.agent.config.mcpServers['agent-post'].env, { AGENT_POST_HOME: home });
});
