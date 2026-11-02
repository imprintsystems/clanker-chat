import { newBoxKey, verifyBoxKey } from './protocol.js';

const ROTATE_MS = 7 * 24 * 60 * 60_000;
// Long enough for anything already on its way to arrive; contacts pick up the
// new key with their next address announcement, every 30 seconds while online.
const GRACE_MS = 2 * 24 * 60 * 60_000;
const FUTURE_MS = 5 * 60_000;
const STATE_KEY = 'boxKeys';

// Rotating encryption keys for messages and file chunks. Pairing, address
// announcements and receipts stay on the identity's own key, so a contact who
// missed a rotation can always reach this inbox and learn the new one.
// Contacts on releases without rotation never receive a statement and keep
// using the identity's own key.
export class Keys {
  constructor(store, { now = Date.now, rotateMs = ROTATE_MS, graceMs = GRACE_MS } = {}) {
    Object.assign(this, { store, now, rotateMs, graceMs });
    // Deleted keys are overwritten in the database file, not just unlinked.
    store.db.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS peer_box_keys (peer TEXT PRIMARY KEY, key TEXT NOT NULL, since INTEGER NOT NULL)');
    this.tick();
  }

  // This inbox's keys, newest first.
  own() { return this.store.get(STATE_KEY) || []; }

  tick() {
    const now = this.now();
    let keys = this.own(), changed = false;
    if (!keys.length || now - keys[0].from >= this.rotateMs) {
      const retired = keys.map((entry, index) => index === 0 ? { ...entry, retiredAt: now } : entry);
      keys = [newBoxKey(this.store.identity, Math.max(now, (keys[0]?.from || 0) + 1)), ...retired];
      changed = true;
    }
    const kept = keys.filter((entry, index) => index === 0 || now - entry.retiredAt < this.graceMs);
    if (!changed && kept.length === keys.length) return;
    this.store.set(STATE_KEY, kept);
    // Old database pages can survive in the write-ahead log; empty it so a
    // deleted key is gone from disk, not only from the table.
    if (kept.length < keys.length) this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  // The current key as contacts receive it: public key, start and signature.
  statement() {
    const { key, from, signature } = this.own()[0];
    return { key, from, signature };
  }

  // The local identity with every private key that may still open a message.
  receiver() {
    return { ...this.store.identity, boxPrivates: [...this.own().map(entry => entry.private), this.store.identity.boxPrivate] };
  }

  // Keep a contact's newer key if their pinned identity signed it.
  accept(peer, value) {
    if (value === undefined) return false;
    let statement;
    try { statement = verifyBoxKey(peer.identity, value); } catch { return false; }
    if (statement.from > this.now() + FUTURE_MS) return false;
    return this.store.prepare('INSERT INTO peer_box_keys VALUES (?,?,?) ON CONFLICT(peer) DO UPDATE SET key=excluded.key,since=excluded.since WHERE excluded.since>peer_box_keys.since')
      .run(peer.id, statement.key, statement.from).changes > 0;
  }

  // The identity to encrypt a message or file chunk to.
  sealTo(peer) {
    const row = this.store.prepare('SELECT key FROM peer_box_keys WHERE peer=?').get(peer.id);
    return row ? { ...peer.identity, boxKey: row.key } : peer.identity;
  }
}
