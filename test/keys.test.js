import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Keys } from '../src/keys.js';
import { ClankerChat } from '../src/daemon.js';
import { seal, open, newBoxKey, newIdentity } from '../src/protocol.js';

const DAY = 24 * 60 * 60_000, WEEK = 7 * DAY, START = 1_800_000_000_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await pause(50); } throw new Error('Condition timed out'); }
const payload = text => ({ id: randomUUID(), kind: 'message', text, thread: randomUUID(), createdAt: START });
const statement = ({ key, from, signature }) => ({ key, from, signature });

function pair(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-keys-')), clock = { value: START };
  const make = name => {
    const store = new Store(join(root, name), name);
    return { store, keys: new Keys(store, { now: () => clock.value }) };
  };
  const a = make('A'), b = make('B');
  for (const [self, other] of [[a, b], [b, a]]) self.store.savePeer(other.store.identity.public, 'http://127.0.0.1:2');
  t.after(() => { a.store.close(); b.store.close(); rmSync(root, { recursive: true, force: true }); });
  const peer = (self, other) => self.store.peer(other.store.identity.public.id);
  return { a, b, clock, peer, root };
}

test('a recorded message cannot be opened, even with every key on the device, once its key is retired and deleted', async t => {
  const { a, b, clock, peer } = pair(t);
  assert.equal(a.keys.accept(peer(a, b), b.keys.statement()), true);
  const recorded = seal(a.store.identity, a.keys.sealTo(peer(a, b)), 'message', payload('secret plans'));
  const read = () => open(b.keys.receiver(), recorded, a.store.identity.public, 'message', { checkTime: false }).text;
  assert.equal(read(), 'secret plans');
  // Encrypted to the rotating key, not the identity's own long-lived one.
  assert.throws(() => open(b.store.identity, recorded, a.store.identity.public, 'message', { checkTime: false }));
  clock.value += WEEK; b.keys.tick();
  assert.equal(b.keys.own().length, 2);
  assert.equal(read(), 'secret plans');
  clock.value += 2 * DAY - 1; b.keys.tick();
  assert.equal(b.keys.own().length, 2);
  clock.value += 1; b.keys.tick();
  assert.equal(b.keys.own().length, 1);
  assert.throws(read);
});

test('a deleted key is gone from the database file and its write-ahead log', async t => {
  const { b, clock, root } = pair(t);
  const body = b.keys.own()[0].private.split('\n').slice(1, -2).join('');
  clock.value += WEEK; b.keys.tick();
  clock.value += 2 * DAY; b.keys.tick();
  assert.equal(b.keys.own().some(entry => entry.private.includes(body)), false);
  for (const name of ['inbox.db', 'inbox.db-wal']) {
    let bytes;
    try { bytes = readFileSync(join(root, 'B', name)); } catch { continue; }
    assert.equal(bytes.includes(Buffer.from(body)), false, name);
  }
});

test('contacts accept only newer keys signed by the pinned identity; others keep the identity key', async t => {
  const { a, b, clock, peer } = pair(t);
  const contact = peer(a, b);
  assert.equal(a.keys.sealTo(contact).boxKey, b.store.identity.public.boxKey);
  const current = b.keys.statement();
  for (const forged of [
    statement(newBoxKey(newIdentity('Stranger'), clock.value)),
    { ...current, key: newIdentity('Other').public.boxKey },
    { ...current, from: current.from + 1 },
    { key: current.key, from: current.from },
    statement(newBoxKey(b.store.identity, clock.value + 5 * 60_000 + 1)),
    'not a statement'
  ]) assert.equal(a.keys.accept(contact, forged), false);
  assert.equal(a.keys.sealTo(contact).boxKey, b.store.identity.public.boxKey);
  assert.equal(a.keys.accept(contact, current), true);
  clock.value += WEEK; b.keys.tick();
  const next = b.keys.statement();
  assert.equal(a.keys.accept(contact, next), true);
  assert.equal(a.keys.accept(contact, current), false);
  assert.equal(a.keys.sealTo(contact).boxKey, next.key);
});

test('inboxes exchange keys automatically, rotate them, and recover when a contact still holds a deleted one', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-keys-live-')), people = {};
  t.after(async () => { await Promise.all(Object.values(people).map(person => person.close())); rmSync(root, { recursive: true, force: true }); });
  const start = async (name, keys) => (people[name] = await new ClankerChat({ home: join(root, name), name, local: true, keys }).start());
  const alice = await start('Alice'), bob = await start('Bob', { rotateMs: 1_500, graceMs: 300 });
  await bob.command('pair', { code: (await alice.command('invite')).link });
  const bobId = bob.store.identity.public.id, aliceId = alice.store.identity.public.id;
  await until(() => alice.keys.sealTo(alice.store.peer(bobId)).boxKey !== bob.store.identity.public.boxKey && bob.keys.sealTo(bob.store.peer(aliceId)).boxKey !== alice.store.identity.public.boxKey);
  const held = alice.keys.sealTo(alice.store.peer(bobId)).boxKey;
  // Bob rotates and deletes the key Alice holds while Alice does not announce.
  alice.lastAnnounce = Date.now() + 60_000;
  await until(() => !bob.keys.own().some(entry => entry.key === held), 10_000);
  bob.keys.rotateMs = WEEK; // back to the real schedule, so the refreshed key stays valid
  const file = join(root, 'note.bin'); writeFileSync(file, randomBytes(70_001));
  const text = await alice.command('send', { to: 'Bob', text: 'Arrives after the key refresh.' });
  const sent = await alice.command('send', { to: 'Bob', file });
  await until(() => alice.store.list({ direction: 'out' }).find(row => row.id === text.id)?.attempts > 0);
  assert.equal(bob.store.list().some(row => row.id === text.id), false);
  // Alice's next announcement brings Bob's current key back in the receipt.
  alice.lastAnnounce = 0; await alice.command('retry');
  await until(() => [text.id, sent.id].every(id => alice.store.list({ direction: 'out' }).find(row => row.id === id)?.state === 'delivered'), 30_000);
  assert.ok((await bob.command('status')).encryptionKeySince > 0);
});
