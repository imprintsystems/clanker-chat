import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { Keypair, SignedPacket } from '@synonymdev/pkarr';
import { ClankerChat } from '../src/daemon.js';
import { seal } from '../src/protocol.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error('Discovery delivery timed out');
}
function network() {
  const records = new Map();
  return { records, client: () => ({
    async publish(packet) { records.set(packet.publicKey, packet.bytes()); return 1; },
    async resolve(key) { const bytes = records.get(key); return bytes ? SignedPacket.fromBytes(bytes) : null; },
    free() {}
  }) };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clanker-discovery-')), shared = network(), people = {};
  t.after(async () => { await Promise.all(Object.values(people).map(person => person.close())); rmSync(root, { recursive: true, force: true }); });
  const start = async name => {
    const daemon = await new ClankerChat({ home: join(root, name), name, local: true, discovery: { client: shared.client() } }).start();
    people[name] = daemon; await daemon.discovery.publish(daemon.origin); return daemon;
  };
  // Pairing hands each side the other's recovery key: the inviter's in the
  // pairing receipt, the new contact's in the receipt of the inviter's announcement.
  const pair = async (inviter, invitee) => {
    await people[invitee].command('pair', { code: (await people[inviter].command('invite')).link });
    const [a, b] = [people[inviter], people[invitee]];
    await until(() => a.store.discovery(b.store.identity.public.id) && b.store.discovery(a.store.identity.public.id));
  };
  await Promise.all(['Alice', 'Bob'].map(start));
  await pair('Alice', 'Bob');
  return { root, shared, people, start, pair };
}

test('both changed inbox addresses recover queued text and a snapshotted file without pairing again', async t => {
  const f = await fixture(t), { people, root } = f;
  const identity = people.Alice.store.identity.public.id, bobIdentity = people.Bob.store.identity.public.id;
  const oldA = people.Alice.origin, oldB = people.Bob.origin;
  await people.Bob.close();
  const text = await people.Alice.command('send', { to: 'Bob', text: 'Queued across both restarts.' });
  const bytes = randomBytes(90_017), file = join(root, 'shared.bin'); writeFileSync(file, bytes);
  const sent = await people.Alice.command('send', { to: 'Bob', file });
  await people.Alice.close();
  await Promise.all(['Alice', 'Bob'].map(f.start));
  assert.notEqual(people.Alice.origin, oldA); assert.notEqual(people.Bob.origin, oldB);
  await until(() => [text.id, sent.id].every(id => people.Alice.store.list({ direction: 'out' }).find(row => row.id === id)?.state === 'delivered'));
  assert.equal(people.Alice.store.identity.public.id, identity);
  assert.equal(people.Bob.store.identity.public.id, bobIdentity);
  assert.equal(people.Alice.store.peer('Bob').endpoint, people.Bob.origin);
  const received = people.Bob.store.list();
  assert.deepEqual(received.filter(row => row.id === text.id).map(row => row.payload.text), ['Queued across both restarts.']);
  const destination = join(root, 'saved.bin');
  await people.Bob.command('save_file', { id: sent.id, path: destination });
  assert.deepEqual(readFileSync(destination), bytes);
});

test('revoking a contact rotates the recovery key: remaining contacts follow the next address, the revoked one cannot', async t => {
  const f = await fixture(t), { people } = f;
  await f.start('Carol'); await f.pair('Alice', 'Carol');
  const alice = people.Alice.store.identity.public.id;
  const held = people.Carol.store.discovery(alice), before = people.Bob.store.discovery(alice);
  assert.deepEqual(held, before);
  await people.Alice.command('revoke', { peer: 'Carol' });
  // Bob's next announcement brings the new key back in Alice's receipt.
  people.Bob.lastAnnounce = 0;
  await until(() => people.Bob.store.discovery(alice).key !== before.key);
  assert.notEqual(people.Bob.store.discovery(alice).secret, before.secret);
  const oldOrigin = people.Alice.origin;
  await people.Alice.close(); await f.start('Alice');
  assert.notEqual(people.Alice.origin, oldOrigin);
  assert.equal((await people.Bob.discovery.resolve(people.Bob.store.discovery(alice)))?.endpoint, people.Alice.origin);
  assert.notEqual((await people.Carol.discovery.resolve(held))?.endpoint, people.Alice.origin);
  // Nothing in the public records names an inbox or carries an address in the clear.
  for (const bytes of f.shared.records.values()) {
    for (const visible of ['127.0.0.1', 'Alice', 'Bob', 'Carol']) assert.equal(Buffer.from(bytes).includes(Buffer.from(visible)), false);
  }
  const identityKeys = Object.values(people).map(person => {
    const key = Keypair.fromSecretKey(Buffer.from(createPrivateKey(person.store.identity.signPrivate).export({ format: 'jwk' }).d, 'base64url'));
    try { return key.publicKey(); } finally { key.free(); }
  });
  assert.ok(f.shared.records.size >= 3);
  for (const key of f.shared.records.keys()) assert.equal(identityKeys.includes(key), false);
});

test('a contact revoked while address lookup is pending cannot update its address or receive the retry', async t => {
  const f = await fixture(t), a = f.people.Alice, b = f.people.Bob;
  await a.busy; await b.busy;
  a.store.prepare('UPDATE peers SET endpoint=?,announced=0 WHERE id=?').run('http://127.0.0.1:9', b.store.identity.public.id);
  let release, resolving = false;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const resolve = a.discovery.resolve.bind(a.discovery);
  a.discovery.resolve = async (...args) => { resolving = true; await gate; return resolve(...args); };
  const peer = a.store.peer('Bob');
  const attempt = a.postPeer(peer, '/v1/announce', seal(a.store.identity, peer.identity, 'announce', { endpoint: a.origin }));
  const rejected = assert.rejects(attempt, /revoked/);
  await until(() => resolving);
  await a.command('revoke', { peer: 'Bob' }); release();
  await rejected;
  const after = a.store.peer(peer.id);
  assert.equal(after.revoked, 1); assert.equal(after.endpoint, 'http://127.0.0.1:9');
});
