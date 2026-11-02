import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, seal, open, openPair, endpoint, encodeInvite, inviteLink, decodeInvite, text } from '../src/protocol.js';

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
test('pairing verifies the identity inside the decrypted envelope before trusting it', () => {
  const alice = newIdentity('Alice'), bob = newIdentity('Bob'), eve = newIdentity('Eve');
  const data = { identity: alice.public, token: 'a'.repeat(64) }, envelope = seal(alice, bob.public, 'pair', data);
  assert.deepEqual(openPair(bob, envelope), { data, sender: alice.public });
  assert.throws(() => openPair(bob, { ...envelope, signature: Buffer.alloc(64).toString('base64') }), /signature/);
  assert.throws(() => openPair(bob, seal(eve, bob.public, 'pair', data)), /destination/);
  assert.throws(() => openPair(bob, { ...envelope, at: Date.now() - 600_000 }));
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

test('invite links and existing codes decode to the same bearer invitation without changing its schema', () => {
  const value = { v: 1, identity: newIdentity('Alice 🙂').public, endpoint: 'https://hello.trycloudflare.com', token: 'a'.repeat(64), expires: Date.now() + 600_000 };
  const code = encodeInvite(value), link = inviteLink(code);
  assert.equal(link, `https://clanker.imprintsystems.ai/connect/#${code}`);
  assert.equal(inviteLink(` \n${code}\t`), link);
  assert.equal(inviteLink(link.replace('/connect/', '/connect')), link);
  for (const input of [code, link, link.replace('/connect/', '/connect'), ` \n${code}\t`, ` \n${link}\t`]) assert.deepEqual(decodeInvite(input), value);
  assert.deepEqual(JSON.parse(Buffer.from(code.slice(4), 'base64url').toString()), value);
});

test('invite links reject lookalike hosts, credentials, ports, queries, paths and altered fragments', () => {
  const value = { v: 1, identity: newIdentity('Alice').public, endpoint: 'https://hello.trycloudflare.com', token: 'a'.repeat(64), expires: Date.now() + 600_000 };
  const code = encodeInvite(value), link = inviteLink(code);
  const invalid = [
    `http://clanker.imprintsystems.ai/connect/#${code}`,
    `https://clanker.imprintsystems.ai.evil.test/connect/#${code}`,
    `https://evil.test/connect/#${code}`,
    `https://clanker.imprintsystems.ai@evil.test/connect/#${code}`,
    `https://evil.test@clanker.imprintsystems.ai/connect/#${code}`,
    `https://user:pass@clanker.imprintsystems.ai/connect/#${code}`,
    `https://clanker.imprintsystems.ai:443/connect/#${code}`,
    `https://clanker.imprintsystems.ai:8443/connect/#${code}`,
    `https://clanker.imprintsystems.ai/connect/?tracking=1#${code}`,
    `https://clanker.imprintsystems.ai/connect/?#${code}`,
    `https://clanker.imprintsystems.ai/connect/extra#${code}`,
    `https://clanker.imprintsystems.ai/other/../connect/#${code}`,
    `https://clanker.imprintsystems.ai/%63onnect/#${code}`,
    `https://clanker.imprintsystems.ai//connect/#${code}`,
    `https://clanker.imprintsystems.ai\\connect\\#${code}`,
    `https://clanker.imprintsystems.ai/connect/#${code.replace(':', '%3A')}`,
    `https://clanker.imprintsystems.ai/connect/?code=${code}`,
    'https://clanker.imprintsystems.ai/connect/',
    `${link}#more`, `${link}?more`, `${link}=`, `${link}%20`, link.replace('#cc1:', '#cc2:'),
    `${link.slice(0, 60)}\n${link.slice(60)}`
  ];
  for (const input of invalid) {
    assert.throws(() => decodeInvite(input), input);
    assert.throws(() => inviteLink(input), input);
  }
});

test('invite payload decoding rejects garbage, noncanonical base64url and invalid Unicode', () => {
  const value = { v: 1, identity: newIdentity('Alice').public, endpoint: 'https://hello.trycloudflare.com', token: 'a'.repeat(64), expires: Date.now() + 600_000 };
  const code = encodeInvite(value);
  for (const input of [null, '', 'cc1:', `cc1:${'a'.repeat(4093)}`, ' '.repeat(4601), `${code}!`, `${code}=`, code.replace('cc1:', 'cc1:\n'), 'cc1:YWJj+', 'cc1:YWJj/', 'cc1:Zh', 'cc1:a', 'cc1:bm90IGpzb24']) assert.throws(() => decodeInvite(input));
  assert.throws(() => decodeInvite(encodeInvite({ ...value, identity: { ...value.identity, name: '\ud800' } })), /identity name/);
  const [before, after] = JSON.stringify(value).split('Alice');
  const invalidUTF8 = `cc1:${Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]).toString('base64url')}`;
  assert.throws(() => decodeInvite(invalidUTF8), TypeError);
  assert.throws(() => decodeInvite(encodeInvite({ ...value, extra: true })));
  assert.throws(() => decodeInvite(encodeInvite({ ...value, token: `${'a'.repeat(64)}!` })));
});

test('links preserve identity, expiry and explicit local-origin restrictions', () => {
  const value = { v: 1, identity: newIdentity('Alice').public, endpoint: 'http://127.0.0.1:4567', token: 'a'.repeat(64), expires: Date.now() + 600_000 };
  const code = encodeInvite(value), link = inviteLink(code);
  for (const input of [code, link]) {
    assert.throws(() => decodeInvite(input));
    assert.deepEqual(decodeInvite(input, true), value);
  }
  for (const changed of [
    { ...value, expires: 1 },
    { ...value, identity: { ...value.identity, id: 'b'.repeat(64) } },
    { ...value, identity: { ...value.identity, signKey: value.identity.boxKey } },
    { ...value, endpoint: 'http://localhost:4567' },
    { ...value, endpoint: 'https://evil.test' }
  ]) assert.throws(() => decodeInvite(inviteLink(encodeInvite(changed)), true));
});
