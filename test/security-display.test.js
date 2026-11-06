import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { ClankerChat } from '../src/daemon.js';
import { Bridges } from '../src/bridges.js';
import { Parties } from '../src/parties.js';
import { Discussions } from '../src/discussions.js';
import { Attachments } from '../src/attachments.js';
import { Notifications } from '../src/notifications.js';
import { clientGrant, enableClient } from '../src/access.js';
import { messageSchema, attachmentSchema, boxKeySchema, partyName, bridgeAgent, bridgeTopic, newIdentity, validateIdentity, seal, open, post, encodeInvite, decodeInvite } from '../src/protocol.js';
import { overview, fullMessage, summarize, peerNames, inboxNote } from '../src/overview.js';
import { clean, printResult } from '../src/terminal.js';
import { displayText, displayJson, iso, MAX_TIMESTAMP } from '../src/display.js';

const message = overrides => ({ id: randomUUID(), kind: 'message', text: 'Hello', thread: randomUUID(), createdAt: Date.now(), ...overrides });
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-security-display-'));
  const store = new Store(home, 'Local');
  const sender = newIdentity('Remote');
  store.savePeer(sender.public, 'http://127.0.0.1:1');
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, store, sender };
}
function capture(fn) {
  const output = [], original = console.log;
  console.log = (...args) => output.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return output.join('\n');
}

test('all remote timestamp schemas reject values outside the Date range without rejecting old dates', () => {
  for (const createdAt of [Number.MAX_SAFE_INTEGER, Infinity, 0, -1, 1.5]) assert.equal(messageSchema.safeParse(message({ createdAt })).success, false);
  for (const createdAt of [1, Date.now(), MAX_TIMESTAMP]) assert.equal(messageSchema.parse(message({ createdAt })).createdAt, createdAt);
  const discussion = { type: 'proposal', question: 'Question', scope: 'supplied-evidence-only', maxTurns: 2, expiresAt: Number.MAX_SAFE_INTEGER };
  assert.equal(messageSchema.safeParse(message({ kind: 'discussion', discussion })).success, false);
  assert.equal(boxKeySchema.safeParse({ key: 'a'.repeat(40), from: Number.MAX_SAFE_INTEGER, signature: '' }).success, false);
  const alice = newIdentity('Alice'), bob = newIdentity('Bob');
  const envelope = seal(alice, bob.public, 'message', message());
  assert.throws(() => open(bob, { ...envelope, at: Number.MAX_SAFE_INTEGER }, alice.public, 'message', { checkTime: false }));
  assert.throws(() => decodeInvite(encodeInvite({ v: 1, identity: alice.public, endpoint: 'http://127.0.0.1:1234', token: 'a'.repeat(64), expires: Number.MAX_SAFE_INTEGER }), true));
  for (const bad of [Number.MAX_SAFE_INTEGER, NaN, Infinity, -1, 0, '1', null]) assert.equal(iso(bad), null);
});

test('authenticated receive rejects an out-of-range createdAt before persisting it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-security-time-receive-'));
  const daemon = await new ClankerChat({ home, name: 'Receiver', local: true, discovery: false, updateCheck: false }).start();
  t.after(async () => { await daemon.close(); rmSync(home, { recursive: true, force: true }); });
  clearInterval(daemon.timer);
  const sender = newIdentity('Sender');
  daemon.store.savePeer(sender.public, 'http://127.0.0.1:1');
  const poison = message({ createdAt: Number.MAX_SAFE_INTEGER });
  await assert.rejects(post(daemon.origin, '/v1/messages', seal(sender, daemon.store.identity.public, 'message', poison), true), /HTTP 400/);
  assert.equal(daemon.store.prepare('SELECT 1 FROM messages WHERE id=?').get(poison.id), undefined);
});

test('legacy invalid timestamps cannot poison overview, inbox, full message or bridge views', t => {
  const { store, sender } = fixture(t);
  const poison = message({ createdAt: Number.MAX_SAFE_INTEGER });
  store.insert(sender.public.id, 'in', poison);
  store.insert(sender.public.id, 'in', message({ kind: 'task_request', createdAt: Number.MAX_SAFE_INTEGER }));
  const result = overview(store, { expire() {} }, { online: false });
  assert.equal(result.messages[0].at, null);
  assert.equal(result.approvals[0].at, null);
  assert.equal(fullMessage(store, poison.id).at, null);
  const inbox = store.list().map(row => summarize(row, peerNames(store)));
  assert.ok(inbox.every(row => row.at === null));
  assert.doesNotThrow(() => capture(() => printResult('inbox', store.list(), { peers: store.peers() })));

  const bridges = new Bridges(store), bridge = randomUUID();
  store.prepare("INSERT INTO bridges (id,peer,role,state,topic,localAgent,remoteAgent,runner,created,digestAt) VALUES (?,?,'recipient','active','Topic','Local','Remote',?,?,?)").run(bridge, sender.public.id, JSON.stringify({ app: 'self' }), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  store.insert(sender.public.id, 'in', message({ kind: 'bridge', thread: bridge, bridge, bridgeEvent: { type: 'ask' }, createdAt: Number.MAX_SAFE_INTEGER }));
  const view = bridges.get(bridge);
  assert.equal(view.since, null);
  assert.equal(view.transcript[0].at, null);
  assert.equal(view.unanswered[0].at, null);
  assert.equal(bridges.wait({ bridge })[0].at, null);
  assert.doesNotThrow(() => capture(() => printResult('bridge', view)));
});

test('names and filenames strip bidi controls while legacy identities still validate', t => {
  const { store, sender } = fixture(t);
  const spoof = 'Safe\u202e\u2066\u200f\u061c\u009fName';
  assert.equal(validateIdentity({ ...sender.public, name: spoof }).name, 'SafeName');
  assert.equal(validateIdentity({ ...sender.public, name: '\u202e' }).name, '?');
  assert.equal(newIdentity(spoof).public.name, 'SafeName');
  for (const schema of [partyName, bridgeAgent, bridgeTopic]) assert.equal(schema.parse(spoof), 'SafeName');
  assert.equal(store.nickname(sender.public.id, spoof).nickname, 'SafeName');
  const attachment = { id: randomUUID(), name: 'invoice\u202e\u009f.exe', size: 0, sha256: '0'.repeat(64) };
  assert.equal(attachmentSchema.parse(attachment).name, 'invoice.exe');
  for (const name of ['../invoice', 'a/b', 'a\\b', 'bad\0file', 'line\nfile']) assert.equal(attachmentSchema.safeParse({ ...attachment, name }).success, false);
});

test('terminal, JSON tool output and notification notes neutralize controls without changing stored bodies', async t => {
  const { home, store, sender } = fixture(t);
  const spoof = 'Contact\u202e\u2069\u200e\u061c\u009f';
  store.prepare('UPDATE peers SET identity=?,nickname=? WHERE id=?').run(JSON.stringify({ ...sender.public, name: spoof }), spoof, sender.public.id);
  const text = 'first\u202e\u2066\u009f\u001b[31m line\nsecond\tline';
  const payload = message({ text, attachment: { id: randomUUID(), name: 'bill\u202e.exe', size: 1, sha256: '0'.repeat(64) } });
  store.insert(sender.public.id, 'in', payload);
  assert.doesNotMatch(clean(spoof), controls);
  const terminal = capture(() => {
    printResult('peers', store.peers());
    printResult('inbox', store.list(), { peers: store.peers() });
    printResult('party', { id: randomUUID(), name: spoof, owner: spoof, state: 'invited', members: [{ name: spoof }] });
    printResult('bridge', { id: randomUUID(), with: spoof, yourAgent: spoof, theirAgent: spoof, topic: spoof, state: 'active', today: { sent: 0, limit: 30 }, transcript: [{ from: spoof, type: 'note', text, at: null }] });
  });
  assert.doesNotMatch(terminal, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u009f]/);
  const shown = fullMessage(store, payload.id);
  assert.doesNotMatch(shown.text, controls);
  assert.match(shown.text, /\nsecond\tline/);
  assert.equal(shown.attachment.name, 'bill.exe');
  const tool = JSON.parse(displayJson({ peers: store.peers(), messages: store.list() }));
  assert.doesNotMatch(tool.peers[0].identity.name, controls);
  assert.doesNotMatch(tool.messages[0].payload.text, controls);
  assert.doesNotMatch(inboxNote(store), controls);
  enableClient(home, 'claude', clientGrant(home, 'claude', 'Claude'));
  const notifications = new Notifications(home, store);
  const notice = notifications.notice({ client: 'claude', session: randomUUID() });
  assert.doesNotMatch(notice.additionalContext, controls);
  await notifications.close();
  assert.equal(JSON.parse(store.prepare('SELECT payload FROM messages WHERE id=?').get(payload.id).payload).text, text);
  assert.equal(displayText('a\nb\tc', { multiline: true }), 'a\nb\tc');
});

test('received filenames are safe and save refuses bidi or control characters in explicit destinations', async t => {
  const { home, store, sender } = fixture(t), engine = new Attachments(home, store);
  const peer = { id: sender.public.id, identity: sender.public };
  const raw = { id: randomUUID(), name: 'invoice\u202e\u009f.exe', size: 0, sha256: createHash('sha256').update('').digest('hex') };
  await engine.receive(peer, { type: 'begin', attachment: raw });
  await engine.receive(peer, { type: 'finish', id: raw.id });
  assert.equal(engine.row('in', peer.id, raw.id).name, 'invoice.exe');
  // A pre-upgrade transfer may still have its original name in the database.
  store.prepare("UPDATE attachment_transfers SET name=? WHERE direction='in' AND peer=? AND id=?").run(raw.name, peer.id, raw.id);
  for (const name of ['invoice\u202e.exe', 'invoice\u009f.exe', 'invoice\n.exe']) {
    const path = join(home, name);
    await assert.rejects(engine.save(peer.id, raw, path), /direction or control/);
    assert.equal(existsSync(path), false);
  }
  const path = join(home, attachmentSchema.parse(raw).name);
  assert.equal(await engine.save(peer.id, raw, path), path);
  assert.equal(existsSync(path), true);
});

test('legacy sanitized-name redeliveries deduplicate across all receive paths without rewriting stored payloads', t => {
  const { home, store, sender } = fixture(t);
  const parties = new Parties(store), bridges = new Bridges(store), discussions = new Discussions(home, store);
  const bridge = randomUUID(), party = randomUUID();
  const cases = [
    [message({ attachment: { id: randomUUID(), name: 'invoice\u202e.exe', size: 0, sha256: '0'.repeat(64) } }), payload => store.insert(sender.public.id, 'in', payload)],
    [message({ kind: 'party', party, partyEvent: { type: 'invite', name: 'Team\u202e', invitation: randomUUID(), members: [{ ...sender.public, name: 'Remote\u202e' }] } }), payload => parties.receive(sender.public.id, payload)],
    [message({ kind: 'bridge', bridge, thread: bridge, bridgeEvent: { type: 'propose', agent: 'Agent\u202e', topic: 'Topic\u202e' } }), payload => bridges.receive(sender.public.id, payload)],
    [message({ kind: 'discussion', discussion: { type: 'proposal', question: 'Question', scope: 'supplied-evidence-only', maxTurns: 2, expiresAt: Date.now() + 60_000 } }), payload => discussions.receive(sender.public.id, payload)]
  ];
  for (const [original, receive] of cases) {
    const raw = Object.fromEntries(Object.entries(original).reverse());
    store.insert(sender.public.id, 'in', raw);
    const before = store.prepare('SELECT * FROM messages WHERE id=?').get(raw.id);
    const canonical = messageSchema.parse(raw);
    assert.equal(receive(canonical), false);
    assert.deepEqual(store.prepare('SELECT * FROM messages WHERE id=?').get(raw.id), before);
    assert.throws(() => receive({ ...canonical, text: 'Different content' }), /Message ID collision/);
    assert.throws(() => store.insert('other-peer', 'in', canonical), /Message ID collision/);
    assert.throws(() => store.insert(sender.public.id, 'out', canonical), /Message ID collision/);
  }
  const invalid = message({ unexpected: 'legacy unknown field' });
  store.insert(sender.public.id, 'in', invalid);
  const { unexpected, ...otherwiseValid } = invalid;
  assert.throws(() => store.insert(sender.public.id, 'in', messageSchema.parse(otherwiseValid)), /Message ID collision/);
});
