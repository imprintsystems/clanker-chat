import { existsSync, accessSync, constants, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { parse as parseJSONC, modify, applyEdits } from 'jsonc-parser';
import { parseDocument, isMap } from 'yaml';
import { readAccess, clientGrant, enableClient, disableClient, writeAccess } from './access.js';

export function findExecutable(name, searchPath = process.env.PATH || '') {
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const path = join(directory, name);
    try { accessSync(path, constants.X_OK); return path; } catch { /* Keep looking. */ }
  }
  return null;
}
export function discoverClients({ systemHome = homedir(), env = process.env, platform = process.platform } = {}) {
  const support = join(systemHome, 'Library/Application Support');
  const config = env.XDG_CONFIG_HOME || join(systemHome, '.config');
  const apps = ['/Applications', join(systemHome, 'Applications')];
  const appExists = names => apps.some(dir => names.some(name => existsSync(join(dir, name))));
  const hermes = env.HERMES_HOME || join(systemHome, '.hermes');
  const profile = env.OMP_PROFILE || env.PI_PROFILE;
  if (profile && !/^[a-zA-Z0-9_.-]+$/.test(profile)) throw new Error('The active OMP profile name is not supported. Use a profile name without path separators.');
  const omp = profile ? join(systemHome, '.omp/profiles', profile, 'agent') : join(systemHome, '.omp/agent');
  const choose = paths => paths.find(existsSync) || paths[0];
  const list = [
    { id: 'hermes', label: 'Hermes', binary: 'hermes', roots: [hermes], file: join(hermes, 'config.yaml'), format: 'yaml', key: 'mcp_servers', apps: ['Hermes.app'] },
    { id: 'codex', label: 'Codex', binary: 'codex', roots: [env.CODEX_HOME || join(systemHome, '.codex')], file: join(env.CODEX_HOME || join(systemHome, '.codex'), 'config.toml'), format: 'codex', apps: ['Codex.app', 'ChatGPT.app'] },
    { id: 'claude', label: 'Claude Code', binary: 'claude', roots: [join(systemHome, '.claude')], file: join(systemHome, '.claude.json'), format: 'json', key: 'mcpServers', apps: [] },
    { id: 'claude-desktop', label: 'Claude Desktop', roots: [join(support, 'Claude')], file: platform === 'darwin' ? join(support, 'Claude/claude_desktop_config.json') : join(config, 'Claude/claude_desktop_config.json'), format: 'json', key: 'mcpServers', apps: ['Claude.app'] },
    { id: 'omp', label: profile ? `Oh My Pi (${profile})` : 'Oh My Pi', binary: 'omp', roots: [omp], file: choose([join(omp, 'mcp.json'), join(omp, '.mcp.json')]), format: 'json', key: 'mcpServers', apps: [] },
    { id: 'cursor', label: 'Cursor', binary: 'cursor', roots: [join(systemHome, '.cursor')], file: join(systemHome, '.cursor/mcp.json'), format: 'json', key: 'mcpServers', apps: ['Cursor.app'] },
    { id: 'vscode', label: 'VS Code', binary: 'code', roots: [platform === 'darwin' ? join(support, 'Code') : join(config, 'Code')], file: platform === 'darwin' ? join(support, 'Code/User/mcp.json') : join(config, 'Code/User/mcp.json'), format: 'json', key: 'servers', apps: ['Visual Studio Code.app'] },
    { id: 'opencode', label: 'OpenCode', binary: 'opencode', roots: [join(config, 'opencode')], file: choose([join(config, 'opencode/opencode.jsonc'), join(config, 'opencode/opencode.json')]), format: 'json', key: 'mcp', apps: ['OpenCode.app'] }
  ];
  return list.map(client => {
    const executable = client.binary ? findExecutable(client.binary, env.PATH) : null;
    const evidence = executable ? 'installed' : existsSync(client.file) || client.roots.some(existsSync) ? 'config found' : appExists(client.apps) ? 'app found' : 'not found';
    return { ...client, executable, detected: evidence !== 'not found', evidence, available: client.format !== 'codex' || !!executable, hint: client.format === 'codex' && !executable ? 'Codex CLI needed to configure access' : evidence };
  });
}

function loadConfig(client) {
  const original = existsSync(client.file) ? readFileSync(client.file, 'utf8') : '';
  if (client.format === 'yaml') {
    const document = parseDocument(original || '{}\n', { uniqueKeys: true });
    if (document.contents === null) document.contents = document.createNode({});
    if (document.errors.length || !isMap(document.contents)) throw new Error(`${client.label} settings could not be read. The file was left unchanged.`);
    return { original, document, value: document.toJS() };
  }
  const errors = [];
  const value = parseJSONC(original || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${client.label} settings could not be read. The file was left unchanged.`);
  return { original, value };
}
function backupConfig(client, original, home) {
  if (original) {
    const backups = join(home, 'backups', client.id); mkdirSync(backups, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(original).digest('hex');
    const backup = join(backups, `${digest}.bak`);
    if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
  }
}
function atomicConfigWrite(client, original, next, home) {
  const path = existsSync(client.file) ? realpathSync(client.file) : client.file;
  if ((existsSync(path) ? readFileSync(path, 'utf8') : '') !== original) throw new Error(`${client.label} settings changed during setup. Try again; nothing was overwritten.`);
  if (next === original) return;
  backupConfig(client, original, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.clanker-${randomUUID()}.tmp`);
  writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
}
const runDefault = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
function codexEntry(client, run) {
  try { return JSON.parse(run(client.executable || 'codex', ['mcp', 'get', 'clanker', '--json'])).transport; }
  catch (error) {
    if (/No MCP server named|not found|does not exist/i.test(String(error.stderr || error.message)) && error.code !== 'ENOENT') return undefined;
    throw new Error('Codex settings could not be read. They were left unchanged.');
  }
}
function shape(client, launch) {
  if (client.id === 'opencode') return { type: 'local', command: [launch.command, ...launch.args], environment: launch.env, enabled: true };
  return { ...(client.id === 'omp' || client.id === 'vscode' ? { type: 'stdio' } : {}), command: launch.command, args: launch.args, env: launch.env, ...(client.id === 'hermes' ? { enabled: true } : {}) };
}
function owned(entry, launch) {
  if (!entry) return true;
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args || [];
  const env = entry.env || entry.environment || {};
  return command === launch.command && JSON.stringify(args) === JSON.stringify(launch.args) && env.CLANKER_HOME === launch.env.CLANKER_HOME;
}
export function clientIsConfigured(client, launch, { run = runDefault } = {}) {
  try {
    const entry = client.format === 'codex' ? codexEntry(client, run) : loadConfig(client).value[client.key]?.clanker;
    return !!entry && owned(entry, launch);
  } catch { return false; }
}
export function configureClient(client, launch, home, { remove = false, run = runDefault } = {}) {
  if (!client.available) throw new Error(`${client.label}: ${client.hint}`);
  if (client.format === 'codex') {
    const existing = codexEntry(client, run);
    if (!owned(existing, launch)) throw new Error('A different clanker server exists in Codex. It was left unchanged.');
    if (existsSync(client.file) && (!remove || existing)) backupConfig(client, readFileSync(client.file, 'utf8'), home);
    if (remove) { if (existing) run(client.executable, ['mcp', 'remove', 'clanker']); return; }
    run(client.executable, ['mcp', 'add', 'clanker', ...Object.entries(launch.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', launch.command, ...launch.args]);
    return;
  }
  const { original, document, value } = loadConfig(client);
  if (value[client.key] !== undefined && (typeof value[client.key] !== 'object' || value[client.key] === null || Array.isArray(value[client.key]))) throw new Error(`${client.label} has an unsupported MCP configuration. It was left unchanged.`);
  const existing = value[client.key]?.clanker;
  if (!owned(existing, launch)) throw new Error(`A different clanker server exists in ${client.label}. It was left unchanged.`);
  const desired = remove ? undefined : { ...existing, ...shape(client, launch) };
  let next;
  if (document) {
    if (remove) document.deleteIn([client.key, 'clanker']);
    else document.setIn([client.key, 'clanker'], desired);
    next = document.toString();
  } else {
    next = applyEdits(original || '{}\n', modify(original || '{}\n', [client.key, 'clanker'], desired, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    // OMP's native denylist wins over the entry's enabled setting.
    if (!remove && client.id === 'omp' && Array.isArray(value.disabledServers) && value.disabledServers.includes('clanker')) next = applyEdits(next, modify(next, ['disabledServers'], value.disabledServers.filter(name => name !== 'clanker'), { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (remove && !existing) return;
  atomicConfigWrite(client, original, next, home);
}
export function applyClientSelection(home, selected, launch, clients, options = {}) {
  const results = []; const before = readAccess(home);
  for (const client of clients) {
    const legacy = !before.enforced && client.detected && client.available && clientIsConfigured(client, launch, options);
    if (!selected.includes(client.id) && !before.clients[client.id]?.enabled && !legacy) continue;
    if (!selected.includes(client.id)) {
      disableClient(home, client.id); // Revokes running sessions even if config removal fails.
      try { configureClient(client, launch, home, { ...options, remove: true }); results.push({ id: client.id, label: client.label, state: 'disconnected' }); }
      catch { results.push({ id: client.id, label: client.label, state: 'disconnected', note: 'Access revoked. Its old settings entry could not be removed.' }); }
      continue;
    }
    const grant = clientGrant(home, client.id, client.label);
    const entry = { ...launch, env: { ...launch.env, CLANKER_CLIENT_ID: client.id, CLANKER_CLIENT_TOKEN: grant.token } };
    try { configureClient(client, entry, home, options); enableClient(home, client.id, grant); results.push({ id: client.id, label: client.label, state: 'connected' }); }
    catch (error) { results.push({ id: client.id, label: client.label, state: 'error', note: /different clanker|could not be read|unsupported|changed during/.test(error.message) ? error.message : 'Could not save this connection. Existing settings were kept.' }); }
  }
  if (!selected.length) { const state = readAccess(home); state.enforced = true; writeAccess(home, state); }
  return results;
}
