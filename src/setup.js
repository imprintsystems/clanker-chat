import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { localCall } from './local.js';

const profileSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export function readProfile(home) {
  const file = join(home, 'profile.json');
  return existsSync(file) ? profileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
}
export function saveProfile(home, value) {
  const profile = profileSchema.parse(value);
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  const temporary = join(home, `profile-${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, join(home, 'profile.json'));
  return profile;
}
export function launchCommand(home, cli, env = process.env) {
  return { command: env.CLANKER_EXECUTABLE || process.execPath, args: env.CLANKER_EXECUTABLE ? ['mcp'] : [cli, 'mcp'], env: { CLANKER_HOME: home } };
}
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
export function registerClient(client, launch, { run = execute, claudeSettings } = {}) {
  if (client === 'manual') return { client, config: { mcpServers: { 'clanker': launch } } };
  if (!['codex', 'claude'].includes(client)) throw new Error('Client must be codex, claude, or manual');
  let existing;
  if (client === 'codex') {
    let output;
    try { output = run('codex', ['mcp', 'get', 'clanker', '--json']); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Codex CLI is not installed. Choose manual setup or install Codex first.');
      const reason = String(error.stderr || error.message);
      if (!/No MCP server named|not found|does not exist/i.test(reason)) throw new Error('Could not inspect existing Codex MCP settings. They were left unchanged.');
    }
    if (output) { const entry = JSON.parse(output); existing = entry.transport; }
  } else if (claudeSettings && existsSync(claudeSettings)) {
    existing = JSON.parse(readFileSync(claudeSettings, 'utf8')).mcpServers?.['clanker'];
  }
  if (existing) {
    if (existing.command === launch.command && JSON.stringify(existing.args || []) === JSON.stringify(launch.args) && existing.env?.CLANKER_HOME === launch.env.CLANKER_HOME) return { client, state: 'already configured' };
    throw new Error(`An clanker entry already exists in ${client} with different settings. It was left unchanged. Remove or rename it in that app before rerunning setup.`);
  }
  const args = client === 'codex'
    ? ['mcp', 'add', 'clanker', '--env', `CLANKER_HOME=${launch.env.CLANKER_HOME}`, '--', launch.command, ...launch.args]
    : ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'clanker', '--env', `CLANKER_HOME=${launch.env.CLANKER_HOME}`, '--', launch.command, ...launch.args];
  try { run(client, args); }
  catch (error) { throw new Error(`Could not connect ${client}: ${String(error.stderr || error.message).trim().slice(0, 400)}`); }
  return { client, state: 'configured' };
}
export async function startInstalledService(home, { formula, run = execute, wait = true } = {}) {
  if (!formula) throw new Error('This checkout is not installed through Homebrew. Use setup --no-service, or install the generated formula first.');
  run('brew', ['services', 'start', formula]);
  if (!wait) return { service: formula, state: 'start requested' };
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try { const status = await localCall(home, 'status'); if (status.online) return { service: formula, state: 'running', identity: status.identity }; }
    catch { /* brew services returns before cloudflared finishes starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Background service was registered but did not become ready within 60 seconds. Run clanker status and inspect the Homebrew service logs.');
}
