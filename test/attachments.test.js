import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, symlinkSync, mkdirSync, truncateSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Attachments, CHUNK_SIZE, MAX_INCOMING_SIZE } from '../src/attachments.js';
import { attachmentSchema, messageSchema, MAX_FILE_SIZE, MAX_BODY, seal, open } from '../src/protocol.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const attachmentFor = (bytes, overrides = {}) => ({ id: randomUUID(), name: 'example.bin', size: bytes.length, sha256: sha256(bytes), ...overrides });
const begin = (attachment, party) => ({ type: 'begin', attachment, ...(party ? { party } : {}) });
const chunk = (attachment, offset, bytes, party) => ({ type: 'chunk', id: attachment.id, offset, data: bytes.toString('base64'), ...(party ? { party } : {}) });
const finish = (attachment, party) => ({ type: 'finish', id: attachment.id, ...(party ? { party } : {}) });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-attachments-')), stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  function make(name, options = {}) {
    const home = join(root, name), store = new Store(home, name);
    stores.push(store);
    return { home, store, engine: new Attachments(home, store, { local: true, ...options }), peer: { id: store.identity.public.id, identity: store.identity.public } };
  }
  return { root, make };
}
async function receiver(t, target, source, transform = value => value) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/attachments');
      const buffers = [];
      for await (const part of req) buffers.push(part);
      const body = Buffer.concat(buffers);
      assert.ok(body.length <= MAX_BODY);
      const envelope = JSON.parse(body), data = open(target.store.identity, envelope, source.peer.identity, 'attachment');
      seen.push({ body: body.toString(), data });
      const result = await target.engine.receive(source.peer, data);
      const receipt = await transform({ ...result, requestId: envelope.id }, data);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seal(target.store.identity, source.peer.identity, 'receipt', receipt)));
    } catch (error) { res.writeHead(400); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { peer: { ...target.peer, endpoint: `http://127.0.0.1:${server.address().port}` }, seen };
}
async function complete(engine, peer, attachment, bytes, party) {
  await engine.receive(peer, begin(attachment, party));
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) await engine.receive(peer, chunk(attachment, offset, bytes.subarray(offset, offset + CHUNK_SIZE), party));
  return engine.receive(peer, finish(attachment, party));
}

test('attachment metadata is strict, bounded, basename-only and restricted to ordinary messages', () => {
  const attachment = attachmentFor(Buffer.alloc(0));
  assert.deepEqual(attachmentSchema.parse(attachment), attachment);
  for (const name of ['', '.', '..', '../secret', '/absolute', 'a/b', 'a\\b', 'bad\0name', 'line\nname', 'é'.repeat(128)]) assert.throws(() => attachmentSchema.parse({ ...attachment, name }));
  for (const size of [-1, 0.5, MAX_FILE_SIZE + 1, Infinity]) assert.throws(() => attachmentSchema.parse({ ...attachment, size }));
  assert.throws(() => attachmentSchema.parse({ ...attachment, sha256: 'A'.repeat(64) }));
  assert.throws(() => attachmentSchema.parse({ ...attachment, path: '/not-on-wire' }));
  const message = { id: randomUUID(), kind: 'message', text: attachment.name, thread: randomUUID(), createdAt: Date.now(), attachment };
  assert.deepEqual(messageSchema.parse(message), message);
  for (const kind of ['session', 'task_request', 'task_result']) assert.throws(() => messageSchema.parse({ ...message, kind }));
});

test('encrypted upload and exclusive save preserve binary and empty files without transmitting paths', async t => {
  const { root, make } = fixture(t), sender = make('sender'), target = make('target');
  const transport = await receiver(t, target, sender);
  for (const bytes of [Buffer.concat([Buffer.from([0, 255, 128, 10]), randomBytes(CHUNK_SIZE * 2 + 17)]), Buffer.alloc(0)]) {
    const source = join(root, bytes.length ? 'binary.bin' : 'empty.bin');
    writeFileSync(source, bytes);
    const attachment = await sender.engine.prepare(source);
    assert.equal(attachment.sha256, sha256(bytes));
    assert.equal(attachment.size, bytes.length);
    const row = sender.engine.row('out', '', attachment.id), snapshot = sender.engine.path(row);
    assert.equal(statSync(snapshot).mode & 0o777, 0o400);
    assert.equal(statSync(join(sender.home, 'files')).mode & 0o777, 0o700);
    writeFileSync(source, 'changed after preparing');
    assert.deepEqual(await sender.engine.send(transport.peer, attachment), attachment);
    assert.deepEqual(await target.engine.verifyReceived(sender.peer.id, attachment), attachment);
    const destination = join(root, `${attachment.id}.saved`);
    assert.equal(await target.engine.save(sender.peer.id, attachment, destination), destination);
    assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(await sender.engine.send(transport.peer, attachment), attachment);
    await assert.rejects(sender.engine.save(target.peer.id, attachment, join(root, 'outgoing-not-received')), /not verified/);
  }
  for (const request of transport.seen) {
    assert.equal(request.body.includes(root), false);
    assert.equal(JSON.stringify(request.data).includes(root), false);
    if (request.data.type === 'chunk') assert.ok(Buffer.from(request.data.data, 'base64').length <= CHUNK_SIZE);
  }
});

test('partial uploads resume after reconstruction and lost acknowledgments; duplicate chunks are idempotent', async t => {
  const { root, make } = fixture(t), sender = make('sender'), target = make('target');
  const bytes = randomBytes(CHUNK_SIZE + 31), source = join(root, 'resume.bin');
  writeFileSync(source, bytes);
  const attachment = await sender.engine.prepare(source);
  assert.deepEqual(await target.engine.receive(sender.peer, begin(attachment)), { id: attachment.id, offset: 0, complete: false });
  const first = chunk(attachment, 0, bytes.subarray(0, CHUNK_SIZE));
  await target.engine.receive(sender.peer, first);
  assert.equal((await target.engine.receive(sender.peer, first)).offset, CHUNK_SIZE);
  const row = target.engine.row('in', sender.peer.id, attachment.id);
  appendFileSync(target.engine.path(row), Buffer.from('uncommitted tail'));
  // A new engine reconstructs state from the database, not an in-memory cursor.
  target.engine = new Attachments(target.home, target.store, { local: true });
  const resumed = await target.engine.receive(sender.peer, begin(attachment));
  assert.equal(resumed.offset, CHUNK_SIZE);
  assert.equal(statSync(target.engine.path(row)).size, CHUNK_SIZE);
  const transport = await receiver(t, target, sender);
  await sender.engine.send(transport.peer, attachment);
  assert.equal(transport.seen.filter(item => item.data.type === 'chunk').length, 1);
  assert.equal(transport.seen.find(item => item.data.type === 'chunk').data.offset, CHUNK_SIZE);
  assert.equal((await target.engine.receive(sender.peer, finish(attachment))).complete, true);
  assert.equal((await target.engine.receive(sender.peer, first)).complete, true);
  assert.deepEqual(await target.engine.verifyReceived(sender.peer.id, attachment), attachment);
});

test('serialized transfer writes reject wrong offsets, conflicting retries, malformed data and changed metadata', async t => {
  const { make } = fixture(t), sender = make('sender'), target = make('target');
  const bytes = Buffer.from('abcdefgh'), attachment = attachmentFor(bytes);
  await assert.rejects(target.engine.receive(sender.peer, chunk(attachment, 0, bytes)), /not begun/);
  await target.engine.receive(sender.peer, begin(attachment));
  await assert.rejects(target.engine.verifyReceived(sender.peer.id, attachment), /not verified/);
  for (const altered of [{ name: 'other.bin' }, { size: 7 }, { sha256: '0'.repeat(64) }]) await assert.rejects(target.engine.receive(sender.peer, begin({ ...attachment, ...altered })), /metadata mismatch/);
  await assert.rejects(target.engine.receive(sender.peer, chunk(attachment, 1, bytes.subarray(0, 2))), /offset/);
  await assert.rejects(target.engine.receive(sender.peer, finish(attachment)), /incomplete/);
  const first = chunk(attachment, 0, bytes.subarray(0, 4));
  const results = await Promise.all([target.engine.receive(sender.peer, first), target.engine.receive(sender.peer, first)]);
  assert.deepEqual(results.map(result => result.offset), [4, 4]);
  await assert.rejects(target.engine.receive(sender.peer, chunk(attachment, 0, Buffer.from('xxxx'))), /Conflicting duplicate/);
  await assert.rejects(target.engine.receive(sender.peer, chunk(attachment, 2, bytes.subarray(2, 6))), /offset/);
  await assert.rejects(target.engine.receive(sender.peer, chunk(attachment, 4, Buffer.alloc(5))), /size/);
  await assert.rejects(target.engine.receive(sender.peer, { ...first, data: '!!!!' }));
  await assert.rejects(target.engine.receive(sender.peer, { ...first, data: 'YR==' }), /encoding/);
  await assert.rejects(target.engine.receive(sender.peer, { ...first, data: Buffer.alloc(CHUNK_SIZE + 1).toString('base64') }));
  await assert.rejects(target.engine.receive(sender.peer, { ...first, path: '../elsewhere' }));
  await target.engine.receive(sender.peer, chunk(attachment, 4, bytes.subarray(4)));
  await target.engine.receive(sender.peer, finish(attachment));
  await assert.rejects(target.engine.verifyReceived(sender.peer.id, { ...attachment, name: 'changed.bin' }), /metadata/);
});

test('sha256 failure never verifies bad bytes and resets the partial transfer for a real retry', async t => {
  const { root, make } = fixture(t), sender = make('sender'), target = make('target');
  const bytes = Buffer.from('right bytes'), attachment = attachmentFor(bytes);
  await target.engine.receive(sender.peer, begin(attachment));
  await target.engine.receive(sender.peer, chunk(attachment, 0, Buffer.from('wrong bytes')));
  await assert.rejects(target.engine.receive(sender.peer, finish(attachment)), /sha256/);
  await assert.rejects(target.engine.verifyReceived(sender.peer.id, attachment), /not verified/);
  await assert.rejects(target.engine.save(sender.peer.id, attachment, join(root, 'unverified')), /not verified/);
  assert.equal((await target.engine.receive(sender.peer, begin(attachment))).offset, 0);
  await complete(target.engine, sender.peer, attachment, bytes);
  const row = target.engine.row('in', sender.peer.id, attachment.id);
  writeFileSync(target.engine.path(row), Buffer.alloc(bytes.length));
  await assert.rejects(target.engine.verifyReceived(sender.peer.id, attachment), /integrity/);
});

test('authorization precedes incoming disk access and party context cannot be changed', async t => {
  const { root, make } = fixture(t), sender = make('sender');
  let allow = false;
  const calls = [], target = make('target', { allowed: (peerId, party) => { calls.push([peerId, party]); if (!allow) throw new Error('Not authorized'); } });
  const bytes = Buffer.from('party file'), attachment = attachmentFor(bytes), party = randomUUID();
  const files = join(target.home, 'files');
  rmSync(files, { recursive: true });
  await assert.rejects(target.engine.receive(sender.peer, begin(attachment, party)), /Not authorized/);
  assert.equal(target.engine.row('in', sender.peer.id, attachment.id), undefined);
  mkdirSync(files, { mode: 0o700 });
  allow = true;
  await complete(target.engine, sender.peer, attachment, bytes, party);
  assert.deepEqual(calls[0], [sender.peer.id, party]);
  await assert.rejects(target.engine.receive(sender.peer, begin(attachment)), /party mismatch/);
  await assert.rejects(target.engine.verifyReceived(sender.peer.id, attachment), /metadata/);
  assert.deepEqual(await target.engine.verifyReceived(sender.peer.id, attachment, party), attachment);
  allow = false;
  await assert.rejects(target.engine.receive(sender.peer, finish(attachment, party)), /Not authorized/);
  const destination = join(root, 'after-leaving-party');
  await target.engine.save(sender.peer.id, attachment, destination);
  assert.deepEqual(readFileSync(destination), bytes);
});

test('incoming quota includes partials and completed files without allocating their declared sizes', async t => {
  const { make } = fixture(t), sender = make('sender'), target = make('target');
  const completed = Buffer.from('complete');
  await complete(target.engine, sender.peer, attachmentFor(completed), completed);
  for (let index = 0; index < MAX_INCOMING_SIZE / MAX_FILE_SIZE; index++) {
    const attachment = attachmentFor(Buffer.alloc(0), { size: MAX_FILE_SIZE - (index === 0 ? completed.length : 0) });
    await target.engine.receive(sender.peer, begin(attachment));
  }
  assert.equal(readdirSync(join(target.home, 'files')).reduce((size, name) => size + statSync(join(target.home, 'files', name)).size, 0), completed.length);
  await assert.rejects(target.engine.receive(sender.peer, begin(attachmentFor(Buffer.alloc(1)))), /2 GiB/);
  await assert.rejects(target.engine.receive(sender.peer, begin(attachmentFor(Buffer.alloc(0), { size: MAX_FILE_SIZE + 1 }))));
  // Empty attachments consume no declared bytes and remain valid at the limit.
  const empty = attachmentFor(Buffer.alloc(0));
  await complete(target.engine, sender.peer, empty, Buffer.alloc(0));
  assert.equal(target.store.prepare("SELECT sum(size) AS size FROM attachment_transfers WHERE direction='in'").get().size, MAX_INCOMING_SIZE);
});

test('prepare and save reject unsafe sources, traversal names, relative paths, symlinks and overwrites', async t => {
  const { root, make } = fixture(t), sender = make('sender'), target = make('target');
  await assert.rejects(sender.engine.prepare('relative.bin'), /absolute/);
  await assert.rejects(sender.engine.prepare(root), /regular file/);
  const file = join(root, 'original.bin'), link = join(root, 'source-link');
  writeFileSync(file, 'content'); symlinkSync(file, link);
  await assert.rejects(sender.engine.prepare(link));
  const huge = join(root, 'sparse-large.bin'); writeFileSync(huge, ''); truncateSync(huge, MAX_FILE_SIZE + 1);
  await assert.rejects(sender.engine.prepare(huge), /512 MiB/);
  const bytes = readFileSync(file), attachment = attachmentFor(bytes);
  for (const name of ['../escape', '/escape', '..\\escape']) await assert.rejects(target.engine.receive(sender.peer, begin({ ...attachment, name })));
  await complete(target.engine, sender.peer, attachment, bytes);
  assert.ok(readdirSync(join(target.home, 'files')).every(name => /^[a-f0-9-]{36}\.bin$/.test(name)));
  await assert.rejects(target.engine.save(sender.peer.id, attachment, 'relative.bin'), /absolute/);
  await assert.rejects(target.engine.save(sender.peer.id, attachment, file), /EEXIST/);
  assert.equal(readFileSync(file, 'utf8'), 'content');
  const destinationLink = join(root, 'destination-link'); symlinkSync(file, destinationLink);
  await assert.rejects(target.engine.save(sender.peer.id, attachment, destinationLink), /EEXIST|ELOOP/);
  assert.equal(readFileSync(file, 'utf8'), 'content');
  await assert.rejects(target.engine.save('f'.repeat(64), attachment, join(root, 'wrong-peer')), /not verified/);
  const outgoing = await sender.engine.prepare(file), row = sender.engine.row('out', '', outgoing.id);
  await sender.engine.discard(outgoing);
  assert.equal(sender.engine.row('out', '', outgoing.id), undefined);
  assert.throws(() => statSync(sender.engine.path(row)), /ENOENT/);
});

test('sender validates signed receipts and checks authorization on every transfer request', async t => {
  for (const mode of ['request', 'identity', 'offset', 'finish']) {
    await t.test(mode, async t => {
      const { root, make } = fixture(t), sender = make('sender'), target = make('target');
      const source = join(root, 'file.bin'); writeFileSync(source, 'bytes');
      const attachment = await sender.engine.prepare(source);
      const transport = await receiver(t, target, sender, (receipt, data) => {
        if (mode === 'request') return { ...receipt, requestId: randomUUID() };
        if (mode === 'identity') return { ...receipt, id: randomUUID() };
        if (mode === 'offset' && data.type === 'chunk') return { ...receipt, offset: receipt.offset - 1 };
        if (mode === 'finish' && data.type === 'finish') return { ...receipt, complete: false };
        return receipt;
      });
      await assert.rejects(sender.engine.send(transport.peer, attachment), /receipt|not verified/);
    });
  }
  await t.test('revoked during upload', async t => {
    const { root, make } = fixture(t);
    let authorized = true;
    const sender = make('sender', { allowed: () => { if (!authorized) throw new Error('Revoked'); } }), target = make('target');
    const source = join(root, 'file.bin'); writeFileSync(source, Buffer.alloc(CHUNK_SIZE + 1));
    const attachment = await sender.engine.prepare(source);
    const transport = await receiver(t, target, sender, (receipt, data) => { if (data.type === 'chunk') authorized = false; return receipt; });
    await assert.rejects(sender.engine.send(transport.peer, attachment), /Revoked/);
    assert.equal(transport.seen.filter(item => item.data.type === 'chunk').length, 1);
  });
  await t.test('stopped before network I/O', async t => {
    const { root, make } = fixture(t), sender = make('sender', { stopping: () => true });
    const source = join(root, 'file.bin'); writeFileSync(source, 'bytes');
    const attachment = await sender.engine.prepare(source);
    await assert.rejects(sender.engine.send({ ...sender.peer, endpoint: 'http://127.0.0.1:1' }, attachment), /stopped/);
  });
});
