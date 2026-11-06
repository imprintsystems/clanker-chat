import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, MESSAGE_LIMITS, MessageStorageError } from '../src/store.js';
import { ClankerChat } from '../src/daemon.js';
import { newIdentity, seal } from '../src/protocol.js';

const message = (extra = {}) => ({ id: randomUUID(), thread: randomUUID(), kind: 'message', text: 'hello', createdAt: Date.now(), ...extra });
function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'clanker-retention-')), store = new Store(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  return store;
}
function fillCount(store, peer) {
  const payload = JSON.stringify(message());
  store.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO messages(id,peer,direction,payload,state,stored,bytes)
    SELECT 'seed-'||i,?,'in',json_set(?,'$.id','seed-'||i),'received',?,length(CAST(json_set(?,'$.id','seed-'||i) AS BLOB)) FROM n`)
    .run(MESSAGE_LIMITS.count, peer, payload, Date.now(), payload);
}

test('incoming count quota rejects only the flooding peer, preserving unread history and duplicate receipts', t => {
  const store = setup(t), first = message();
  const existingFriend = message(); store.insert('friend', 'in', existingFriend);
  fillCount(store, 'flooder');
  assert.throws(() => store.insert('flooder', 'in', first), MessageStorageError);
  assert.ok(store.prepare('SELECT id FROM messages WHERE id=? AND read=0').get(existingFriend.id));
  assert.equal(store.insert('friend', 'in', first), true);
  assert.equal(store.insert('friend', 'in', first), false);
  const duplicate = JSON.parse(store.prepare("SELECT payload FROM messages WHERE peer='flooder' LIMIT 1").get().payload);
  assert.equal(store.insert('flooder', 'in', duplicate), false);
  assert.equal(store.prepare("SELECT count(*) AS n FROM messages WHERE peer='flooder' AND read=0").get().n, MESSAGE_LIMITS.count);
  assert.equal(store.insert('flooder', 'out', message()), true, 'incoming limits do not disable local replies');
});

test('incoming byte quota counts UTF-8 JSON bytes including control events and is transactional', t => {
  const store = setup(t), text = '🙂'.repeat(11_000);
  let accepted = 0;
  while (true) {
    try { store.insert('flooder', 'in', message({ text })); accepted++; }
    catch (error) { assert.ok(error instanceof MessageStorageError); break; }
  }
  assert.ok(accepted < MESSAGE_LIMITS.count);
  const before = store.prepare("SELECT count(*) AS n,sum(bytes) AS bytes FROM messages WHERE peer='flooder'").get();
  assert.ok(before.bytes <= MESSAGE_LIMITS.bytes);
  const control = message({ kind: 'discussion', discussion: { type: 'proposal' }, text });
  assert.throws(() => store.transaction(() => {
    store.set('quota-transaction', true);
    store.insert('flooder', 'in', control);
  }), MessageStorageError);
  assert.equal(store.get('quota-transaction'), undefined);
  assert.equal(store.prepare("SELECT count(*) AS n FROM messages WHERE peer='flooder'").get().n, before.n);
  assert.equal(store.insert('friend', 'in', message()), true);
});

test('retention removes only old read ordinary messages and settled outgoing history', t => {
  const store = setup(t), now = Date.now(), old = now - (MESSAGE_LIMITS.days + 1) * 86_400_000;
  const add = (direction, extra = {}, { read = 1, state, age = old, decision = 'pending' } = {}) => {
    const payload = message(extra); store.insert('peer', direction, payload);
    store.prepare('UPDATE messages SET read=?,state=?,stored=?,decision=? WHERE id=?').run(read, state || (direction === 'in' ? 'received' : 'delivered'), age, decision, payload.id);
    return payload.id;
  };
  const removed = [add('in'), add('out'), add('out', {}, { state: 'cancelled' }), add('in', { party: randomUUID() }), add('in', { kind: 'task_request' }, { decision: 'completed' })];
  const kept = [add('in', {}, { read: 0 }), add('in', {}, { age: now }), add('out', {}, { state: 'queued' }), add('in', { kind: 'task_request' }), add('in', { kind: 'task_request' }, { decision: 'approved' })];
  for (const kind of ['discussion', 'bridge']) kept.push(add('in', { kind }), add('out', { kind }));
  removed.push(add('in', { kind: 'party' }), add('out', { kind: 'party' }));
  // Neither a forged old nor future sender clock controls retention.
  kept.push(add('in', { createdAt: 0 }, { age: now }));
  removed.push(add('in', { createdAt: now + 100 * 86_400_000 }));
  assert.equal(store.prune(now), removed.length);
  for (const id of removed) assert.equal(store.prepare('SELECT id FROM messages WHERE id=?').get(id), undefined);
  for (const id of kept) assert.ok(store.prepare('SELECT id FROM messages WHERE id=?').get(id));
  assert.equal(store.prune(now), 0);
});

test('retention preserves old attachment messages so separately retained files stay reachable', t => {
  const store = setup(t), now = Date.now(), old = now - (MESSAGE_LIMITS.days + 1) * 86_400_000;
  const attachment = { id: randomUUID(), name: 'retained.txt', size: 1, sha256: 'a'.repeat(64) };
  for (const direction of ['in', 'out']) {
    const attached = message({ attachment }), ordinary = message();
    store.insert('peer', direction, attached); store.insert('peer', direction, ordinary);
    store.prepare("UPDATE messages SET stored=?,read=1,state=? WHERE direction=?").run(old, direction === 'in' ? 'received' : 'delivered', direction);
    assert.equal(store.prune(now), 1);
    assert.equal(store.prepare('SELECT id FROM messages WHERE id=?').get(ordinary.id), undefined);
    assert.deepEqual(store.list({ direction }).find(row => row.id === attached.id)?.payload.attachment, attachment);
  }
});

test('consumed history frees the unread allowance but all incoming traffic has a total byte backstop', t => {
  const store = setup(t);
  fillCount(store, 'busy');
  store.prepare("UPDATE messages SET read=1 WHERE peer='busy'").run();
  assert.equal(store.insert('busy', 'in', message()), true, 'a busy consumed history is not a permanently full inbox');
  // Seed accounting at the backstop without allocating a 256 MiB test fixture.
  const seed = message(); store.insert('full', 'in', seed);
  store.prepare('UPDATE messages SET read=1,bytes=? WHERE id=?').run(MESSAGE_LIMITS.totalBytes, seed.id);
  assert.throws(() => store.insert('full', 'in', message({ kind: 'bridge', bridgeEvent: { type: 'note' } })), MessageStorageError);
  assert.equal(store.insert('other', 'in', message()), true);
  store.prepare('UPDATE messages SET stored=? WHERE id=?').run(Date.now() - (MESSAGE_LIMITS.days + 1) * 86_400_000, seed.id);
  assert.equal(store.prune(), 1);
  assert.equal(store.insert('full', 'in', message()), true, 'retention restores the total allowance');
});

test('retention expires finished feature history without breaking live transcripts or bridge answer dependencies', t => {
  const store = setup(t), now = Date.now(), old = now - (MESSAGE_LIMITS.days + 1) * 86_400_000;
  const kept = [], removed = [];
  function add(direction, extra, { age = old, state = direction === 'in' ? 'received' : 'delivered' } = {}) {
    const payload = message(extra); store.insert('peer', direction, payload);
    store.prepare('UPDATE messages SET stored=?,read=1,state=? WHERE id=?').run(age, state, payload.id);
    return payload.id;
  }
  for (const [state, seen] of [['active', 0], ['completed', 0], ['completed', 1]]) {
    const id = randomUUID();
    store.prepare("INSERT INTO discussions(id,peer,role,state,proposal,lastId,expiresAt,maxTurns,seen) VALUES (?,'peer','recipient',?,'{}',?,?,10,?)").run(id, state, id, old, seen);
    const event = add('in', { kind: 'discussion', thread: id, discussion: { type: 'reply' } });
    (state === 'completed' && seen ? removed : kept).push(event);
  }
  const bridge = randomUUID();
  store.prepare("INSERT INTO bridges(id,peer,role,state,topic,created) VALUES (?,'peer','recipient','active','topic',?)").run(bridge, old);
  const bridgeEvent = (type, extra = {}) => ({ kind: 'bridge', thread: bridge, bridge, bridgeEvent: { type }, ...extra });
  const answered = add('in', bridgeEvent('ask'));
  removed.push(answered, add('out', bridgeEvent('answer', { replyTo: answered })), add('in', bridgeEvent('note')));
  kept.push(add('in', bridgeEvent('ask')), add('out', bridgeEvent('ask')));
  const queued = add('in', bridgeEvent('ask'));
  kept.push(queued, add('out', bridgeEvent('answer', { replyTo: queued }), { state: 'queued' }));
  const recent = add('in', bridgeEvent('ask'));
  kept.push(recent, add('out', bridgeEvent('answer', { replyTo: recent }), { age: now }));
  const running = add('in', bridgeEvent('ask'));
  kept.push(running, add('out', bridgeEvent('answer', { replyTo: running })));
  store.prepare("INSERT INTO bridge_runs(ask,bridge,state,created) VALUES (?,?,'running',?)").run(running, bridge, old);
  const closed = randomUUID();
  store.prepare("INSERT INTO bridges(id,peer,role,state,topic,created) VALUES (?,'peer','recipient','closed','closed',?)").run(closed, old);
  removed.push(add('in', { ...bridgeEvent('ask'), thread: closed, bridge: closed }));
  const party = randomUUID();
  store.prepare("INSERT INTO parties(id,name,owner,state,created) VALUES (?,'party','peer','closed',?)").run(party, old);
  removed.push(add('in', { kind: 'party', party, thread: party, partyEvent: { type: 'close' } }));
  assert.equal(store.prune(now), removed.length);
  for (const id of removed) assert.equal(store.prepare('SELECT id FROM messages WHERE id=?').get(id), undefined);
  for (const id of kept) assert.ok(store.prepare('SELECT id FROM messages WHERE id=?').get(id));
  assert.ok(store.prepare('SELECT id FROM bridges WHERE id=?').get(bridge));
  assert.equal(store.prepare('SELECT id FROM bridges WHERE id=?').get(closed), undefined);
  assert.equal(store.prepare('SELECT id FROM parties WHERE id=?').get(party), undefined);
  assert.equal(store.prepare("SELECT count(*) AS n FROM discussions WHERE state='completed' AND seen=1").get().n, 0);
});

test('legacy history migrates byte accounting with a local retention grace period', t => {
  const home = mkdtempSync(join(tmpdir(), 'clanker-retention-legacy-')), payload = message({ text: '🙂' });
  const db = new DatabaseSync(join(home, 'inbox.db'));
  db.exec(`CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, peer TEXT NOT NULL, direction TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER NOT NULL DEFAULT 0, error TEXT, read INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL DEFAULT 'pending')`);
  db.prepare("INSERT INTO messages(id,peer,direction,payload,state,read) VALUES (?,'peer','in',?,'received',1)").run(payload.id, JSON.stringify(payload));
  db.close();
  const before = Date.now(), store = new Store(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const row = store.prepare('SELECT bytes,stored FROM messages').get();
  assert.equal(row.bytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.ok(row.stored >= before && row.stored <= Date.now());
  assert.equal(store.prune(), 0);
  store.close();
  const reopened = new Store(home);
  store.close = () => reopened.close();
  assert.equal(reopened.prepare('SELECT stored FROM messages').get().stored, row.stored);
});

test('authenticated message receive returns HTTP 507 for one full contact and accepts another', async t => {
  const home = mkdtempSync(join(tmpdir(), 'clanker-retention-http-'));
  const daemon = await new ClankerChat({ home, local: true, discovery: false }).start();
  t.after(async () => { await daemon.close(); rmSync(home, { recursive: true, force: true }); });
  const flooder = newIdentity('Flooder'), friend = newIdentity('Friend');
  for (const peer of [flooder, friend]) daemon.store.savePeer(peer.public, 'http://127.0.0.1:1');
  fillCount(daemon.store, flooder.public.id);
  const receive = peer => fetch(`${daemon.origin}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seal(peer, daemon.store.identity.public, 'message', message())) });
  const rejected = await receive(flooder);
  assert.equal(rejected.status, 507);
  assert.match((await rejected.json()).error, /storage limit.*contact/);
  const accepted = await receive(friend);
  assert.equal(accepted.status, 200); await accepted.body.cancel();
  assert.equal(daemon.store.prepare("SELECT count(*) AS n FROM messages WHERE peer=? AND direction='in'").get(friend.public.id).n, 1);
  assert.equal(daemon.store.prepare("SELECT count(*) AS n FROM messages WHERE peer=? AND direction='in'").get(flooder.public.id).n, MESSAGE_LIMITS.count);
});
