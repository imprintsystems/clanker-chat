import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { seal, post } from '../src/protocol.js';
import { localCall } from '../src/local.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error('File delivery timed out');
}
async function fixture(t, names = ['Alice', 'Bob']) {
  const root = mkdtempSync(join(tmpdir(), 'clanker-files-'));
  const people = {};
  t.after(async () => { for (const person of Object.values(people)) await person.close(); rmSync(root, { recursive: true, force: true }); });
  for (const name of names) people[name] = await new ClankerChat({ home: join(root, name), name, local: true }).start();
  for (const name of names.slice(1)) await people[name].command('pair', { code: (await people.Alice.command('invite')).code });
  return { root, people };
}

test('a binary attachment crosses chunk boundaries and becomes saveable only after verified delivery', async t => {
  const { root, people: { Alice: a, Bob: b } } = await fixture(t);
  const bytes = randomBytes(180_017), file = join(root, 'clip.mp4'), destination = join(root, 'saved.mp4');
  writeFileSync(file, bytes);
  const sent = await localCall(a.options.home, 'send', { to: 'Bob', file, text: 'Review this clip.' });
  await until(() => a.store.list({ direction: 'out' }).find(row => row.id === sent.id)?.state === 'delivered');
  const message = await b.command('message', { id: sent.id });
  assert.equal(message.attachment.name, 'clip.mp4');
  assert.equal(message.attachment.size, bytes.length);
  assert.equal(message.attachment.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(message.text, 'Review this clip.');
  assert.equal(existsSync(destination), false);
  await localCall(b.options.home, 'save_file', { id: sent.id, path: destination });
  assert.deepEqual(readFileSync(destination), bytes);
  await assert.rejects(localCall(b.options.home, 'save_file', { id: sent.id, path: destination }));
  const forged = { ...b.store.list()[0].payload, id: randomUUID(), attachment: { ...sent.attachment, sha256: '0'.repeat(64) } };
  await assert.rejects(post(b.origin, '/v1/messages', seal(a.store.identity, b.store.identity.public, 'message', forged), true));
  assert.deepEqual(b.store.list().map(row => row.id), [sent.id]);
});

test('an offline attachment snapshots the original bytes and survives both inboxes restarting', async t => {
  const f = await fixture(t), { root, people } = f;
  const original = randomBytes(70_001), file = join(root, 'original.bin');
  writeFileSync(file, original);
  await people.Bob.close();
  const sent = await people.Alice.command('send', { to: 'Bob', file });
  writeFileSync(file, 'changed after enqueue');
  await people.Alice.close();
  people.Alice = await new ClankerChat({ ...people.Alice.options }).start();
  people.Bob = await new ClankerChat({ ...people.Bob.options }).start();
  await people.Bob.command('pair', { code: (await people.Alice.command('invite')).code });
  await people.Alice.command('retry');
  await until(() => people.Alice.store.list({ direction: 'out' }).find(row => row.id === sent.id)?.state === 'delivered');
  const destination = join(root, 'restored.bin');
  await people.Bob.command('save_file', { id: sent.id, path: destination });
  assert.deepEqual(readFileSync(destination), original);
});

test('party-only contacts exchange files inside their party and cannot upload directly or after removal', async t => {
  const { root, people: { Alice: a, Bob: b, Carol: c } } = await fixture(t, ['Alice', 'Bob', 'Carol']);
  const party = await a.command('party', { action: 'create', name: 'Clips' });
  for (const contact of ['Bob', 'Carol']) await a.command('party', { action: 'add', party: party.id, contact });
  await until(() => b.parties.list().some(row => row.state === 'invited') && c.parties.list().some(row => row.state === 'invited'));
  await b.command('party_join', { party: party.id }); await c.command('party_join', { party: party.id });
  await until(() => b.parties.row(party.id).members.length === 3 && c.parties.row(party.id).members.length === 3);
  const bytes = randomBytes(55_002), file = join(root, 'shared.bin'); writeFileSync(file, bytes);
  const sent = await b.command('send', { party: party.id, file });
  await until(() => c.store.list().some(row => sent.ids.includes(row.id)) && a.store.list().some(row => sent.ids.includes(row.id)));
  const incoming = c.store.list().find(row => sent.ids.includes(row.id));
  const destination = join(root, 'party.bin'); await c.command('save_file', { id: incoming.id, path: destination });
  assert.deepEqual(readFileSync(destination), bytes);
  const attachment = { ...sent.attachment, id: randomUUID() };
  const upload = data => post(c.origin, '/v1/attachments', seal(b.store.identity, c.store.identity.public, 'attachment', data), true);
  await assert.rejects(upload({ type: 'begin', attachment }));
  await a.command('party', { action: 'remove', party: party.id, member: 'Bob' });
  await until(() => !c.parties.row(party.id).members.some(member => member.id === b.store.identity.public.id));
  await assert.rejects(upload({ type: 'begin', attachment, party: party.id }));
  const after = join(root, 'after-removal.bin'); await c.command('save_file', { id: incoming.id, path: after });
  assert.deepEqual(readFileSync(after), bytes);
});

test('revoking a contact during attachment verification prevents the inbox message from being accepted', async t => {
  const { root, people: { Alice: a, Bob: b } } = await fixture(t);
  const file = join(root, 'revoked.bin'); writeFileSync(file, randomBytes(1000));
  const attachment = await a.attachments.prepare(file);
  await a.attachments.send(a.store.peer('Bob'), attachment);
  const verify = b.attachments.verifyReceived.bind(b.attachments);
  b.attachments.verifyReceived = async (...args) => {
    const result = await verify(...args);
    await b.command('revoke', { peer: 'Alice' });
    return result;
  };
  const payload = { id: randomUUID(), thread: randomUUID(), kind: 'message', text: 'Do not accept after revocation', attachment, createdAt: Date.now() };
  await assert.rejects(post(b.origin, '/v1/messages', seal(a.store.identity, b.store.identity.public, 'message', payload), true));
  assert.deepEqual(b.store.list(), []);
});

test('a file upload does not hold up an ordinary message', async t => {
  const { root, people: { Alice: a, Bob: b } } = await fixture(t);
  const file = join(root, 'slow.bin'); writeFileSync(file, randomBytes(70_000));
  let release, started = false;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const receive = b.attachments.receive.bind(b.attachments);
  b.attachments.receive = async (peer, raw) => {
    if (raw.type === 'begin') { started = true; await gate; }
    return receive(peer, raw);
  };
  const fileMessage = await a.command('send', { to: 'Bob', file });
  await until(() => started);
  const textMessage = await a.command('send', { to: 'Bob', text: 'This should arrive while the upload is paused.' });
  try {
    await until(() => b.store.list().some(row => row.id === textMessage.id));
    assert.equal(b.store.list().some(row => row.id === fileMessage.id), false);
  } finally { release(); }
  await until(() => b.store.list().some(row => row.id === fileMessage.id));
});
