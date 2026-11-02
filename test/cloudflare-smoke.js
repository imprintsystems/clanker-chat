// Opt-in public transport check. Uses two throwaway local identities and only
// synthetic messages. No actual contact, agent session or user data is shared.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClankerChat } from '../src/daemon.js';

const home = mkdtempSync(join(tmpdir(), 'ap-live-'));
const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
let a = new ClankerChat({ home: join(home, 'a'), name: 'Synthetic A', cloudflared });
let b = new ClankerChat({ home: join(home, 'b'), name: 'Synthetic B', cloudflared });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, timeout = 60_000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await check()) return; await pause(500); } throw new Error('Live tunnel check timed out'); };
try {
  await a.start(); console.log('First temporary Cloudflare tunnel ready.');
  await b.start(); console.log('Second temporary Cloudflare tunnel ready.');
  // Quick Tunnel DNS can take a few seconds to propagate. Each failed attempt
  // gets a fresh code because a timeout may occur after the peer accepted it.
  await until(async () => {
    try { const invite = await a.command('invite'); await b.command('pair', { code: invite.link }); return true; }
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
  if (process.argv.includes('--discovery')) {
    const oldA = a.origin, oldB = b.origin, idA = a.store.identity.public.id, idB = b.store.identity.public.id;
    // Each side receives the other's private recovery key in a signed receipt.
    await until(() => a.store.discovery(idB) && b.store.discovery(idA));
    await Promise.all([a.discovery.publish(a.origin), b.discovery.publish(b.origin)]);
    const optionsA = a.options, optionsB = b.options;
    await b.close();
    const file = join(home, 'synthetic.bin'), bytes = randomBytes(180_017);
    writeFileSync(file, bytes);
    const queued = await a.command('send', { to: idB, text: 'Synthetic file queued across two changed tunnel addresses.', file });
    await a.close();
    a = new ClankerChat(optionsA); b = new ClankerChat(optionsB);
    await Promise.all([a.start(), b.start()]);
    assert.notEqual(a.origin, oldA); assert.notEqual(b.origin, oldB);
    assert.equal(a.store.identity.public.id, idA); assert.equal(b.store.identity.public.id, idB);
    await Promise.all([a.discovery.publish(a.origin), b.discovery.publish(b.origin)]);
    // No fresh invitation or pair call: each inbox still has the other's old
    // address in its database and must recover it through signed public lookup.
    await until(() => a.store.list({ direction: 'out' }).find(row => row.id === queued.id)?.state === 'delivered', 180_000);
    assert.equal(b.store.list().filter(row => row.id === queued.id).length, 1);
    assert.equal(a.store.peer(idB).endpoint, b.origin);
    const saved = join(home, 'received.bin');
    await b.command('save_file', { id: queued.id, path: saved });
    assert.deepEqual(readFileSync(saved), bytes);
    if (process.platform === 'darwin') assert.match(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', saved], { encoding: 'utf8' }), /;Clanker Chat;/);
    const reply = await b.command('send', { to: idA, text: 'Synthetic reply after decentralized address recovery.' });
    await until(() => a.store.list().some(row => row.id === reply.id), 180_000);
    console.log('Both tunnels changed: private Pkarr records recovered both addresses and delivered the queued file and reply without pairing again; the saved file carries the quarantine mark.');
  }
  console.log(JSON.stringify({ passed: true, transport: 'real Cloudflare Quick Tunnels', pairedByLink: true, directions: ['A to B', 'B to A'], decentralizedRecovery: process.argv.includes('--discovery'), receipts: 'persisted and verified', syntheticDataOnly: true }));
} catch (error) {
  for (const [side, daemon] of [['A', a], ['B', b]]) {
    console.error(JSON.stringify({ side, online: daemon.endpointReady, networkErrors: (daemon.tunnelLog || '').split('\n').filter(line => /ERR|WRN|Registered tunnel/.test(line)).slice(-8) }));
  }
  throw error;
} finally {
  await Promise.all([a.close(), b.close()]); rmSync(home, { recursive: true, force: true });
}
