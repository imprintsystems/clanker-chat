import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelLookup } from '../src/tunnel-dns.js';

const HOST = 'synthetic.trycloudflare.com';
const missing = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
const reply = (data = '203.0.113.5', TTL = 60) => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data, TTL }] }));
const query = (lookup, host = HOST, options = {}) => new Promise((resolve, reject) => lookup(host, options, (error, address, family) => error ? reject(error) : resolve({ address, family })));
const lookup = (_host, _options, callback) => callback(missing());

test('concurrent DNS fallbacks share one request and reuse the answer only within its TTL', async () => {
  let now = 1, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const resolve = createTunnelLookup({ lookup, now: () => now, fetch: async () => { calls++; await gate; return reply(); } });
  const pending = Array.from({ length: 50 }, () => query(resolve));
  assert.equal(calls, 1); release();
  for (const result of await Promise.all(pending)) assert.deepEqual(result, { address: '203.0.113.5', family: 4 });
  assert.deepEqual(await query(resolve, HOST, { all: true }), { address: [{ address: '203.0.113.5', family: 4 }], family: undefined });
  now += 59_999; await query(resolve); assert.equal(calls, 1);
  now++; await query(resolve); assert.equal(calls, 2);
});

test('failed DNS fallbacks cool down, release rejected bodies and retry after 30 seconds', async () => {
  let now = 1, calls = 0, canceled = 0;
  const resolve = createTunnelLookup({ lookup, now: () => now, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503 });
  } });
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => query(resolve)));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'ENOTFOUND'));
  assert.equal(calls, 1); assert.equal(canceled, 1);
  now += 29_999; await assert.rejects(query(resolve)); assert.equal(calls, 1);
  now++; await assert.rejects(query(resolve)); assert.equal(calls, 2); assert.equal(canceled, 2);
});

test('native DNS success wins immediately; fallback remains restricted to missing tunnel IPv4 names', async () => {
  let native = false, code = 'ENOTFOUND', calls = 0;
  const resolve = createTunnelLookup({
    lookup: (_host, _options, callback) => native ? callback(null, '203.0.113.9', 4) : callback(Object.assign(new Error(), { code })),
    fetch: async () => { calls++; return reply(); }
  });
  await query(resolve); assert.equal(calls, 1);
  native = true; assert.deepEqual(await query(resolve), { address: '203.0.113.9', family: 4 });
  native = false;
  for (const host of ['example.com', 'nested.synthetic.trycloudflare.com', '127.0.0.1']) await assert.rejects(query(resolve, host));
  await assert.rejects(query(resolve, HOST, { family: 6 }));
  code = 'EAI_AGAIN'; await assert.rejects(query(resolve));
  assert.equal(calls, 1);
});

test('private, malformed and oversized DNS answers never enter the address cache', async () => {
  for (const data of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.0.1', '::1', 'invalid']) {
    const resolve = createTunnelLookup({ lookup, fetch: async () => reply(data) });
    await assert.rejects(query(resolve), { code: 'ENOTFOUND' });
  }
  for (const body of ['not JSON', 'x'.repeat(8193), JSON.stringify({ Status: 3, Answer: [{ type: 1, data: '203.0.113.5' }] })]) {
    const resolve = createTunnelLookup({ lookup, fetch: async () => new Response(body) });
    await assert.rejects(query(resolve), { code: 'ENOTFOUND' });
  }
});

test('the cache bounds completed and pending entries; excess requests cannot bypass single-flight', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const resolve = createTunnelLookup({ lookup, fetch: async () => { calls++; await gate; return reply(); } });
  const pending = Array.from({ length: 256 }, (_, i) => query(resolve, `synthetic-${i}.trycloudflare.com`));
  await assert.rejects(query(resolve, 'overflow.trycloudflare.com'));
  const same = query(resolve, 'synthetic-0.trycloudflare.com');
  assert.equal(calls, 256); release(); await Promise.all([...pending, same]);
  await query(resolve, 'overflow.trycloudflare.com'); assert.equal(calls, 257);
});

test('fallback TTL is capped at five minutes and zero TTL does not become a permanent cache entry', async () => {
  for (const [ttl, expires] of [[86400, 300_000], [0, 0]]) {
    let now = 1, calls = 0;
    const resolve = createTunnelLookup({ lookup, now: () => now, fetch: async () => { calls++; return reply('203.0.113.5', ttl); } });
    await query(resolve);
    if (expires) { now += expires - 1; await query(resolve); assert.equal(calls, 1); now++; }
    await query(resolve); assert.equal(calls, 2);
  }
});
