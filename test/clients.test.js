import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { parse as yaml } from 'yaml';
import { discoverClients, applyClientSelection, configureClient, refreshClients } from '../src/clients.js';
import { readAccess, authorizeClient, clientGrant, enableClient } from '../src/access.js';
import { createHash } from 'node:crypto';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const systemHome = join(root, 'user'); const home = join(root, 'clanker'); mkdirSync(systemHome, { recursive: true });
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['hermes', 'codex', 'claude', 'omp', 'opencode']) writeFileSync(join(bin, name), name === 'opencode' ? '#!/bin/sh\necho "opencode v2.2.5"\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
test('Hermes refresh migrates count-only plugins with a private live credential and removes only managed files', t => {
  const { home, clients, launch } = fixture(t), client = clients.find(item => item.id === 'hermes');
  assert.equal(applyClientSelection(home, ['hermes'], launch, [client])[0].state, 'connected');
  const directory = join(dirname(client.file), 'plugins/clanker-chat');
  const connection = join(directory, 'connection.json'), source = join(directory, '__init__.py');
  const manifest = join(directory, 'plugin.yaml'), registry = join(home, 'integrations.json');
  const credential = yaml(readFileSync(client.file, 'utf8')).mcp_servers.clanker.env.CLANKER_CLIENT_TOKEN;
  const initial = readFileSync(source, 'utf8'), initialManifest = readFileSync(manifest, 'utf8');
  assert.deepEqual(JSON.parse(readFileSync(connection, 'utf8')), { home, id: 'hermes', token: credential });
  assert.equal(statSync(connection).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.ok(yaml(initialManifest).provides_hooks.includes('pre_llm_call'));
  // Simulate the registered previous release: no connection file or owner hook.
  const legacy = '# Managed by Clanker Chat.\ndef register(ctx):\n    pass\n';
  writeFileSync(source, legacy); rmSync(connection);
  const hashes = JSON.parse(readFileSync(registry, 'utf8'));
  hashes[source] = createHash('sha256').update(legacy).digest('hex'); delete hashes[connection];
  writeFileSync(registry, JSON.stringify(hashes));
  assert.equal(refreshClients(home, launch, [client])[0].state, 'refreshed');
  assert.equal(readFileSync(source, 'utf8'), initial);
  assert.equal(readFileSync(manifest, 'utf8'), initialManifest);
  assert.deepEqual(JSON.parse(readFileSync(connection, 'utf8')), { home, id: 'hermes', token: credential });
  authorizeClient(home, 'hermes', credential);
  // Refresh rewrites a managed stale credential using the current MCP grant.
  const stale = JSON.stringify({ home, id: 'hermes', token: 'obsolete-test-credential' }) + '\n';
  writeFileSync(connection, stale);
  const refreshedHashes = JSON.parse(readFileSync(registry, 'utf8'));
  refreshedHashes[connection] = createHash('sha256').update(stale).digest('hex');
  writeFileSync(registry, JSON.stringify(refreshedHashes));
  assert.equal(refreshClients(home, launch, [client])[0].state, 'refreshed');
  const current = readFileSync(connection, 'utf8');
  assert.equal(JSON.parse(current).token, credential);
  assert.equal(statSync(connection).mode & 0o777, 0o600);
  // Owner edits to the private wiring remain protected, like all managed assets.
  const edited = current + ' '; writeFileSync(connection, edited);
  assert.equal(refreshClients(home, launch, [client])[0].state, 'error');
  assert.equal(readFileSync(connection, 'utf8'), edited);
  authorizeClient(home, 'hermes', credential);
  writeFileSync(connection, current);
  const unrelated = join(directory, 'owner-file.txt'); writeFileSync(unrelated, 'keep\n');
  assert.equal(applyClientSelection(home, [], launch, [client])[0].state, 'disconnected');
  for (const file of [connection, source, manifest]) {
    assert.equal(existsSync(file), false);
    assert.equal(JSON.parse(readFileSync(registry, 'utf8'))[file], undefined);
  }
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep\n');
  assert.throws(() => authorizeClient(home, 'hermes', credential), /not connected/);
  assert.equal(applyClientSelection(home, ['hermes'], launch, [client])[0].state, 'connected');
  rmSync(unrelated);
  assert.equal(applyClientSelection(home, [], launch, [client])[0].state, 'disconnected');
  assert.equal(existsSync(directory), false, 'An empty managed plugin package must not remain discoverable');
});
test('OMP, Claude, Cursor and VS Code JSON preserve comments and unrelated entries', t => {
  const { home, clients, launch, save } = fixture(t);
  for (const id of ['omp', 'claude', 'claude-desktop', 'cursor', 'vscode']) {
    const client = clients.find(c => c.id === id);
    const body = `{\n  // keep this comment\n  "unrelated": {"value": 42},\n  "${client.key}": {"other": {"command": "tool"}},\n  "disabledServers": ["clanker", "other"]\n}\n`;
    save(client, body);
    const result = applyClientSelection(home, [id], launch, [client]); assert.equal(result[0].state, 'connected', id);
    const raw = readFileSync(client.file, 'utf8'); assert.match(raw, /keep this comment/); const config = parse(raw);
    assert.equal(config.unrelated.value, 42); assert.equal(config[client.key].other.command, 'tool');
    const entry = config[client.key].clanker;
    assert.equal(entry.env.CLANKER_CLIENT_ID, id);
    if (['omp', 'cursor', 'vscode'].includes(id)) assert.equal(entry.type, 'stdio', id);
    if (id === 'omp') assert.deepEqual(config.disabledServers, ['other']);
  }
});

test('OMP refresh migrates the managed legacy wrapper with the existing credential and protects edits', t => {
  const { home, clients, launch } = fixture(t),client=clients.find(item=>item.id==='omp');
  assert.equal(applyClientSelection(home,['omp'],launch,[client])[0].state,'connected');
  const wrapper=join(dirname(client.file),'extensions/clanker-chat.js'),registry=join(home,'integrations.json');
  const initial=readFileSync(wrapper,'utf8'),credential=parse(readFileSync(client.file,'utf8')).mcpServers.clanker.env.CLANKER_CLIENT_TOKEN;
  const legacy=`${initial.split('\n')[0]}\nexport default pi => setup(pi);\n`;
  writeFileSync(wrapper,legacy);
  const hashes=JSON.parse(readFileSync(registry,'utf8'));
  hashes[wrapper]=createHash('sha256').update(legacy).digest('hex');
  writeFileSync(registry,JSON.stringify(hashes));
  assert.equal(refreshClients(home,launch,[client])[0].state,'refreshed');
  const migrated=readFileSync(wrapper,'utf8');
  assert.equal(migrated,initial);
  assert.ok(migrated.includes(JSON.stringify({home,id:'omp',token:credential})));
  assert.equal(parse(readFileSync(client.file,'utf8')).mcpServers.clanker.env.CLANKER_CLIENT_TOKEN,credential);
  assert.equal(readAccess(home).clients.omp.token,credential);
  assert.equal(statSync(wrapper).mode & 0o777,0o600);
  const backup=join(home,'backups/omp',`${createHash('sha256').update(legacy).digest('hex')}.bak`);
  assert.equal(readFileSync(backup,'utf8'),legacy);
  const edited=`${migrated}// owner edit\n`;writeFileSync(wrapper,edited);
  assert.equal(refreshClients(home,launch,[client])[0].state,'error');
  assert.equal(readFileSync(wrapper,'utf8'),edited);
  authorizeClient(home,'omp',credential);
  writeFileSync(wrapper,migrated);
  const unrelated=join(dirname(wrapper),'owner-extension.js');writeFileSync(unrelated,'// keep\n');
  assert.equal(applyClientSelection(home,[],launch,[client])[0].state,'disconnected');
  assert.equal(existsSync(wrapper),false);
  assert.equal(readFileSync(unrelated,'utf8'),'// keep\n');
  assert.equal(JSON.parse(readFileSync(registry,'utf8'))[wrapper],undefined);
});

test('refresh refuses an installed OpenCode 1 without migrating its working config or revoking its credential', t => {
  const { home, clients, launch, save } = fixture(t); const client = clients.find(c => c.id === 'opencode');
  const grant = clientGrant(home, 'opencode', 'OpenCode'); enableClient(home, 'opencode', grant);
  const entry = { type: 'local', command: [launch.command, ...launch.args], environment: { ...launch.env, CLANKER_CLIENT_ID: 'opencode', CLANKER_CLIENT_TOKEN: grant.token }, enabled: true };
  const original = `{\n// working version-one settings\n"mcp":{"clanker":${JSON.stringify(entry)}},"model":"keep-my-model"\n}`;
  save(client, original); writeFileSync(client.executable, '#!/bin/sh\necho "1.19.4"\n');
  const [result] = refreshClients(home, launch, [client]);
  assert.equal(result.state, 'error');
  assert.equal(readFileSync(client.file, 'utf8'), original);
  authorizeClient(home, 'opencode', grant.token);
  assert.equal(existsSync(join(dirname(client.file), 'plugins/clanker-chat')), false);
});

test('OpenCode native conflicts cannot be hidden by an ignored legacy entry; owned legacy migration preserves user servers', t => {
  const { home, clients, launch, save } = fixture(t); const client = clients.find(c => c.id === 'opencode');
  const owned = { type: 'local', command: [launch.command, ...launch.args], environment: launch.env, enabled: true, timeout: 12000 };
  const conflict = JSON.stringify({ mcp: { clanker: owned, servers: { clanker: { type: 'local', command: ['different'] } } } });
  save(client, conflict);
  assert.equal(applyClientSelection(home, ['opencode'], launch, [client])[0].state, 'error');
  assert.equal(readFileSync(client.file, 'utf8'), conflict);
  assert.equal(readAccess(home).clients.opencode, undefined, 'ignored legacy settings must not enable a grant');
  const other = { type: 'remote', url: 'https://example.invalid/mcp', disabled: true };
  save(client, `{\n// my native servers\n"mcp":{"clanker":${JSON.stringify(owned)},"servers":{"other":${JSON.stringify(other)}}},"model":"my-model"\n}\n`);
  assert.equal(applyClientSelection(home, ['opencode'], launch, [client])[0].state, 'connected');
  const raw = readFileSync(client.file, 'utf8'), config = parse(raw);
  assert.match(raw, /my native servers/); assert.deepEqual(config.mcp.servers.other, other); assert.equal(config.model, 'my-model');
  assert.equal(config.mcp.clanker, undefined, 'the ignored legacy entry is removed, not retained as an alias');
  const current = config.mcp.servers.clanker;
  authorizeClient(home, 'opencode', current.environment.CLANKER_CLIENT_TOKEN);
  assert.equal(current.disabled, false); assert.equal(current.enabled, undefined);
  assert.deepEqual(current.timeout, { catalog: 12000, execution: 12000 });
  const plugin = join(dirname(client.file), 'plugins/clanker-chat');
  writeFileSync(join(plugin, 'user-owned.txt'), 'keep me');
  assert.equal(applyClientSelection(home, [], launch, [client])[0].state, 'disconnected');
  assert.equal(readFileSync(join(plugin, 'user-owned.txt'), 'utf8'), 'keep me');
  assert.equal(existsSync(join(plugin, 'index.js')), false); assert.equal(existsSync(join(plugin, 'tui.js')), false);
  assert.deepEqual(parse(readFileSync(client.file, 'utf8')).mcp.servers.other, other);
  assert.equal(applyClientSelection(home, ['opencode'], launch, [client])[0].state, 'connected');
  rmSync(join(plugin, 'user-owned.txt'));
  // A host/user can remove MCP settings first; disconnect must still remove our package.
  save(client, '{"mcp":{"servers":{}}}');
  assert.equal(applyClientSelection(home, [], launch, [client])[0].state, 'disconnected');
  assert.equal(existsSync(plugin), false, 'empty owned package must not remain in native auto-discovery');
});
test('malformed settings and conflicting servers stay byte-for-byte unchanged', t => {
  const { home, clients, launch, save } = fixture(t);
  for (const id of ['hermes', 'omp']) {
    const client = clients.find(c => c.id === id); const body = id === 'hermes' ? 'model: [bad\n' : '{bad'; save(client, body);
    assert.equal(applyClientSelection(home, [id], launch, [client])[0].state, 'error'); assert.equal(readFileSync(client.file, 'utf8'), body);
    const conflict = id === 'hermes' ? 'mcp_servers:\n  clanker:\n    command: different\n' : '{"mcpServers":{"clanker":{"command":"different"}}}'; save(client, conflict);
    assert.equal(applyClientSelection(home, [id], launch, [client])[0].state, 'error'); assert.equal(readFileSync(client.file, 'utf8'), conflict);
    for (const entry of [
      { ...launch, args: [] }, { ...launch, args: [...launch.args, 'other'] },
      { ...launch, env: { CLANKER_HOME: `${home}-other` } }
    ]) {
      const body = JSON.stringify({ [client.key]: { clanker: entry } }); save(client, body);
      assert.equal(applyClientSelection(home, [id], launch, [client])[0].state, 'error');
      assert.equal(readFileSync(client.file, 'utf8'), body);
    }
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
