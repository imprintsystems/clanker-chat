import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, SignedPacket, ResolvePolicy } from '@synonymdev/pkarr';
import { Store } from '../src/store.js';
import { Discovery, sealRecord } from '../src/discovery.js';

const A = 'https://first.trycloudflare.com';
const B = 'https://a-much-longer-second-address.trycloudflare.com';
const START = 1_800_000_000_000;
const CONTACT = 'c'.repeat(64), OTHER = 'd'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class MemoryClient {
  constructor() { this.records = new Map(); this.published = []; this.resolved = []; this.freed = 0; }
  async publish(packet) {
    assert.equal(this.freed, 0);
    const bytes = Buffer.from(packet.bytes());
    this.published.push(bytes);
    const count = this.onPublish ? await this.onPublish(packet) : 1;
    if (count > 0) this.records.set(packet.publicKey, bytes);
    return count;
  }
  async resolve(key, policy) {
    assert.equal(this.freed, 0);
    assert.equal(policy, ResolvePolicy.NetworkOnly);
    this.resolved.push(key);
    if (this.onResolve) await this.onResolve(key);
    const bytes = this.records.get(key);
    return bytes ? SignedPacket.fromBytes(bytes) : null;
  }
  free() { this.freed++; }
}
function memoryStore() {
  const values = new Map();
  return { get: key => values.get(key), set: (key, value) => values.set(key, structuredClone(value)) };
}
function fixture(t, options = {}) {
  const clock = { value: START }, store = memoryStore(), client = new MemoryClient();
  const discovery = new Discovery(store, { client, now: () => clock.value, ...options });
  t.after(() => discovery.close());
  return { discovery, client, clock, store };
}
// A remote inbox's key and secret, and a way to sign arbitrary records with its key.
function remote() {
  const keypair = new Keypair();
  const credentials = { key: Buffer.from(keypair.publicKeyBytes()).toString('base64url'), secret: randomBytes(32).toString('base64url') };
  return {
    credentials, z32: keypair.publicKey(),
    signed(at, records) {
      const builder = SignedPacket.builder();
      let packet;
      try {
        for (const [name, value, ttl, type = 'TXT'] of records) {
          if (type === 'A') builder.addARecord(name, value, ttl);
          else builder.addTxtRecord(name, value, ttl);
        }
        builder.setTimestamp(at);
        packet = builder.buildAndSign(keypair);
        return Buffer.from(packet.bytes());
      } finally { packet?.free(); builder.free(); }
    },
    record(value = A) { return ['_clanker', sealRecord(value, credentials), 300]; },
    free() { keypair.free(); }
  };
}
function holder(t) { const r = remote(); t.after(() => r.free()); return r; }
const recordOf = bytes => {
  const packet = SignedPacket.fromBytes(bytes);
  try { return { key: packet.publicKey, at: packet.timestampMs, records: packet.records }; } finally { packet.free(); }
};

test('nothing is published before a contact holds the key; records use a separate key and hide the address', async t => {
  const { discovery, client, clock } = fixture(t);
  discovery.tick(A); await turn();
  assert.equal(client.published.length, 0);
  const credentials = await discovery.share(CONTACT);
  discovery.tick(A); await discovery.publishing;
  assert.equal(client.published.length, 1);
  await discovery.publish(B);
  const [first, second] = client.published.map(recordOf);
  assert.equal(first.key, second.key);
  for (const [bytes, record] of [[client.published[0], first], [client.published[1], second]]) {
    assert.equal(bytes.includes(Buffer.from('trycloudflare')), false);
    assert.equal(record.records.length, 1);
    assert.match(record.records[0].rdata.value, /^v=2;e=[A-Za-z0-9_-]{208}$/);
  }
  // Short and long addresses publish records of identical size.
  assert.equal(client.published[0].length, client.published[1].length);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: B, at: clock.value + 1 });
  assert.deepEqual(discovery.status(), { enabled: true, publishedAt: clock.value + 1 });
});

test('a record opens only with the matching secret and an intact signature from the shared key', async t => {
  const { discovery, client, clock } = fixture(t);
  const owner = holder(t), stranger = holder(t);
  const original = owner.signed(clock.value, [owner.record()]);
  const signature = Buffer.from(original); signature[40] ^= 1;
  const timestamp = Buffer.from(original); timestamp[111] ^= 1;
  const content = Buffer.from(original); content[content.length - 20] ^= 1;
  for (const bytes of [signature, timestamp, content, stranger.signed(clock.value, [owner.record()])]) {
    client.records.set(owner.z32, bytes);
    assert.equal(await discovery.resolve(owner.credentials), null);
    clock.value += 30_000;
  }
  client.records.set(owner.z32, owner.signed(clock.value, [owner.record()]));
  assert.equal(await discovery.resolve({ ...owner.credentials, secret: randomBytes(32).toString('base64url') }), null);
  clock.value += 30_000;
  assert.deepEqual(await discovery.resolve(owner.credentials), { endpoint: A, at: clock.value - 30_000 });
  for (const malformed of [undefined, {}, { key: owner.credentials.key }, { ...owner.credentials, extra: 1 }, { ...owner.credentials, secret: 'short' }]) {
    assert.equal(await discovery.resolve(malformed), null);
  }
});

test('signed records reject stale, future and rolled-back timestamps, including cached results', async t => {
  const { discovery, client, clock } = fixture(t), owner = holder(t);
  for (const offset of [-7_200_001, 300_001]) {
    client.records.set(owner.z32, owner.signed(clock.value + offset, [owner.record()]));
    assert.equal(await discovery.resolve(owner.credentials), null);
    clock.value += 30_000;
  }
  const at = clock.value;
  client.records.set(owner.z32, owner.signed(at, [owner.record()]));
  assert.equal(await discovery.resolve(owner.credentials, at), null);
  assert.equal(await discovery.resolve(owner.credentials, at + 1), null);
  assert.deepEqual(await discovery.resolve(owner.credentials, at - 1), { endpoint: A, at });
  assert.equal(client.resolved.length, 3);
  clock.value += 7_200_001;
  assert.equal(await discovery.resolve(owner.credentials), null);
});

test('recovery accepts exactly one expected encrypted TXT record and TTL', async t => {
  const { discovery, client, clock } = fixture(t), owner = holder(t);
  const valid = owner.record();
  const invalid = [
    [],
    [['_other', valid[1], 300]],
    [['_clanker.child', valid[1], 300]],
    [['_clanker', `v=1;endpoint=${A}`, 300]],
    [['_clanker', `${valid[1]};x`, 300]],
    [['_clanker', valid[1].slice(0, -4), 300]],
    [['_clanker', valid[1], 301]],
    [['_clanker', '1.2.3.4', 300, 'A']],
    [valid, owner.record(B)],
    [valid, ['unexpected', '1.2.3.4', 300, 'A']],
  ];
  for (const records of invalid) {
    client.records.set(owner.z32, owner.signed(clock.value, records));
    assert.equal(await discovery.resolve(owner.credentials), null, JSON.stringify(records));
    clock.value += 30_000;
  }
  client.records.set(owner.z32, owner.signed(clock.value, [valid]));
  assert.deepEqual(await discovery.resolve(owner.credentials), { endpoint: A, at: clock.value });
});

test('decrypted endpoints cannot redirect recovery to private, credentialed, normalized or non-origin destinations', async t => {
  const { discovery, client, clock } = fixture(t), owner = holder(t);
  for (const value of [
    'http://first.trycloudflare.com', 'https://example.com', 'https://127.0.0.1',
    'http://127.0.0.1:4567', 'http://localhost:4567', 'https://nested.first.trycloudflare.com',
    `${A}:444`, `${A}/path`, `${A}/`, `${A}?secret=x`, `${A}#secret`,
    'https://name:password@first.trycloudflare.com', 'https://FIRST.trycloudflare.com',
  ]) {
    client.records.set(owner.z32, owner.signed(clock.value, [owner.record(value)]));
    assert.equal(await discovery.resolve(owner.credentials), null, value);
    clock.value += 30_000;
  }
  const localClient = new MemoryClient(), local = new Discovery(memoryStore(), { local: true, client: localClient, now: () => clock.value });
  t.after(() => local.close());
  localClient.records.set(owner.z32, owner.signed(clock.value, [owner.record('http://127.0.0.1:4567')]));
  assert.deepEqual(await local.resolve(owner.credentials), { endpoint: 'http://127.0.0.1:4567', at: clock.value });
});

test('losing a contact rotates the key and secret; former holders cannot follow the next address', async t => {
  const { discovery, client, clock } = fixture(t);
  const kept = await discovery.share(CONTACT);
  assert.deepEqual(await discovery.share(OTHER), kept);
  await discovery.publish(A);
  assert.equal(discovery.retain(new Set([CONTACT, OTHER])), false);
  assert.equal(discovery.retain(new Set([CONTACT])), true);
  // Nothing new is published until a remaining contact receives the new key.
  clock.value += 1;
  discovery.tick(B); await turn();
  assert.equal(client.published.length, 1);
  const rotated = await discovery.share(CONTACT);
  assert.notEqual(rotated.key, kept.key); assert.notEqual(rotated.secret, kept.secret);
  discovery.tick(B); await discovery.publishing;
  assert.equal(client.published.length, 2);
  assert.deepEqual(await discovery.resolve(rotated), { endpoint: B, at: clock.value });
  // The former key still points at the old record only, never the new address.
  assert.deepEqual(await discovery.resolve(kept), { endpoint: A, at: START });
  assert.equal(discovery.retain(new Set([CONTACT])), false);
});

test('key, secret and publication timestamps survive a real store restart and clock rollback', async t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-discovery-'));
  let store = new Store(home, 'Persistent'), discovery;
  t.after(async () => { await discovery?.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const firstClient = new MemoryClient();
  firstClient.onPublish = () => 0;
  discovery = new Discovery(store, { client: firstClient, now: () => START });
  const credentials = await discovery.share(CONTACT);
  await assert.rejects(discovery.publish(A), /not confirmed/);
  assert.equal(discovery.status().publishedAt, 0);
  assert.match(discovery.status().error, /not confirmed/);
  const first = recordOf(firstClient.published[0]);
  await discovery.close(); store.close();
  store = new Store(home);
  const nextClient = new MemoryClient();
  discovery = new Discovery(store, { client: nextClient, now: () => START - 1 });
  assert.deepEqual(await discovery.share(CONTACT), credentials);
  await discovery.publish(B);
  const next = recordOf(nextClient.published[0]);
  assert.equal(next.key, first.key);
  assert.equal(next.at, first.at + 1);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: B, at: first.at + 1 });
});

test('publication joins in flight and immediately follows a changed tunnel with the newest address', async t => {
  const { discovery, client } = fixture(t);
  const credentials = await discovery.share(CONTACT);
  const entered = deferred(), release = deferred();
  client.onPublish = async () => {
    if (client.published.length === 1) { entered.resolve(); await release.promise; }
    return 1;
  };
  const first = discovery.publish(A);
  await entered.promise;
  const changed = discovery.publish(B);
  assert.strictEqual(first, changed);
  assert.strictEqual(discovery.publish(B), first);
  release.resolve(); await first;
  assert.equal(client.published.length, 2);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: B, at: START + 1 });
});

test('ticks republish after thirty minutes, retry failures after sixty seconds and clear failure status', async t => {
  const { discovery, client, clock } = fixture(t);
  await discovery.share(CONTACT);
  await discovery.publish(A);
  clock.value += 1_800_000 - 1;
  discovery.tick(A); await turn();
  assert.equal(client.published.length, 1);
  clock.value++;
  discovery.tick(A); await turn();
  assert.equal(client.published.length, 2);
  client.onPublish = () => { throw new Error('gateway unavailable'); };
  await assert.rejects(discovery.publish(A), /gateway unavailable/);
  assert.match(discovery.status().error, /gateway unavailable/);
  const lastSuccess = discovery.status().publishedAt;
  clock.value += 59_999;
  discovery.tick(A); await turn();
  assert.equal(client.published.length, 3);
  client.onPublish = () => 1;
  clock.value++;
  discovery.tick(A); await turn();
  assert.equal(client.published.length, 4);
  assert.ok(discovery.status().publishedAt > lastSuccess);
  assert.equal(discovery.status().error, undefined);
  await assert.rejects(discovery.publish('http://127.0.0.1:4567'));
  assert.equal(client.published.length, 4);
});

test('per-key single flight and thirty-second cooldown bound failed and successful lookups', async t => {
  const { discovery, client, clock } = fixture(t), owner = holder(t);
  const entered = deferred(), release = deferred();
  client.onResolve = async () => { entered.resolve(); await release.promise; throw new Error('offline'); };
  const first = discovery.resolve(owner.credentials);
  await entered.promise;
  const second = discovery.resolve(owner.credentials);
  assert.equal(client.resolved.length, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  clock.value += 29_999;
  assert.equal(await discovery.resolve(owner.credentials), null);
  assert.equal(client.resolved.length, 1);
  clock.value++;
  client.onResolve = undefined;
  client.records.set(owner.z32, owner.signed(clock.value, [owner.record()]));
  assert.deepEqual(await discovery.resolve(owner.credentials), { endpoint: A, at: clock.value });
  assert.equal(client.resolved.length, 2);
  assert.equal(await discovery.resolve(owner.credentials, clock.value), null);
  assert.equal(client.resolved.length, 2);
});

test('disabled discovery and local mode without injection never touch storage or the network', async () => {
  const store = { get() { throw new Error('must remain lazy'); }, set() { throw new Error('must remain lazy'); } };
  const client = new MemoryClient(), disabled = new Discovery(store, { enabled: false, client });
  const local = new Discovery(store, { local: true });
  for (const discovery of [disabled, local]) {
    await discovery.publish(A);
    discovery.tick(A);
    assert.equal(await discovery.share(CONTACT), undefined);
    assert.equal(discovery.retain(new Set()), false);
    assert.equal(await discovery.resolve({}), null);
    assert.equal(discovery.status().enabled, false);
    await discovery.close();
  }
  assert.equal(client.published.length, 0);
  assert.equal(client.resolved.length, 0);
});

test('close waits for outstanding operations, suppresses queued publication and frees the client exactly once', async t => {
  const { discovery, client } = fixture(t), owner = holder(t);
  await discovery.share(CONTACT);
  const publishing = deferred(), resolving = deferred(), release = deferred();
  client.onPublish = async () => { publishing.resolve(); await release.promise; return 1; };
  client.onResolve = async () => { resolving.resolve(); await release.promise; };
  const publication = discovery.publish(A), lookup = discovery.resolve(owner.credentials);
  await Promise.all([publishing.promise, resolving.promise]);
  discovery.publish(B);
  let finished = false;
  const closing = discovery.close().then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  assert.equal(client.freed, 0);
  release.resolve();
  await Promise.all([publication, lookup, closing]);
  assert.equal(client.published.length, 1);
  assert.equal(client.freed, 1);
  discovery.tick(B);
  await discovery.publish(B);
  assert.equal(await discovery.resolve(owner.credentials), null);
  await discovery.close();
  assert.equal(client.published.length, 1);
  assert.equal(client.freed, 1);
});
