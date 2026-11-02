import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, diffieHellman, hkdfSync, randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { z } from 'zod';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export const MAX_BODY = 128 * 1024;
export const MAX_FILE_SIZE = 512 * 1024 * 1024;
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, 'utf8') <= 255, 'Expected a safe filename'),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const text = z.string().min(1).max(48_000).refine(value => Buffer.byteLength(value, 'utf8') <= 48_000, 'Text must fit within 48,000 UTF-8 bytes');
const key = z.string().min(30).max(200);
const identitySchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(80), signKey: key, boxKey: key }).strict();
export const discussionSummary = z.object({
  conclusion: z.string().min(1).max(2000),
  evidence: z.array(z.string().min(1).max(500)).max(6),
  disagreements: z.array(z.string().min(1).max(500)).max(6),
  nextStep: z.string().min(1).max(1000)
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value),'utf8') <= 12_000, 'Summary must fit within 12,000 UTF-8 bytes');
const discussionEvent = z.discriminatedUnion('type', [
  z.object({ type:z.literal('proposal'), question:z.string().min(1).max(2000), scope:z.literal('supplied-evidence-only'), maxTurns:z.number().int().min(2).max(8), expiresAt:z.number().int().positive() }).strict(),
  z.object({ type:z.literal('accept') }).strict(),
  z.object({ type:z.literal('reply'), turn:z.number().int().min(1).max(8) }).strict(),
  z.object({ type:z.literal('finish'), turn:z.number().int().min(1).max(8), summary:discussionSummary }).strict(),
  z.object({ type:z.literal('stop'), reason:z.enum(['stopped','declined']) }).strict()
]);
// Parties: the owner manages membership; every member talks to every other
// member directly. Invites carry identities only; addresses come after joining.
// Each member's card is their own signature over their encryption key, so an
// owner introducing them cannot swap in a key of its own.
export const MAX_PARTY = 8;
export const partyName = z.string().trim().min(1).max(60);
const card = z.string().min(1).max(200);
const partyMember = z.object({ identity: identitySchema, endpoint: z.string().max(256), card }).strict();
const partyEvent = z.discriminatedUnion('type', [
  z.object({ type:z.literal('invite'), name:partyName, invitation:z.string().uuid(), members:z.array(identitySchema).min(1).max(MAX_PARTY - 1) }).strict(),
  z.object({ type:z.literal('accept'), invitation:z.string().uuid(), card }).strict(),
  z.object({ type:z.literal('decline'), invitation:z.string().uuid() }).strict(),
  z.object({ type:z.literal('members'), name:partyName, revision:z.number().int().min(1), members:z.array(partyMember).min(1).max(MAX_PARTY) }).strict(),
  z.object({ type:z.literal('leave') }).strict(),
  z.object({ type:z.literal('close') }).strict()
]);
// Bridges: a lasting link between one agent on each side. The owners agree once;
// afterwards the agents ask, answer and share notes on their own. Each side
// keeps how its agent runs to itself; only names and the topic cross.
export const BRIDGE_TEXT = 8000;
export const bridgeAgent = z.string().trim().min(1).max(60);
export const bridgeTopic = z.string().trim().min(1).max(300);
const bridgeEvent = z.discriminatedUnion('type', [
  z.object({ type:z.literal('propose'), topic:bridgeTopic, agent:bridgeAgent }).strict(),
  z.object({ type:z.literal('accept'), agent:bridgeAgent }).strict(),
  z.object({ type:z.literal('decline') }).strict(),
  z.object({ type:z.literal('ask') }).strict(),
  z.object({ type:z.literal('answer') }).strict(),
  z.object({ type:z.literal('note') }).strict(),
  z.object({ type:z.literal('close') }).strict()
]);
export const messageSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['message', 'session', 'task_request', 'task_result', 'discussion', 'party', 'bridge']),
  text, thread: z.string().uuid(), replyTo: z.string().uuid().optional(),
  createdAt: z.number().int().positive(), discussion:discussionEvent.optional(),
  party: z.string().uuid().optional(), partyEvent: partyEvent.optional(),
  bridge: z.string().uuid().optional(), bridgeEvent: bridgeEvent.optional(),
  attachment: attachmentSchema.optional()
}).strict()
  .refine(value => (value.kind === 'discussion') === !!value.discussion, 'Discussion metadata requires the discussion message kind')
  .refine(value => (value.kind === 'party') === !!value.partyEvent, 'Party events require the party message kind')
  .refine(value => !value.party || ['party', 'message', 'session'].includes(value.kind), 'Only messages and session text can go to a party')
  .refine(value => value.kind !== 'party' || !!value.party, 'Party events name their party')
  .refine(value => value.kind === 'bridge' ? !!value.bridgeEvent && value.thread === value.bridge : !value.bridge && !value.bridgeEvent, 'Bridge events name their bridge as the thread')
  .refine(value => value.kind !== 'bridge' || value.text.length <= BRIDGE_TEXT, 'Bridge text must fit within 8,000 characters')
  .refine(value => value.bridgeEvent?.type !== 'answer' || !!value.replyTo, 'An answer names its question')
  .refine(value => !value.attachment || value.kind === 'message', 'Only ordinary messages can carry files');
const envelopeSchema = z.object({
  v: z.literal(1), type: z.enum(['pair', 'receipt', 'message', 'announce', 'attachment']),
  id: z.string().uuid(), sender: z.string().length(64), recipient: z.string().length(64),
  at: z.number().int(), ephemeral: key,
  iv: z.string().max(32), tag: z.string().max(32), body: z.string().max(110_000), signature: z.string().max(128)
}).strict();
const pub = value => createPublicKey({ key: Buffer.from(value, 'base64'), type: 'spki', format: 'der' });
const exportPub = value => value.export({ type: 'spki', format: 'der' }).toString('base64');
const exportPrivate = value => value.export({ type: 'pkcs8', format: 'pem' });
export const hash = value => createHash('sha256').update(value).digest('hex');
export function newIdentity(name) {
  const signing = generateKeyPairSync('ed25519');
  const box = generateKeyPairSync('x25519');
  const signKey = exportPub(signing.publicKey);
  return { public: { id: hash(signKey), name, signKey, boxKey: exportPub(box.publicKey) }, signPrivate: exportPrivate(signing.privateKey), boxPrivate: exportPrivate(box.privateKey) };
}
export function validateIdentity(value) {
  const identity = identitySchema.parse(value);
  if (hash(identity.signKey) !== identity.id || pub(identity.signKey).asymmetricKeyType !== 'ed25519' || pub(identity.boxKey).asymmetricKeyType !== 'x25519') throw new Error('Invalid identity');
  return identity;
}
const cardData = identity => Buffer.from(`clanker-card-v1:${identity.id}:${identity.boxKey}`);
export const identityCard = identity => sign(null, cardData(identity.public), identity.signPrivate).toString('base64');
export function verifyCard(identity, value) {
  try { return verify(null, cardData(identity), pub(identity.signKey), Buffer.from(value, 'base64')); } catch { return false; }
}
export function endpoint(value, allowLoopback = false) {
  const url = new URL(value);
  const local = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0;
  const tunnel = url.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) && !url.port;
  if ((!local && !tunnel) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected a Cloudflare Quick Tunnel origin (or explicit local test origin)');
  return url.origin;
}
function header(e) { return { v: e.v, type: e.type, id: e.id, sender: e.sender, recipient: e.recipient, at: e.at, ephemeral: e.ephemeral, iv: e.iv }; }
function signedData(e) { return Buffer.from(JSON.stringify({ ...header(e), tag: e.tag, body: e.body })); }
function secret(privateKey, publicKey, sender, recipient) {
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), Buffer.from(`${sender}:${recipient}`), Buffer.from('clanker-v1'), 32));
}
export function seal(identity, recipient, type, data) {
  validateIdentity(recipient);
  const ephemeral = generateKeyPairSync('x25519');
  const e = { v: 1, type, id: randomUUID(), sender: identity.public.id, recipient: recipient.id, at: Date.now(), ephemeral: exportPub(ephemeral.publicKey), iv: randomBytes(12).toString('base64') };
  const cipher = createCipheriv('aes-256-gcm', secret(ephemeral.privateKey, pub(recipient.boxKey), e.sender, e.recipient), Buffer.from(e.iv, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(header(e))));
  e.body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
  e.tag = cipher.getAuthTag().toString('base64');
  e.signature = sign(null, signedData(e), identity.signPrivate).toString('base64');
  return e;
}
export function open(identity, envelope, sender, type, { checkTime = true } = {}) {
  const e = envelopeSchema.parse(envelope);
  validateIdentity(sender);
  verifyEnvelope(identity, e, sender, type, checkTime);
  return decrypt(identity, e);
}
function verifyEnvelope(identity, e, sender, type, checkTime = true) {
  if (e.type !== type || e.recipient !== identity.public.id || e.sender !== sender.id) throw new Error('Wrong envelope destination or type');
  if (checkTime && Math.abs(Date.now() - e.at) > 300_000) throw new Error('Envelope expired; check device clocks');
  if (!verify(null, signedData(e), pub(sender.signKey), Buffer.from(e.signature, 'base64'))) throw new Error('Invalid signature');
}
function decrypt(identity, e) {
  const decipher = createDecipheriv('aes-256-gcm', secret(createPrivateKey(identity.boxPrivate), pub(e.ephemeral), e.sender, e.recipient), Buffer.from(e.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(header(e))));
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.body, 'base64')), decipher.final()]).toString());
}
// Pairing is the only operation whose sender is initially unknown. Decrypt, then
// verify the self-contained identity before trusting any field or doing any I/O.
export function openPair(identity, value) {
  const e = envelopeSchema.parse(value);
  if (e.type !== 'pair' || e.recipient !== identity.public.id) throw new Error('Invalid pairing envelope');
  const data = decrypt(identity, e);
  const sender = validateIdentity(data.identity);
  verifyEnvelope(identity, e, sender, 'pair');
  return { data, sender };
}
export function encodeInvite(value) { return `cc1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`; }
const INVITE_LINK = 'https://clanker.imprintsystems.ai/connect/';
export function inviteLink(code) { return `${INVITE_LINK}#${inviteCode(code)}`; }
function inviteCode(input) {
  if (typeof input !== 'string' || input.length > 4600) throw new Error('Invalid connection link or code');
  let code = input.trim();
  if (!code.startsWith('cc1:')) {
    const url = new URL(code);
    // Check the spelling too: URL normalizes credentials, ports and dot paths.
    if (!/^https:\/\/clanker\.imprintsystems\.ai\/connect\/?#cc1:[A-Za-z0-9_-]+$/.test(code) || url.origin !== 'https://clanker.imprintsystems.ai' || !['/connect', '/connect/'].includes(url.pathname) || url.username || url.password || url.port || url.search) throw new Error('Invalid connection link');
    code = url.hash.slice(1);
  }
  if (code.length > 4096 || !/^cc1:[A-Za-z0-9_-]+$/.test(code)) throw new Error('Invalid connection code');
  return code;
}
export function decodeInvite(input, allowLoopback = false) {
  const code = inviteCode(input), payload = code.slice(4);
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.toString('base64url') !== payload) throw new Error('Invalid connection code encoding');
  const value = z.object({ v: z.literal(1), identity: identitySchema, endpoint: z.string().max(256), token: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int() }).strict().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
  if (!value.identity.name.isWellFormed()) throw new Error('Invalid connection identity name');
  validateIdentity(value.identity);
  value.endpoint = endpoint(value.endpoint, allowLoopback);
  if (value.expires <= Date.now()) throw new Error('Connection code expired');
  return value;
}
export async function post(origin, route, payload, allowLoopback = false) {
  const base = endpoint(origin, allowLoopback);
  const body = JSON.stringify(payload), bytes = Buffer.byteLength(body);
  if (bytes > MAX_BODY) throw new Error('Request too large');
  const url = new URL(`${base}${route}`);
  return new Promise((resolve, reject) => {
    const network = url.protocol === 'https:' ? https : http;
    const request = network.request(url, { method: 'POST', signal: AbortSignal.timeout(10_000), lookup: tunnelLookup, headers: { 'content-type': 'application/json', 'content-length': bytes } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { response.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Peer returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)).toString())); } catch (error) { reject(error); }
      });
    });
    request.on('error', error => reject(new Error(`Peer connection failed (${error.code || error.name})`, { cause: error })));
    request.end(body);
  });
}

// New Quick Tunnel names sometimes hit a negative cache in a system resolver.
// Restrict the fallback to the exact tunnel domain and retain normal TLS hostname
// verification. No hardcoded edge IPs, TLS bypass, or arbitrary DNS proxying.
function tunnelLookup(hostname, options, callback) {
  lookup(hostname, options, (error, address, family) => {
    if (!error || error.code !== 'ENOTFOUND' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname)) return callback(error, address, family);
    resolveTunnel(hostname).then(ip => {
      if (options?.all) callback(null, [{ address: ip, family: 4 }]);
      else callback(null, ip, 4);
    }).catch(() => callback(error));
  });
}
async function resolveTunnel(hostname) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error('DNS fallback unavailable');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 8192) throw new Error('DNS response too large'); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks, size).toString());
  const ip = result.Status === 0 && result.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4)?.data;
  if (!ip || /^(0|10|127|169\.254|192\.168)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) throw new Error('DNS fallback returned no public IPv4 address');
  return ip;
}
