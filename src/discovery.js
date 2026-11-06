import { createCipheriv, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { z } from 'zod';
import { endpoint } from './protocol.js';

const REPUBLISH_MS = 30 * 60_000;
const RETRY_MS = 60_000;
const LOOKUP_MS = 30_000;
const MAX_AGE_MS = 2 * 60 * 60_000;
const FUTURE_MS = 5 * 60_000;
const TIMESTAMP_KEY = 'discoveryTimestamp';
const STATE_KEY = 'discovery';
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
// Every record has the same size, so its length says nothing about the address.
const PADDED = 128;
const RECORD = /^v=2;e=([A-Za-z0-9_-]{208})$/;
const INFO = Buffer.from('clanker-discovery-v2');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// What a contact needs to find this inbox: the public key its records are
// published under and the secret that decrypts them. Shared only with contacts,
// inside encrypted, signed receipts.
export const discoveryCredentials = z.object({ key: bytes32, secret: bytes32 }).strict();
const stateSchema = z.object({ seed: bytes32, secret: bytes32, sharedWith: z.array(z.string().regex(/^[a-f0-9]{64}$/)) }).strict();

function zbase32(bytes) {
  let bits = 0, value = 0, encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; encoded += ZBASE32[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) encoded += ZBASE32[(value << (5 - bits)) & 31];
  return encoded;
}

function origin(value, local) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > PADDED || endpoint(value, local) !== value) throw new Error('Expected an exact discovery origin');
  return value;
}

function recordKey(secret, publicKey) {
  return Buffer.from(hkdfSync('sha256', secret, publicKey, INFO, 32));
}

export function sealRecord(value, { key, secret }) {
  const publicKey = Buffer.from(key, 'base64url'), plain = Buffer.alloc(PADDED);
  plain.write(value, 'ascii');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', recordKey(Buffer.from(secret, 'base64url'), publicKey), iv);
  cipher.setAAD(Buffer.concat([INFO, publicKey]));
  const sealed = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return `v=2;e=${sealed.toString('base64url')}`;
}

export function openRecord(text, { key, secret }) {
  const match = RECORD.exec(text);
  if (!match) throw new Error('Unexpected discovery record');
  const sealed = Buffer.from(match[1], 'base64url'), publicKey = Buffer.from(key, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', recordKey(Buffer.from(secret, 'base64url'), publicKey), sealed.subarray(0, 12));
  decipher.setAAD(Buffer.concat([INFO, publicKey]));
  decipher.setAuthTag(sealed.subarray(12 + PADDED));
  const plain = Buffer.concat([decipher.update(sealed.subarray(12, 12 + PADDED)), decipher.final()]);
  const end = plain.indexOf(0), length = end === -1 ? PADDED : end;
  if (plain.subarray(length).some(byte => byte !== 0) || plain.subarray(0, length).some(byte => byte < 0x21 || byte > 0x7e)) throw new Error('Invalid discovery record padding');
  return plain.subarray(0, length).toString('ascii');
}

function verifiedBytes(value, publicKey) {
  const bytes = Buffer.from(value);
  // Pkarr 8.1 serialization: unsigned lastSeen(8), publicKey(32),
  // signature(64), signed timestamp in microseconds(8), encoded DNS packet.
  // fromBytes parses trusted storage and does NOT verify its signature.
  if (bytes.length < 124 || bytes.length > 1112) throw new Error('Invalid discovery packet size');
  const timestamp = bytes.readBigUInt64BE(104);
  const dns = bytes.subarray(112);
  const signable = Buffer.concat([Buffer.from(`3:seqi${timestamp}e1:v${dns.length}:`), dns]);
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  if (!verify(null, signable, key, bytes.subarray(40, 104))) throw new Error('Invalid discovery packet signature');
  return bytes;
}

// Address recovery through Pkarr records, readable only by contacts. Records
// are signed by a discovery key of their own, unrelated to the device identity,
// and the address inside is encrypted with a secret shared only with contacts.
// When someone who held the key and secret stops being a contact, both rotate.
// The default client still depends on two public Pubky HTTP-to-DHT gateways.
export class Discovery {
  constructor(store, { enabled = true, local = false, client, now = Date.now } = {}) {
    this.store = store;
    this.enabled = Boolean(enabled && (!local || client));
    this.local = local;
    this.client = client;
    this.now = now;
    this.publishedAt = 0;
    this.nextAt = 0;
    this.lookups = new Map();
    this.closed = false;
  }

  async initialize() {
    if (!this.initializing) this.initializing = (async () => {
      const library = await import('@synonymdev/pkarr');
      this.client ||= new library.Client(undefined, 5000);
      this.library = library;
    })();
    return this.initializing;
  }

  state() {
    let state = this.store.get(STATE_KEY);
    if (!stateSchema.safeParse(state).success) {
      state = { seed: randomBytes(32).toString('base64url'), secret: randomBytes(32).toString('base64url'), sharedWith: [] };
      this.store.set(STATE_KEY, state);
    }
    return state;
  }

  keypair(seed) {
    if (this.keyed?.seed !== seed) {
      const secretKey = Buffer.from(seed, 'base64url');
      try {
        const key = this.library.Keypair.fromSecretKey(secretKey);
        this.keyed?.key.free();
        this.keyed = { seed, key, public: Buffer.from(key.publicKeyBytes()).toString('base64url') };
      } finally { secretKey.fill(0); }
    }
    return this.keyed;
  }

  status() {
    return { enabled: this.enabled, publishedAt: this.publishedAt, ...(this.error ? { error: this.error } : {}) };
  }

  // Hand the current key and secret to an authenticated contact. Nothing is
  // published until someone holds them.
  async share(peerId) {
    if (!this.enabled || this.closed) return undefined;
    await this.initialize();
    const state = this.state();
    if (!state.sharedWith.includes(peerId)) {
      this.store.set(STATE_KEY, { ...state, sharedWith: [...state.sharedWith, peerId] });
      this.nextAt = 0;
    }
    return { key: this.keypair(state.seed).public, secret: state.secret };
  }

  // Rotate when anyone who was given the key and secret is no longer a
  // contact: revoked, or a party member without a shared party left.
  retain(contacts) {
    if (!this.enabled || this.closed) return false;
    const state = this.store.get(STATE_KEY);
    if (!stateSchema.safeParse(state).success || state.sharedWith.every(id => contacts.has(id))) return false;
    this.store.set(STATE_KEY, { seed: randomBytes(32).toString('base64url'), secret: randomBytes(32).toString('base64url'), sharedWith: [] });
    this.nextAt = 0;
    return true;
  }

  // The daemon's existing tick drives scheduling; no extra timers outlive it.
  tick(value) {
    if (!this.enabled || this.closed) return;
    const state = this.store.get(STATE_KEY);
    if (!state?.sharedWith?.length) return;
    if (value !== this.attemptedOrigin || this.attemptedSeed !== state.seed || this.now() >= this.nextAt) void this.publish(value).catch(() => {});
  }
  publish(value) {
    if (!this.enabled || this.closed) return Promise.resolve();
    try { this.desiredOrigin = origin(value, this.local); }
    catch (error) { this.error = error.message; return Promise.reject(error); }
    if (this.publishing) return this.publishing;
    this.publishing = this.publishPending().finally(() => { this.publishing = undefined; });
    return this.publishing;
  }

  async publishPending() {
    let current, seed;
    do {
      current = this.desiredOrigin;
      this.attemptedOrigin = current;
      let builder, packet;
      try {
        await this.initialize();
        const state = this.state();
        seed = state.seed;
        this.attemptedSeed = seed;
        const previous = this.store.get(TIMESTAMP_KEY) || 0;
        const at = Math.max(Math.floor(this.now()), previous + 1);
        if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid discovery publication timestamp');
        // Persist before sending, including failed attempts: restarts and clock
        // ties must never reuse an older signed timestamp.
        this.store.set(TIMESTAMP_KEY, at);
        const { key, public: publicKey } = this.keypair(seed);
        builder = this.library.SignedPacket.builder();
        builder.addTxtRecord('_clanker', sealRecord(current, { key: publicKey, secret: state.secret }), 300);
        builder.setTimestamp(at);
        packet = builder.buildAndSign(key);
        const stored = await this.client.publish(packet);
        if (!Number.isFinite(stored) || stored <= 0) throw new Error('Discovery publication was not confirmed by any DHT node');
        this.publishedAt = at;
        this.error = undefined;
        this.nextAt = this.now() + REPUBLISH_MS;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.nextAt = this.now() + RETRY_MS;
        if (this.closed || (this.desiredOrigin === current && this.store.get(STATE_KEY)?.seed === seed)) throw error;
      } finally { packet?.free(); builder?.free(); }
      // A tunnel may change, or the key rotate, while a gateway is responding.
      // Publish the latest immediately after the in-flight packet, never in parallel.
    } while (!this.closed && (this.desiredOrigin !== current || this.store.get(STATE_KEY)?.seed !== seed));
  }

  async resolve(credentials, after = 0) {
    if (!this.enabled || this.closed) return null;
    let parsed;
    try { parsed = discoveryCredentials.parse(credentials); }
    catch { return null; }
    if (!Number.isSafeInteger(after) || after < 0) return null;
    const key = zbase32(Buffer.from(parsed.key, 'base64url'));
    // A decrypted result is valid only for this public key AND secret.
    const cacheKey = `${parsed.key}:${parsed.secret}`;
    let lookup = this.lookups.get(cacheKey);
    if (!lookup || (!lookup.promise && this.now() - lookup.at >= LOOKUP_MS)) {
      lookup = { at: this.now(), result: null };
      this.lookups.set(cacheKey, lookup);
      lookup.promise = this.lookup(key, parsed).then(result => { lookup.result = result; }).finally(() => { lookup.promise = undefined; });
    }
    if (lookup.promise) await lookup.promise;
    const result = lookup.result;
    return result && result.at > after && this.fresh(result.at) ? { ...result } : null;
  }

  fresh(at) {
    const now = this.now();
    return Number.isSafeInteger(at) && at > 0 && at >= now - MAX_AGE_MS && at <= now + FUTURE_MS;
  }

  async lookup(key, credentials) {
    let received, packet;
    try {
      await this.initialize();
      received = await this.client.resolve(key, this.library.ResolvePolicy.NetworkOnly);
      if (!received) return null;
      // Authenticate the bytes ourselves before reconstructing a library packet;
      // injected wrappers cannot forge trusted properties or bypass signatures.
      packet = this.library.SignedPacket.fromBytes(verifiedBytes(received.bytes(), Buffer.from(credentials.key, 'base64url')));
      if (packet.publicKey !== key || !this.fresh(packet.timestampMs)) return null;
      const records = packet.records;
      if (packet.recordCount !== 1 || records.length !== 1) return null;
      const record = records[0];
      if (record.name !== `_clanker.${key}` || record.ttl !== 300 || record.rdata?.type !== 'TXT' || typeof record.rdata.value !== 'string') return null;
      return { endpoint: origin(openRecord(record.rdata.value, credentials), this.local), at: packet.timestampMs };
    } catch { return null; }
    finally { packet?.free(); received?.free(); }
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([this.publishing, ...[...this.lookups.values()].map(lookup => lookup.promise)]);
      this.keyed?.key.free();
      this.client?.free();
      this.lookups.clear();
    })();
    return this.closing;
  }
}
