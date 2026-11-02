// Opt-in public transport check. Uses two throwaway local identities and only
// synthetic messages. No actual contact, agent session or user data is shared.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { ClankerChat } from '../src/daemon.js';

const home = mkdtempSync(join(tmpdir(), 'ap-live-'));
const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
const a = new ClankerChat({ home: join(home, 'a'), name: 'Synthetic A', cloudflared });
let b = new ClankerChat({ home: join(home, 'b'), name: 'Synthetic B', cloudflared });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { const start = Date.now(); while (Date.now() - start < 60_000) { if (await check()) return; await pause(500); } throw new Error('Live tunnel check timed out'); };
try {
  await a.start(); console.log('First temporary Cloudflare tunnel ready.');
  await b.start(); console.log('Second temporary Cloudflare tunnel ready.');
  // Quick Tunnel DNS can take a few seconds to propagate. Each failed attempt
  // gets a fresh code because a timeout may occur after the peer accepted it.
  await until(async () => {
    try { const invite = await a.command('invite'); await b.command('pair', { code: invite.code }); return true; }
    catch (error) { console.log(`Pairing not ready: ${error.message}`); await pause(1500); return false; }
  });
  const forward = await a.command('send', { to: b.store.identity.public.id, text: 'Synthetic tunnel message A to B.' });
  await until(() => b.store.list().length === 1);
  await until(() => a.store.list({ direction: 'out' })[0].state === 'delivered');
  assert.equal(b.store.list()[0].id, forward.id);
  const reply = await b.command('send', { to: a.store.identity.public.id, text: 'Synthetic tunnel reply B to A.', thread: forward.thread, replyTo: forward.id });
  await until(() => a.store.list().length === 1);
  await until(() => b.store.list({ direction: 'out' })[0].state === 'delivered');
  assert.equal(a.store.list()[0].id, reply.id);
  if (process.argv.includes('--resilience')) {
    // Pause only this disposable tunnel process, simulating a lost connection.
    const tunnel = b.tunnel;
    assert.equal(tunnel.kill('SIGSTOP'), true);
    let queued;
    try {
      queued = await a.command('send', { to: b.store.identity.public.id, text: 'Synthetic message queued during a tunnel outage.' });
      await until(() => a.store.list({ direction: 'out' }).find(row => row.id === queued.id)?.attempts > 0);
      assert.equal(a.store.list({ direction: 'out' }).find(row => row.id === queued.id).state, 'queued');
      assert.equal(b.store.list().some(row => row.id === queued.id), false);
      console.log('Paused tunnel: failed delivery stayed queued.');
    } finally { tunnel.kill('SIGCONT'); }
    await until(() => a.store.list({ direction: 'out' }).find(row => row.id === queued.id)?.state === 'delivered');
    assert.equal(b.store.list().filter(row => row.id === queued.id).length, 1);
    console.log('Resumed tunnel: queued message delivered exactly once without manual retry.');

    const oldOrigin = b.origin; const oldIdentity = b.store.identity.public.id; const options = b.options;
    await b.close(); b = new ClankerChat(options); await b.start();
    assert.notEqual(b.origin, oldOrigin); assert.equal(b.store.identity.public.id, oldIdentity);
    await until(() => a.store.peer(oldIdentity).endpoint === b.origin);
    const recovered = await a.command('send', { to: oldIdentity, text: 'Synthetic message after an automatic address update.' });
    await until(() => a.store.list({ direction: 'out' }).find(row => row.id === recovered.id)?.state === 'delivered');
    assert.equal(b.store.list().filter(row => row.id === recovered.id).length, 1);
    console.log('Replacement tunnel: contact learned its new address and delivery resumed without pairing again.');
  }
  console.log(JSON.stringify({ passed: true, transport: 'two real Cloudflare Quick Tunnels', paired: true, directions: ['A to B', 'B to A'], receipts: 'persisted and verified', syntheticDataOnly: true }));
} catch (error) {
  for (const [side, daemon] of [['A', a], ['B', b]]) {
    console.error(JSON.stringify({ side, online: daemon.endpointReady, networkErrors: (daemon.tunnelLog || '').split('\n').filter(line => /ERR|WRN|Registered tunnel/.test(line)).slice(-8) }));
  }
  throw error;
} finally {
  await a.close(); await b.close(); rmSync(home, { recursive: true, force: true });
}
