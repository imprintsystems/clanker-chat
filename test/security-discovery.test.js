import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair, SignedPacket } from '@synonymdev/pkarr';
import { Discovery, sealRecord } from '../src/discovery.js';

const NOW = 1_800_000_000_000;
const ADDRESS = 'https://security-cache.trycloudflare.com';
function fixture(t) {
  const keypair = new Keypair();
  const credentials = { key: Buffer.from(keypair.publicKeyBytes()).toString('base64url'), secret: randomBytes(32).toString('base64url') };
  const builder = SignedPacket.builder();
  let packet, bytes;
  try {
    builder.addTxtRecord('_clanker', sealRecord(ADDRESS, credentials), 300);
    builder.setTimestamp(NOW);
    packet = builder.buildAndSign(keypair);
    bytes = Buffer.from(packet.bytes());
  } finally { packet?.free(); builder.free(); }
  const client = {
    calls: 0,
    async resolve(key) {
      this.calls++;
      assert.equal(key, keypair.publicKey());
      if (this.gate) await this.gate;
      return SignedPacket.fromBytes(bytes);
    },
    free() {}
  };
  const discovery = new Discovery({}, { client, now: () => NOW });
  t.after(async () => { await discovery.close(); keypair.free(); });
  const wrong = { ...credentials, secret: randomBytes(32).toString('base64url') };
  return { discovery, client, credentials, wrong };
}

test('a cached recovery address is never returned to credentials with a different secret', async t => {
  const { discovery, client, credentials, wrong } = fixture(t);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: ADDRESS, at: NOW });
  assert.equal(await discovery.resolve(wrong), null);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: ADDRESS, at: NOW });
  assert.equal(client.calls, 2);
});

test('a failed recovery with the wrong secret cannot poison a valid credential lookup', async t => {
  const { discovery, client, credentials, wrong } = fixture(t);
  assert.equal(await discovery.resolve(wrong), null);
  assert.deepEqual(await discovery.resolve(credentials), { endpoint: ADDRESS, at: NOW });
  assert.equal(await discovery.resolve(wrong), null);
  assert.equal(client.calls, 2);
});

test('in-flight recovery is shared only by the full matching credential pair', async t => {
  const { discovery, client, credentials, wrong } = fixture(t);
  let release;
  client.gate = new Promise(resolve => { release = resolve; });
  const first = discovery.resolve(credentials);
  const same = discovery.resolve({ ...credentials });
  const different = discovery.resolve(wrong);
  release();
  assert.deepEqual(await Promise.all([first, same, different]), [
    { endpoint: ADDRESS, at: NOW }, { endpoint: ADDRESS, at: NOW }, null
  ]);
  assert.equal(client.calls, 2);
});
