import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, seal, open, endpoint, encodeInvite, decodeInvite, text } from '../src/protocol.js';

test('only the intended recipient can decrypt; altered sender, body, timestamp and recipient fail', () => {
  const alice = newIdentity('Alice'); const bob = newIdentity('Bob'); const eve = newIdentity('Eve');
  const e = seal(alice, bob.public, 'message', { text: 'private message' });
  assert.deepEqual(open(bob, e, alice.public, 'message'), { text: 'private message' });
  assert.equal(JSON.stringify(e).includes('private message'), false);
  assert.throws(() => open(eve, e, alice.public, 'message'));
  assert.throws(() => open(bob, e, eve.public, 'message'));
  assert.throws(() => open(bob, { ...e, body: e.body.slice(0, -4) + 'AAAA' }, alice.public, 'message'));
  assert.throws(() => open(bob, { ...e, at: e.at + 1 }, alice.public, 'message'));
  assert.throws(() => open(bob, { ...e, at: Date.now() - 600_000 }, alice.public, 'message'));
  assert.throws(() => open(bob, e, alice.public, 'announce'));
});
test('endpoint validation blocks private destinations, credentials, paths and non-tunnel origins', () => {
  assert.equal(endpoint('https://hello-world.trycloudflare.com'), 'https://hello-world.trycloudflare.com');
  for (const value of ['http://hello.trycloudflare.com', 'https://127.0.0.1', 'https://evil.com', 'https://a.trycloudflare.com@evil.com', 'https://a.trycloudflare.com/path', 'https://a.trycloudflare.com?secret=x', 'https://a.trycloudflare.com:9999', 'http://127.0.0.1:4567']) assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://127.0.0.1:4567', true), 'http://127.0.0.1:4567');
  assert.throws(() => endpoint('http://localhost:4567', true));
});
test('connection codes validate identity and expiration, and multibyte content is bounded', () => {
  const value = { v: 1, identity: newIdentity('Alice').public, endpoint: 'https://hello.trycloudflare.com', token: 'a'.repeat(64), expires: Date.now() + 1000 };
  assert.deepEqual(decodeInvite(encodeInvite(value)), value);
  assert.throws(() => decodeInvite(encodeInvite({ ...value, expires: 1 })));
  assert.throws(() => decodeInvite(encodeInvite({ ...value, identity: { ...value.identity, id: 'b'.repeat(64) } })));
  assert.throws(() => text.parse('🙂'.repeat(13_000)));
});
