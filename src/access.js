import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({ enforced: z.boolean(), clients: z.record(z.string(), z.object({ label: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() })) });
export function readAccess(home) {
  const file = join(home, 'clients.json');
  return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { enforced: false, clients: {} };
}
export function writeAccess(home, state) {
  const value = schema.parse(state); mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  const file = join(home, 'clients.json'); const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, file);
}
export function clientGrant(home, id, label) {
  const existing = readAccess(home).clients[id];
  return existing?.enabled ? existing : { label, token: randomBytes(32).toString('hex'), enabled: true };
}
export function enableClient(home, id, grant) {
  const state = readAccess(home); state.enforced = true; state.clients[id] = grant; writeAccess(home, state);
}
export function disableClient(home, id) {
  const state = readAccess(home); if (state.clients[id]) state.clients[id].enabled = false;
  state.enforced = true; writeAccess(home, state);
}
export function authorizeClient(home, id, token) {
  const state = readAccess(home);
  if (!state.enforced) return; // Existing 0.1.0 installs migrate on their next setup.
  const client = state.clients[id];
  const valid = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
  if (!client?.enabled || !valid || !timingSafeEqual(Buffer.from(token), Buffer.from(client.token))) throw new Error('This agent is not connected to Clanker Chat. Run clanker agents to choose access.');
}
