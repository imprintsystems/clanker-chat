// Opt-in public transport check. Uses two throwaway local identities and only
// synthetic messages. No actual contact, agent session or user data is shared.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { AgentPost } from '../src/daemon.js';

const home = mkdtempSync(join(tmpdir(), 'ap-live-'));
const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
const a = new AgentPost({ home: join(home, 'a'), name: 'Synthetic A', cloudflared });
const b = new AgentPost({ home: join(home, 'b'), name: 'Synthetic B', cloudflared });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { const start = Date.now(); while (Date.now() - start < 60_000) { if (await check()) return; await pause(500); } throw new Error('Live tunnel check timed out'); };
try {
  await a.start(); console.log('First temporary Cloudflare tunnel ready.');
  await b.start(); console.log('Second temporary Cloudflare tunnel ready.');
  // Quick Tunnel DNS can take a few seconds to propagate. Each failed attempt
  // gets a fresh code because a timeout may occur after the peer accepted it.
  let paired = false;
  await until(async () => {
    try { const invite = await a.command('invite'); await b.command('pair', { code: invite.code }); paired = true; return true; }
    catch (error) { console.log(`Pairing not ready: ${error.message}`); await pause(1500); return false; }
  });
  assert.equal(paired, true);
  const forward = await a.command('send', { to: b.store.identity.public.id, text: 'Synthetic tunnel message A to B.' });
  await until(() => b.store.list().length === 1);
  await until(() => a.store.list({ direction: 'out' })[0].state === 'delivered');
  assert.equal(b.store.list()[0].id, forward.id);
  const reply = await b.command('send', { to: a.store.identity.public.id, text: 'Synthetic tunnel reply B to A.', thread: forward.thread, replyTo: forward.id });
  await until(() => a.store.list().length === 1);
  await until(() => b.store.list({ direction: 'out' })[0].state === 'delivered');
  assert.equal(a.store.list()[0].id, reply.id);
  console.log(JSON.stringify({ passed: true, transport: 'two real Cloudflare Quick Tunnels', paired: true, directions: ['A to B', 'B to A'], receipts: 'persisted and verified', syntheticDataOnly: true }));
} catch (error) {
  for (const [side, daemon] of [['A', a], ['B', b]]) {
    console.error(JSON.stringify({ side, online: daemon.endpointReady, networkErrors: (daemon.tunnelLog || '').split('\n').filter(line => /ERR|WRN|Registered tunnel/.test(line)).slice(-8) }));
  }
  throw error;
} finally {
  await a.close(); await b.close(); rmSync(home, { recursive: true, force: true });
}
