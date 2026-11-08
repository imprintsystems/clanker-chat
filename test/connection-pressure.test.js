import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { Store } from '../src/store.js';
import { newIdentity, seal, open } from '../src/protocol.js';

test('local socket exhaustion does not trigger more address-discovery requests', async t => {
  const peer = { id: 'a'.repeat(64), endpoint: 'https://synthetic.trycloudflare.com' };
  const daemon = new ClankerChat({}); let discoveries = 0, code;
  daemon.store = { peer: () => peer, discovery: () => ({}) };
  daemon.discovery = { status: () => ({ enabled: true }), resolve: async () => { discoveries++; return null; } };
  t.mock.method(https, 'request', () => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('synthetic connection failure'), { code })));
    return request;
  });
  for (code of ['EADDRNOTAVAIL', 'EMFILE', 'ENFILE', 'ENOBUFS']) {
    await assert.rejects(daemon.postPeer(peer, '/v1/announce', {}), error => error.cause?.code === code);
  }
  assert.equal(discoveries, 0);
  code = 'ECONNREFUSED'; await assert.rejects(daemon.postPeer(peer, '/v1/announce', {}));
  assert.equal(discoveries, 1, 'a remote address failure still tries normal recovery');
});

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-pressure-')), store = new Store(home, 'Synthetic');
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const daemon = new ClankerChat({ local: true });
  daemon.store = store; daemon.origin = 'http://127.0.0.1:4567';
  daemon.discussions = { expire() {} }; daemon.keys = { accept() {}, sealTo: peer => peer.identity };
  const peers = ['Quiet', 'Live'].map(name => newIdentity(name));
  for (const peer of peers) store.savePeer(peer.public, 'http://127.0.0.1:4568');
  let now = Date.now(), offline = true;
  const attempts = { Quiet: 0, Live: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(daemon, 'postPeer', async (peer, route, envelope) => {
    attempts[peer.identity.name]++;
    if (peer.identity.name === 'Quiet' && offline) throw new Error('Synthetic offline contact');
    const identity = peers.find(p => p.public.id === peer.id);
    const result = route === '/v1/messages' ? { messageId: open(identity, envelope, store.identity.public, 'message').id } : { updated: true };
    return seal(identity, store.identity.public, 'receipt', { requestId: envelope.id, ...result });
  });
  return { daemon, store, attempts, advance: ms => { now += ms; }, online: () => { offline = false; },
    async flush() { daemon.lastAnnounce = 0; await daemon.flush(); } };
}

test('offline heartbeats back off to five minutes while live contacts keep their cadence', async t => {
  const f = fixture(t);
  await f.flush(); assert.deepEqual(f.attempts, { Quiet: 1, Live: 1 });
  f.advance(30_000); await f.flush(); assert.deepEqual(f.attempts, { Quiet: 1, Live: 2 });
  f.advance(30_000); await f.flush(); assert.equal(f.attempts.Quiet, 2);
  f.advance(119_999); await f.flush(); assert.equal(f.attempts.Quiet, 2);
  f.advance(1); await f.flush(); assert.equal(f.attempts.Quiet, 3);
  f.advance(240_000); await f.flush(); assert.equal(f.attempts.Quiet, 4);
  f.advance(299_999); await f.flush(); assert.equal(f.attempts.Quiet, 4);
  f.advance(1); await f.flush(); assert.equal(f.attempts.Quiet, 5);
  f.online(); f.advance(300_000); await f.flush(); assert.equal(f.attempts.Quiet, 6);
  f.advance(30_000); await f.flush(); assert.equal(f.attempts.Quiet, 7, 'a successful receipt restores the normal cadence');
});

test('authenticated activity and changed addresses bypass heartbeat backoff; revoked peers stop retrying', async t => {
  const f = fixture(t), peer = f.store.peer('Quiet');
  await f.flush(); f.advance(30_000);
  f.store.saw(peer.id); await f.flush(); assert.equal(f.attempts.Quiet, 2);
  f.advance(30_000); f.store.savePeer(peer.identity, 'http://127.0.0.1:4569');
  await f.flush(); assert.equal(f.attempts.Quiet, 3);
  f.store.prepare('UPDATE peers SET revoked=1 WHERE id=?').run(peer.id);
  f.advance(300_000); await f.flush(); assert.equal(f.attempts.Quiet, 3);
  assert.equal(f.daemon.announceRetries.has(peer.id), false);
});

test('heartbeat backoff does not delay queued messages, and delivery wakes normal heartbeats', async t => {
  const f = fixture(t), peer = f.store.peer('Quiet');
  await f.flush(); f.advance(30_000); f.online();
  const payload = { id: randomUUID(), thread: randomUUID(), kind: 'message', text: 'Synthetic queued message', createdAt: Date.now() };
  f.store.insert(peer.id, 'out', payload);
  await f.flush();
  assert.equal(f.store.list({ direction: 'out' }).find(row => row.id === payload.id).state, 'delivered');
  assert.equal(f.attempts.Quiet, 2, 'only the queued message bypasses the pending heartbeat delay');
  f.advance(30_000); await f.flush(); assert.equal(f.attempts.Quiet, 3);
});
