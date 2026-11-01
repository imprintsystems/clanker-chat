import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { parse as yaml } from 'yaml';
import { discoverClients, applyClientSelection, configureClient } from '../src/clients.js';
import { readAccess, authorizeClient } from '../src/access.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const systemHome = join(root, 'user'); const home = join(root, 'clanker'); mkdirSync(systemHome, { recursive: true });
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['hermes', 'codex', 'claude', 'omp', 'opencode']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const clients = discoverClients({ systemHome, platform: 'darwin', env: { PATH: bin } });
  const launch = { command: '/opt/homebrew/opt/clanker/bin/clanker', args: ['mcp'], env: { CLANKER_HOME: home } };
  const save = (client, body) => { mkdirSync(dirname(client.file), { recursive: true }); writeFileSync(client.file, body); };
  return { root, home, systemHome, bin, clients, launch, save };
}
test('discovery finds executable clients and named OMP profiles without running commands', t => {
  const { clients, systemHome, bin } = fixture(t);
  for (const id of ['hermes', 'codex', 'claude', 'omp', 'opencode']) assert.equal(clients.find(c => c.id === id).detected, true);
  const profile = discoverClients({ systemHome, env: { PATH: bin, OMP_PROFILE: 'work' } }).find(c => c.id === 'omp');
  assert.equal(profile.file, join(systemHome, '.omp/profiles/work/agent/mcp.json'));
  assert.throws(() => discoverClients({ systemHome, env: { OMP_PROFILE: '../other' } }), /profile name/);
});
test('discovery follows active Claude and OMP config directories and the Linux Desktop root', t => {
  const { root, systemHome, home, launch } = fixture(t);
  const claudeHome = join(root, 'claude-custom'); const ompHome = join(root, 'omp-custom');
  const configHome = join(root, 'xdg');
  for (const path of [claudeHome, ompHome, join(configHome, 'Claude')]) mkdirSync(path, { recursive: true });
  const env = { PATH: '', CLAUDE_CONFIG_DIR: claudeHome, PI_CODING_AGENT_DIR: ompHome, XDG_CONFIG_HOME: configHome };
  const clients = discoverClients({ systemHome, platform: 'linux', env });
  const claude = clients.find(c => c.id === 'claude'); const omp = clients.find(c => c.id === 'omp');
  const desktop = clients.find(c => c.id === 'claude-desktop');
  for (const client of [claude, omp, desktop]) assert.equal(client.detected, true, client.id);
  assert.equal(desktop.file, join(configHome, 'Claude/claude_desktop_config.json'));
  assert.equal(applyClientSelection(home, ['claude', 'omp'], launch, [claude, omp]).every(row => row.state === 'connected'), true);
  assert.equal(JSON.parse(readFileSync(join(claudeHome, '.claude.json'), 'utf8')).mcpServers.clanker.env.CLANKER_CLIENT_ID, 'claude');
  assert.equal(JSON.parse(readFileSync(join(ompHome, 'mcp.json'), 'utf8')).mcpServers.clanker.env.CLANKER_CLIENT_ID, 'omp');
  assert.equal(existsSync(join(systemHome, '.claude.json')), false);
  assert.equal(existsSync(join(systemHome, '.omp/agent/mcp.json')), false);
  const customRoot = { ...env, PI_CONFIG_DIR: '.custom-omp' };
  assert.equal(discoverClients({ systemHome, env: { ...customRoot, PI_CODING_AGENT_DIR: '' } }).find(c => c.id === 'omp').file, join(systemHome, '.custom-omp/agent/mcp.json'));
  assert.equal(discoverClients({ systemHome, env: { ...customRoot, OMP_PROFILE: 'work' } }).find(c => c.id === 'omp').file, join(systemHome, '.custom-omp/profiles/work/agent/mcp.json'));
});
test('Hermes setup targets the sticky active profile and respects an explicit profile home', t => {
  const { systemHome, home, launch } = fixture(t);
  const root = join(systemHome, '.hermes'); const profileHome = join(root, 'profiles/work');
  mkdirSync(profileHome, { recursive: true }); writeFileSync(join(root, 'active_profile'), 'work\n');
  const env = { PATH: '' };
  const hermes = discoverClients({ systemHome, env }).find(c => c.id === 'hermes');
  assert.equal(hermes.label, 'Hermes (work)'); assert.equal(hermes.detected, true);
  assert.equal(applyClientSelection(home, ['hermes'], launch, [hermes])[0].state, 'connected');
  assert.equal(yaml(readFileSync(join(profileHome, 'config.yaml'), 'utf8')).mcp_servers.clanker.env.CLANKER_CLIENT_ID, 'hermes');
  assert.equal(existsSync(join(root, 'config.yaml')), false);
  assert.equal(discoverClients({ systemHome, env: { ...env, HERMES_HOME: root } }).find(c => c.id === 'hermes').file, join(profileHome, 'config.yaml'));
  const otherHome = join(root, 'profiles/other'); mkdirSync(otherHome);
  assert.equal(discoverClients({ systemHome, env: { ...env, HERMES_HOME: otherHome } }).find(c => c.id === 'hermes').file, join(otherHome, 'config.yaml'));
  writeFileSync(join(root, 'active_profile'), '../other\n');
  assert.throws(() => discoverClients({ systemHome, env }), /Hermes profile/);
});
test('Hermes YAML comments, models and other MCP servers survive connection, update and disconnection', t => {
  const { home, clients, launch, save } = fixture(t); const hermes = clients.find(c => c.id === 'hermes');
  const original = '# My provider\nmodel: hermes-model\nmcp_servers:\n  existing:\n    command: tool\n'; save(hermes, original);
  let result = applyClientSelection(home, ['hermes'], launch, [hermes]); assert.equal(result[0].state, 'connected');
  const first = yaml(readFileSync(hermes.file, 'utf8')); const token = first.mcp_servers.clanker.env.CLANKER_CLIENT_TOKEN;
  assert.equal(first.model, 'hermes-model'); assert.equal(first.mcp_servers.existing.command, 'tool'); assert.match(readFileSync(hermes.file, 'utf8'), /# My provider/);
  assert.ok(first.plugins.enabled.includes('clanker-chat'));assert.deepEqual(first.plugins.entries['clanker-chat'].mcp_allowlist,['clanker']);assert.equal(first.plugins.entries['clanker-chat'].allow_gateway_injection,true);
  assert.equal(statSync(hermes.file).mode & 0o777, 0o600); assert.equal(statSync(join(home, 'clients.json')).mode & 0o777, 0o600);
  applyClientSelection(home, ['hermes'], launch, [hermes]); assert.equal(yaml(readFileSync(hermes.file, 'utf8')).mcp_servers.clanker.env.CLANKER_CLIENT_TOKEN, token);
  authorizeClient(home, 'hermes', token);
  result = applyClientSelection(home, [], launch, [hermes]); assert.equal(result[0].state, 'disconnected');
  assert.throws(() => authorizeClient(home, 'hermes', token), /not connected/);
  const final = yaml(readFileSync(hermes.file, 'utf8')); assert.equal(final.mcp_servers.clanker, undefined); assert.equal(final.model, 'hermes-model');
  assert.ok(existsSync(join(home, 'backups/hermes')));
});
test('OMP, Claude, Cursor and VS Code JSON preserve comments and unrelated entries; OpenCode gets native format', t => {
  const { home, clients, launch, save } = fixture(t);
  for (const id of ['omp', 'claude', 'claude-desktop', 'cursor', 'vscode', 'opencode']) {
    const client = clients.find(c => c.id === id);
    const body = `{\n  // keep this comment\n  "unrelated": {"value": 42},\n  "${client.key}": {"other": {"command": "tool"}},\n  "disabledServers": ["clanker", "other"]\n}\n`;
    save(client, body);
    const result = applyClientSelection(home, [id], launch, [client]); assert.equal(result[0].state, 'connected', id);
    const raw = readFileSync(client.file, 'utf8'); assert.match(raw, /keep this comment/); const config = parse(raw);
    assert.equal(config.unrelated.value, 42); assert.equal(config[client.key].other.command, 'tool');
    const entry = config[client.key].clanker;
    if (id === 'opencode') { assert.deepEqual(entry.command, [launch.command, 'mcp']); assert.equal(entry.environment.CLANKER_CLIENT_ID, id); }
    else assert.equal(entry.env.CLANKER_CLIENT_ID, id);
    if (['omp', 'cursor', 'vscode'].includes(id)) assert.equal(entry.type, 'stdio', id);
    if (id === 'omp') assert.deepEqual(config.disabledServers, ['other']);
  }
});
test('malformed settings and conflicting servers stay byte-for-byte unchanged', t => {
  const { home, clients, launch, save } = fixture(t);
  for (const id of ['hermes', 'omp']) {
    const client = clients.find(c => c.id === id); const body = id === 'hermes' ? 'model: [bad\n' : '{bad'; save(client, body);
    assert.equal(applyClientSelection(home, [id], launch, [client])[0].state, 'error'); assert.equal(readFileSync(client.file, 'utf8'), body);
    const conflict = id === 'hermes' ? 'mcp_servers:\n  clanker:\n    command: different\n' : '{"mcpServers":{"clanker":{"command":"different"}}}'; save(client, conflict);
    assert.equal(applyClientSelection(home, [id], launch, [client])[0].state, 'error'); assert.equal(readFileSync(client.file, 'utf8'), conflict);
  }
});
test('Codex uses its native CLI and keeps private connection credentials out of setup results', t => {
  const { home, clients, launch } = fixture(t); const codex = clients.find(c => c.id === 'codex'); const calls = [];
  const run = (command, args) => { calls.push({ command, args }); if (args[1] === 'get') { const err = new Error('No MCP server named clanker found'); throw err; } return ''; };
  const result = applyClientSelection(home, ['codex'], launch, [codex], { run });
  assert.equal(result[0].state, 'connected');
  const add = calls.find(call => call.args[1] === 'add'); assert.ok(add.args.includes('CLANKER_CLIENT_ID=codex'));
  const grant = readAccess(home).clients.codex; assert.ok(add.args.includes(`CLANKER_CLIENT_TOKEN=${grant.token}`));
  assert.equal(JSON.stringify(result).includes(grant.token), false);
});
test('unselected legacy app entries are removed during migration; a denied local MCP client cannot impersonate another', t => {
  const { home, clients, launch, save } = fixture(t); const claude = clients.find(c => c.id === 'claude');
  save(claude, JSON.stringify({ mcpServers: { clanker: launch, other: { command: 'tool' } } }));
  const result = applyClientSelection(home, [], launch, [claude]); assert.equal(result[0].state, 'disconnected');
  assert.equal(parse(readFileSync(claude.file, 'utf8')).mcpServers.clanker, undefined);
  assert.throws(() => authorizeClient(home, 'unknown', 'a'.repeat(64)), /not connected/);
});
