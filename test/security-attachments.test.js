import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Attachments, INCOMING_IDLE_MS, MAX_PEER_TRANSFERS, MAX_PEER_RETAINED_SIZE } from '../src/attachments.js';
import { ClankerChat } from '../src/daemon.js';
import { MAX_FILE_SIZE, seal, post } from '../src/protocol.js';

const attachmentFor = (bytes = Buffer.alloc(0), overrides = {}) => ({ id: randomUUID(), name: 'file.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...overrides });
const begin = attachment => ({ type: 'begin', attachment });
const finish = attachment => ({ type: 'finish', id: attachment.id });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-security-attachments-')), stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  function make(name, withEngine = true) {
    const home = join(root, name), store = new Store(home, name);
    stores.push(store);
    return { home, store, peer: { id: store.identity.public.id, identity: store.identity.public }, ...(withEngine ? { engine: new Attachments(home, store, options) } : {}) };
  }
  return { root, make };
}
async function complete(engine, peer, attachment, bytes = Buffer.alloc(0)) {
  await engine.receive(peer, begin(attachment));
  if (bytes.length) await engine.receive(peer, { type: 'chunk', id: attachment.id, offset: 0, data: bytes.toString('base64') });
  await engine.receive(peer, finish(attachment));
}
const messageFor = attachment => ({ id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'A file', createdAt: Date.now(), attachment });

test('four maximum declared begins from one contact cannot consume another contact allowance', async t => {
  const { make } = fixture(t), source = make('source'), honest = make('honest'), target = make('target');
  let accepted = 0;
  for (let index = 0; index < 4; index++) {
    try { await target.engine.receive(source.peer, begin(attachmentFor(undefined, { size: MAX_FILE_SIZE }))); accepted++; }
    catch (error) { assert.match(error.message, /Contact incoming attachment allowance/); }
  }
  assert.equal(accepted, 1);
  assert.equal((await target.engine.receive(honest.peer, begin(attachmentFor(Buffer.from('x'))))).offset, 0);
  assert.equal(readdirSync(join(target.home, 'files')).length, 2);
});

test('idle incoming transfers expire rows and files while activity renews the idle deadline', async t => {
  let now = 1_000_000;
  const { make } = fixture(t, { now: () => now }), source = make('source'), target = make('target');
  const idle = attachmentFor(Buffer.from('a')), active = attachmentFor(Buffer.from('b')), done = attachmentFor();
  await target.engine.receive(source.peer, begin(idle));
  await target.engine.receive(source.peer, begin(active));
  await complete(target.engine, source.peer, done);
  const idlePath = target.engine.path(target.engine.row('in', source.peer.id, idle.id));
  const donePath = target.engine.path(target.engine.row('in', source.peer.id, done.id));
  now += INCOMING_IDLE_MS - 1;
  await target.engine.receive(source.peer, begin(active));
  now += 1;
  // Starting any transfer opportunistically reclaims expired reservations.
  await target.engine.receive(source.peer, begin(attachmentFor()));
  assert.equal(target.engine.row('in', source.peer.id, idle.id), undefined);
  assert.equal(existsSync(idlePath), false);
  assert.equal(target.engine.row('in', source.peer.id, active.id).updated_at, now - 1);
  assert.equal(existsSync(donePath), true);
  now += INCOMING_IDLE_MS;
  target.engine = new Attachments(target.home, target.store, { now: () => now });
  assert.equal(target.engine.row('in', source.peer.id, active.id), undefined);
  assert.equal(existsSync(donePath), true);
});

test('zero-byte incomplete transfers consume the per-contact count limit', async t => {
  const { make } = fixture(t), source = make('source'), honest = make('honest'), target = make('target');
  for (let index = 0; index < MAX_PEER_TRANSFERS; index++) await target.engine.receive(source.peer, begin(attachmentFor()));
  await assert.rejects(target.engine.receive(source.peer, begin(attachmentFor())), /Contact incoming attachment allowance/);
  assert.equal(readdirSync(join(target.home, 'files')).length, MAX_PEER_TRANSFERS);
  await target.engine.receive(honest.peer, begin(attachmentFor()));
});

test('completed retention is per-contact and cannot consume the global partial quota', async t => {
  const { make } = fixture(t), source = make('source'), honest = make('honest'), target = make('target');
  const attachment = attachmentFor();
  await complete(target.engine, source.peer, attachment);
  // Seed quota accounting without allocating a GiB of test data.
  target.store.prepare("UPDATE attachment_transfers SET size=? WHERE direction='in' AND peer=? AND id=?").run(MAX_PEER_RETAINED_SIZE, source.peer.id, attachment.id);
  await assert.rejects(target.engine.receive(source.peer, begin(attachmentFor())), /retention allowance/);
  await target.engine.receive(honest.peer, begin(attachmentFor(Buffer.from('x'))));
});

test('revocation removes incomplete files and releases retained quota without deleting received files', async t => {
  const { root, make } = fixture(t), source = make('source'), target = make('target');
  target.store.savePeer(source.peer.identity, 'http://127.0.0.1:1');
  const partial = attachmentFor(undefined, { size: MAX_FILE_SIZE }), bytes = Buffer.from('keep this'), done = attachmentFor(bytes);
  await complete(target.engine, source.peer, done, bytes);
  await target.engine.receive(source.peer, begin(partial));
  const partialPath = target.engine.path(target.engine.row('in', source.peer.id, partial.id));
  const donePath = target.engine.path(target.engine.row('in', source.peer.id, done.id));
  target.store.revoke(source.peer.id);
  assert.equal(target.engine.row('in', source.peer.id, partial.id), undefined);
  assert.equal(existsSync(partialPath), false);
  assert.equal(existsSync(donePath), true);
  assert.equal(target.engine.row('in', source.peer.id, done.id).quota_released, 1);
  assert.equal(await target.engine.save(source.peer.id, done, join(root, 'saved.bin')), join(root, 'saved.bin'));
  target.engine = new Attachments(target.home, target.store);
  assert.equal(target.engine.row('in', source.peer.id, partial.id), undefined);
  assert.equal(existsSync(donePath), true);
});

test('completed attachments hash once, bind to one accepted message and allow identical retries', async t => {
  const { make } = fixture(t), source = make('source'), target = make('target');
  const bytes = Buffer.from('hash exactly once'), attachment = attachmentFor(bytes);
  let hashes = 0;
  const digest = target.engine.digest.bind(target.engine);
  target.engine.digest = async (...args) => { hashes++; return digest(...args); };
  await complete(target.engine, source.peer, attachment, bytes);
  await target.engine.receive(source.peer, finish(attachment));
  const message = messageFor(attachment);
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  const accept = payload => target.engine.acceptReceived(source.peer.id, attachment, undefined, payload.id, () => target.store.insert(source.peer.id, 'in', payload));
  assert.equal(accept(message), true);
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  assert.equal(accept(message), false);
  const replay = { ...message, id: randomUUID() };
  await assert.rejects(target.engine.verifyReceived(source.peer.id, attachment, undefined, replay.id), /another message/);
  assert.throws(() => accept(replay), /another message/);
  assert.equal(hashes, 1);
  assert.equal(target.store.list().length, 1);
  // Inbox retention must not reopen an already accepted transfer for reuse.
  target.store.prepare('DELETE FROM messages WHERE id=?').run(message.id);
  await assert.rejects(target.engine.verifyReceived(source.peer.id, attachment, undefined, replay.id), /another message/);
});

test('failed message insertion does not consume an attachment binding', async t => {
  const { make } = fixture(t), source = make('source'), target = make('target'), attachment = attachmentFor();
  await complete(target.engine, source.peer, attachment);
  const failed = messageFor(attachment);
  assert.throws(() => target.engine.acceptReceived(source.peer.id, attachment, undefined, failed.id, () => { throw new Error('Insertion refused'); }), /Insertion refused/);
  assert.equal(target.engine.row('in', source.peer.id, attachment.id).message_id, null);
  const accepted = messageFor(attachment);
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, accepted.id);
  target.engine.acceptReceived(source.peer.id, attachment, undefined, accepted.id, () => target.store.insert(source.peer.id, 'in', accepted));
  assert.equal(target.engine.row('in', source.peer.id, attachment.id).message_id, accepted.id);
});

test('legacy completed rows migrate ownership and cache verification once across reconstruction', async t => {
  let now = 5_000_000;
  const { make } = fixture(t), source = make('source'), target = make('target', false);
  target.store.db.exec(`CREATE TABLE attachment_transfers (
    direction TEXT NOT NULL, peer TEXT NOT NULL, id TEXT NOT NULL, party TEXT NOT NULL,
    name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, offset INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(direction,peer,id))`);
  const bytes = Buffer.from('legacy'), attachment = attachmentFor(bytes), token = randomUUID(), message = messageFor(attachment);
  target.store.prepare('INSERT INTO attachment_transfers VALUES (?,?,?,?,?,?,?,?,?,?)').run('in', source.peer.id, attachment.id, '', attachment.name, bytes.length, attachment.sha256, token, bytes.length, 1);
  target.store.insert(source.peer.id, 'in', message);
  target.engine = new Attachments(target.home, target.store, { now: () => now });
  writeFileSync(target.engine.path({ token }), bytes);
  const migrated = target.engine.row('in', source.peer.id, attachment.id);
  assert.equal(migrated.created_at, now);
  assert.equal(migrated.updated_at, now);
  assert.equal(migrated.message_id, message.id);
  let hashes = 0;
  const digest = target.engine.digest.bind(target.engine);
  target.engine.digest = async (...args) => { hashes++; return digest(...args); };
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  assert.equal(hashes, 1);
  now++;
  target.engine = new Attachments(target.home, target.store, { now: () => now });
  target.engine.digest = async () => { throw new Error('Unexpected rehash'); };
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  await assert.rejects(target.engine.verifyReceived(source.peer.id, attachment, undefined, randomUUID()), /another message/);
});

test('save rejects direction and control characters instead of silently rewriting paths', async t => {
  const { root, make } = fixture(t), source = make('source'), target = make('target'), attachment = attachmentFor();
  await complete(target.engine, source.peer, attachment);
  for (const name of ['bad\u202efile', 'bad\u009bfile', 'bad\nfile']) {
    const destination = join(root, name);
    await assert.rejects(target.engine.save(source.peer.id, attachment, destination), /direction or control/);
    assert.equal(existsSync(destination), false);
  }
});

test('authenticated message route rejects attachment metadata replay and accepts same-message redelivery without rehashing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-security-attachment-route-')), people = [];
  t.after(async () => { for (const person of people) await person.close(); rmSync(root, { recursive: true, force: true }); });
  const a = await new ClankerChat({ home: join(root, 'a'), name: 'Alice', local: true }).start(); people.push(a);
  const b = await new ClankerChat({ home: join(root, 'b'), name: 'Bob', local: true }).start(); people.push(b);
  await b.command('pair', { code: (await a.command('invite')).code });
  const bytes = Buffer.from('wire file'), attachment = attachmentFor(bytes);
  const upload = data => post(b.origin, '/v1/attachments', seal(a.store.identity, b.store.identity.public, 'attachment', data), true);
  let hashes = 0;
  const digest = b.attachments.digest.bind(b.attachments);
  b.attachments.digest = async (...args) => { hashes++; return digest(...args); };
  await upload(begin(attachment));
  await upload({ type: 'chunk', id: attachment.id, offset: 0, data: bytes.toString('base64') });
  await upload(finish(attachment));
  const message = messageFor(attachment);
  const deliver = payload => post(b.origin, '/v1/messages', seal(a.store.identity, b.store.identity.public, 'message', payload), true);
  await deliver(message);
  await deliver(message);
  await assert.rejects(deliver({ ...message, id: randomUUID() }));
  assert.equal(hashes, 1);
  assert.deepEqual(b.store.list().map(row => row.id), [message.id]);
});

test('revocation during a pending finish cannot recreate an incomplete file or row', async t => {
  const { make } = fixture(t), source = make('source'), target = make('target'), attachment = attachmentFor();
  target.store.savePeer(source.peer.identity, 'http://127.0.0.1:1');
  target.engine.allowed = () => { if (target.store.peer(source.peer.id).revoked) throw new Error('Peer revoked'); };
  await target.engine.receive(source.peer, begin(attachment));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(release);
  const digest = target.engine.digest.bind(target.engine);
  target.engine.digest = async (...args) => { entered(); await gate; return digest(...args); };
  const pending = target.engine.receive(source.peer, finish(attachment));
  await started;
  target.store.revoke(source.peer.id);
  release();
  await assert.rejects(pending, /Peer revoked/);
  assert.equal(target.engine.row('in', source.peer.id, attachment.id), undefined);
  assert.deepEqual(readdirSync(join(target.home, 'files')), []);
});

test('legacy attachment filenames match neutralized incoming metadata', async t => {
  const { make } = fixture(t), source = make('source'), target = make('target'), attachment = attachmentFor();
  await complete(target.engine, source.peer, attachment);
  target.store.prepare("UPDATE attachment_transfers SET name=? WHERE direction='in' AND peer=? AND id=?").run('fi\u202ele.bin', source.peer.id, attachment.id);
  assert.deepEqual(await target.engine.verifyReceived(source.peer.id, attachment), attachment);
  assert.equal((await target.engine.receive(source.peer, begin(attachment))).complete, true);
});

test('interrupted ownership migration resumes when columns exist but the completion marker is absent', async t => {
  const { make } = fixture(t), source = make('source'), target = make('target', false);
  // Simulate a previous startup committing the schema before its backfill.
  target.store.db.exec(`CREATE TABLE attachment_transfers (
    direction TEXT NOT NULL, peer TEXT NOT NULL, id TEXT NOT NULL, party TEXT NOT NULL,
    name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, offset INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    quota_released INTEGER NOT NULL DEFAULT 0, verified_state TEXT, message_id TEXT,
    message_bound INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(direction,peer,id))`);
  const bytes = Buffer.from('interrupted upgrade'), attachment = attachmentFor(bytes), token = randomUUID(), message = messageFor(attachment);
  target.store.prepare('INSERT INTO attachment_transfers (direction,peer,id,party,name,size,sha256,token,offset,complete) VALUES (?,?,?,?,?,?,?,?,?,?)').run('in', source.peer.id, attachment.id, '', attachment.name, bytes.length, attachment.sha256, token, bytes.length, 1);
  target.store.insert(source.peer.id, 'in', message);
  assert.equal(target.store.get('attachment_message_ownership_migrated'), undefined);
  target.engine = new Attachments(target.home, target.store);
  writeFileSync(target.engine.path({ token }), bytes);
  const migrated = target.engine.row('in', source.peer.id, attachment.id);
  assert.equal(migrated.message_id, message.id);
  assert.equal(migrated.message_bound, 1);
  assert.equal(target.store.get('attachment_message_ownership_migrated'), true);
  await target.engine.verifyReceived(source.peer.id, attachment, undefined, message.id);
  await assert.rejects(target.engine.verifyReceived(source.peer.id, attachment, undefined, randomUUID()), /another message/);
  target.engine = new Attachments(target.home, target.store);
  assert.equal(target.engine.row('in', source.peer.id, attachment.id).message_id, message.id);
});
