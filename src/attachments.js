import { constants, mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { open as openFile, unlink } from 'node:fs/promises';
import { isAbsolute, basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { attachmentSchema, MAX_FILE_SIZE, seal, open, post } from './protocol.js';

export const CHUNK_SIZE = 48 * 1024;
export const MAX_INCOMING_SIZE = 2 * 1024 * 1024 * 1024;
const run = promisify(execFile);
// On macOS a saved file carries the same quarantine mark as a browser download,
// so Gatekeeper checks an app or script from a contact before it first runs.
async function quarantine(path) {
  if (process.platform !== 'darwin') return;
  await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};Clanker Chat;`, path]);
}
const id = z.string().uuid(), party = id.optional();
const transferSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin'), attachment: attachmentSchema, party }).strict(),
  z.object({ type: z.literal('chunk'), id, offset: z.number().int().min(0).max(MAX_FILE_SIZE), data: z.string().min(4).max(CHUNK_SIZE / 3 * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), party }).strict(),
  z.object({ type: z.literal('finish'), id, party }).strict()
]);
const receiptSchema = z.object({ requestId: id, id, offset: z.number().int().min(0).max(MAX_FILE_SIZE), complete: z.boolean() }).strict();
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writeFlags = constants.O_RDWR | constants.O_NOFOLLOW;
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const same = (row, attachment) => row.name === attachment.name && row.size === attachment.size && row.sha256 === attachment.sha256;
const metadata = row => ({ id: row.id, name: row.name, size: row.size, sha256: row.sha256 });

async function writeAll(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('File write made no progress');
    offset += bytesWritten;
  }
}
async function digest(file, size, destination) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    if (offset > size) throw new Error('Attachment size changed');
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (destination) await writeAll(destination, chunk, offset - bytesRead);
  }
  if (offset !== size) throw new Error('Attachment size mismatch');
  return hash.digest('hex');
}

// The database reserves the full declared size, including unfinished transfers.
// Internal paths are random local tokens, never names or paths supplied by a peer.
export class Attachments {
  constructor(home, store, { local = false, stopping = () => false, allowed = () => {}, recipient = peer => peer.identity, transport = (peer, route, envelope) => post(peer.endpoint, route, envelope, local) } = {}) {
    Object.assign(this, { store, local, stopping, allowed, recipient, transport, locks: new Map() });
    this.directory = join(home, 'files');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error('Attachment directory must not be a symlink');
    chmodSync(this.directory, 0o700);
    store.db.exec(`CREATE TABLE IF NOT EXISTS attachment_transfers (
      direction TEXT NOT NULL, peer TEXT NOT NULL, id TEXT NOT NULL, party TEXT NOT NULL,
      name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE, offset INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(direction,peer,id)
    )`);
  }
  path(row) { return join(this.directory, `${id.parse(row.token)}.bin`); }
  row(direction, peer, attachmentId) {
    return this.store.prepare('SELECT * FROM attachment_transfers WHERE direction=? AND peer=? AND id=?').get(direction, peer, attachmentId);
  }
  async locked(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async prepare(file) {
    if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) throw new Error('File must be an absolute local path');
    const source = await openFile(file, readFlags);
    let target, token;
    try {
      const stat = await source.stat();
      if (!stat.isFile()) throw new Error('Attachment must be a regular file');
      if (stat.size > MAX_FILE_SIZE) throw new Error('Attachment exceeds the 512 MiB limit');
      let name = basename(file).replace(/[\\\u0000-\u001f\u007f]/g, '_');
      while (Buffer.byteLength(name, 'utf8') > 255) name = Array.from(name).slice(0, -1).join('');
      token = randomUUID();
      const attachment = attachmentSchema.parse({ id: randomUUID(), name, size: stat.size, sha256: '0'.repeat(64) });
      target = await openFile(this.path({ token }), createFlags, 0o600);
      attachment.sha256 = await digest(source, stat.size, target);
      const after = await source.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Attachment changed while preparing it');
      await target.sync();
      await target.chmod(0o400);
      this.store.prepare('INSERT INTO attachment_transfers (direction,peer,id,party,name,size,sha256,token,offset,complete) VALUES (?,?,?,?,?,?,?,?,?,1)').run('out', '', attachment.id, '', attachment.name, attachment.size, attachment.sha256, token, attachment.size);
      return attachment;
    } catch (error) {
      if (token) await unlink(this.path({ token })).catch(() => {});
      throw error;
    } finally { await source.close(); await target?.close(); }
  }
  async send(peer, raw, scope) {
    const attachment = attachmentSchema.parse(raw);
    if (scope !== undefined) id.parse(scope);
    return this.locked(`out:${peer.id}:${attachment.id}`, async () => {
      const row = this.row('out', '', attachment.id);
      if (!row || !same(row, attachment) || !row.complete) throw new Error('Outgoing attachment snapshot not found');
      const request = async data => {
        await this.allowed(peer.id, scope);
        if (this.stopping()) throw new Error('Attachment transfer stopped');
        const envelope = seal(this.store.identity, this.recipient(peer), 'attachment', { ...data, ...(scope ? { party: scope } : {}) });
        const response = await this.transport(peer, '/v1/attachments', envelope, scope);
        const receipt = receiptSchema.parse(open(this.store.identity, response, peer.identity, 'receipt'));
        if (receipt.requestId !== envelope.id || receipt.id !== attachment.id || receipt.offset > attachment.size || (receipt.complete && receipt.offset !== attachment.size)) throw new Error('Invalid attachment receipt');
        return receipt;
      };
      const start = await request({ type: 'begin', attachment });
      if (start.complete) return attachment;
      const source = await openFile(this.path(row), readFlags);
      try {
        if (!(await source.stat()).isFile()) throw new Error('Invalid attachment snapshot');
        let offset = start.offset;
        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        while (offset < attachment.size) {
          const length = Math.min(buffer.length, attachment.size - offset);
          const { bytesRead } = await source.read(buffer, 0, length, offset);
          if (!bytesRead) throw new Error('Attachment snapshot truncated');
          const receipt = await request({ type: 'chunk', id: attachment.id, offset, data: buffer.subarray(0, bytesRead).toString('base64') });
          if (receipt.offset !== offset + bytesRead || receipt.complete) throw new Error('Invalid attachment chunk receipt');
          offset = receipt.offset;
        }
        const finished = await request({ type: 'finish', id: attachment.id });
        if (!finished.complete || finished.offset !== attachment.size) throw new Error('Attachment not verified by recipient');
      } finally { await source.close(); }
      return attachment;
    });
  }
  async receive(peer, raw) {
    const data = transferSchema.parse(raw);
    await this.allowed(peer.id, data.party);
    const attachmentId = data.type === 'begin' ? data.attachment.id : data.id;
    return this.locked(`in:${peer.id}:${attachmentId}`, async () => {
      // Authorization can change while a request waits behind another chunk.
      await this.allowed(peer.id, data.party);
      if (this.stopping()) throw new Error('Attachment transfer stopped');
      let row = this.row('in', peer.id, attachmentId);
      if (row && row.party !== (data.party || '')) throw new Error('Attachment party mismatch');
      if (data.type === 'begin') {
        if (row && !same(row, data.attachment)) throw new Error('Attachment metadata mismatch');
        if (!row) {
          this.store.transaction(() => {
            const used = this.store.prepare("SELECT coalesce(sum(size),0) AS size FROM attachment_transfers WHERE direction='in'").get().size;
            if (used + data.attachment.size > MAX_INCOMING_SIZE) throw new Error('Incoming attachment storage exceeds the 2 GiB limit');
            const a = data.attachment;
            this.store.prepare('INSERT INTO attachment_transfers (direction,peer,id,party,name,size,sha256,token) VALUES (?,?,?,?,?,?,?,?)').run('in', peer.id, a.id, data.party || '', a.name, a.size, a.sha256, randomUUID());
          });
          row = this.row('in', peer.id, attachmentId);
        }
        let file;
        try {
          try { file = await openFile(this.path(row), writeFlags); }
          catch (error) {
            if (error.code !== 'ENOENT' || row.offset || row.complete) throw error;
            file = await openFile(this.path(row), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          }
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < row.offset) throw new Error('Attachment partial file is invalid');
          if (stat.size !== row.offset) await file.truncate(row.offset);
        } finally { await file?.close(); }
      } else {
        if (!row) throw new Error('Attachment transfer not begun');
        const file = await openFile(this.path(row), writeFlags);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < row.offset) throw new Error('Attachment partial file is invalid');
          if (stat.size !== row.offset) await file.truncate(row.offset);
          if (data.type === 'chunk') {
            const chunk = Buffer.from(data.data, 'base64');
            if (!chunk.length || chunk.toString('base64') !== data.data || data.offset + chunk.length > row.size) throw new Error('Invalid attachment chunk size or encoding');
            if (data.offset < row.offset && data.offset + chunk.length <= row.offset) {
              const previous = Buffer.allocUnsafe(chunk.length);
              const { bytesRead } = await file.read(previous, 0, previous.length, data.offset);
              if (bytesRead !== chunk.length || !previous.equals(chunk)) throw new Error('Conflicting duplicate attachment chunk');
            } else {
              if (row.complete || data.offset !== row.offset) throw new Error('Attachment offset mismatch');
              await writeAll(file, chunk, row.offset);
              await file.datasync();
              row.offset += chunk.length;
              this.store.prepare("UPDATE attachment_transfers SET offset=? WHERE direction='in' AND peer=? AND id=?").run(row.offset, peer.id, attachmentId);
            }
          } else {
            if (row.offset !== row.size) throw new Error('Attachment is incomplete');
            if (await digest(file, row.size) !== row.sha256) {
              await file.truncate(0);
              await file.datasync();
              this.store.prepare("UPDATE attachment_transfers SET offset=0,complete=0 WHERE direction='in' AND peer=? AND id=?").run(peer.id, attachmentId);
              throw new Error('Attachment sha256 mismatch');
            }
            await file.sync();
            this.store.prepare("UPDATE attachment_transfers SET complete=1 WHERE direction='in' AND peer=? AND id=?").run(peer.id, attachmentId);
            row.complete = 1;
          }
        } finally { await file.close(); }
      }
      return { id: attachmentId, offset: row.offset, complete: !!row.complete };
    });
  }
  async verifyReceived(peerId, raw, scope) {
    if (scope !== undefined) id.parse(scope);
    const attachment = attachmentSchema.parse(raw), row = this.row('in', peerId, attachment.id);
    if (!row || !row.complete || !same(row, attachment) || row.party !== (scope || '')) throw new Error('Received attachment is not verified or metadata does not match');
    const file = await openFile(this.path(row), readFlags);
    try {
      if (!(await file.stat()).isFile() || await digest(file, row.size) !== row.sha256) throw new Error('Received attachment integrity check failed');
    } finally { await file.close(); }
    return metadata(row);
  }
  async save(peerId, raw, destination) {
    if (typeof destination !== 'string' || !isAbsolute(destination) || destination.includes('\0')) throw new Error('Destination must be an absolute filename');
    const attachment = attachmentSchema.parse(raw), row = this.row('in', peerId, attachment.id);
    if (!row || !row.complete || !same(row, attachment)) throw new Error('Received attachment is not verified or metadata does not match');
    const source = await openFile(this.path(row), readFlags);
    let target, created = false;
    try {
      if (!(await source.stat()).isFile()) throw new Error('Received attachment is not a regular file');
      target = await openFile(destination, createFlags, 0o600);
      created = true;
      if (await digest(source, attachment.size, target) !== attachment.sha256) throw new Error('Received attachment integrity check failed');
      await target.sync();
      await quarantine(destination);
      return destination;
    } catch (error) {
      if (created) await unlink(destination).catch(() => {});
      throw error;
    } finally { await source.close(); await target?.close(); }
  }
  async discard(raw) {
    const attachment = attachmentSchema.parse(raw), row = this.row('out', '', attachment.id);
    if (!row || !same(row, attachment)) throw new Error('Outgoing attachment snapshot not found');
    await unlink(this.path(row));
    this.store.prepare("DELETE FROM attachment_transfers WHERE direction='out' AND peer='' AND id=?").run(attachment.id);
  }
}
