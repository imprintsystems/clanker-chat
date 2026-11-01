import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { localCall } from './local.js';
import { VERSION } from './version.js';
import { newer } from './updates.js';
import { homedir } from 'node:os';

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
export async function startInstalledService(home, { formula, run = execute, wait = true, expectedName } = {}) {
  if (!formula) throw new Error('This checkout is not installed through Homebrew. Use setup --no-service, or install the generated formula first.');
  let restart = false;
  if (wait) try { const current = await localCall(home, 'status'); restart = current.version !== VERSION || (expectedName && current.identity.name !== expectedName); } catch {}
  run('brew', ['services', restart ? 'restart' : 'start', formula]);
  if (!wait) return { service: formula, state: 'start requested' };
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try { const status = await localCall(home, 'status'); if (status.online && status.version === VERSION && (!expectedName || status.identity.name === expectedName)) return { service: formula, state: 'running', identity: status.identity }; }
    catch { /* brew services returns before cloudflared finishes starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Background service was registered but did not become ready within 60 seconds. Run clanker status and inspect the Homebrew service logs.');
}
// brew upgrade replaces the files but leaves the old background inbox running.
// The first command after an upgrade restarts it, so new commands work at once.
export async function restartIfOutdated(home, { env = process.env, run = execute } = {}) {
  if (!env.CLANKER_BREW_FORMULA || home !== join(homedir(), '.clanker')) return false;
  let status; try { status = await localCall(home, 'status'); } catch { return false; }
  if (status.version === VERSION || newer(status.version, VERSION)) return false;
  run('brew', ['services', 'restart', env.CLANKER_BREW_FORMULA]);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try { if ((await localCall(home, 'status')).version === VERSION) return true; } catch { /* Still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
