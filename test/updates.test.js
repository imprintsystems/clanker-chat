import test from 'node:test';
import assert from 'node:assert/strict';
import { Updates, newer } from '../src/updates.js';
import { VERSION } from '../src/version.js';

const memory = (values = {}, fresh = false) => ({ fresh, get: key => values[key], set: (key, value) => { values[key] = value; } });
const formula = version => async () => ({ ok: true, text: async () => `class Clanker < Formula\n  version "${version}"\nend\n` });

test('an upgrade is announced once; fresh installs and restarts announce nothing', () => {
  const fresh = new Updates(memory({}, true));
  assert.equal(fresh.start(), false); assert.equal(fresh.notice(true), null);

  const store = memory({}); // An inbox from before versions were stored.
  const updates = new Updates(store);
  assert.equal(updates.start(), true);
  assert.equal(updates.notice(false).updatedTo, VERSION); // Peeking leaves it pending.
  assert.equal(updates.notice(true).updatedTo, VERSION);
  assert.equal(updates.notice(true), null);
  assert.equal(new Updates(store).start(), false);
});

test('a newer release is offered once, checked at most daily, and failures retry later', async () => {
  let now = 1_000_000_000, calls = 0;
  const next = VERSION.replace(/\d+$/, n => Number(n) + 1);
  const store = memory({ version: VERSION });
  const fetch = async (...args) => { calls++; return formula(next)(...args); };
  const updates = new Updates(store, { check: true, fetch, now: () => now });
  await updates.tick(); await updates.tick();
  assert.equal(calls, 1);
  assert.deepEqual(updates.notice(true), { available: next, how: 'brew upgrade clanker' });
  assert.equal(updates.notice(true), null);
  now += 86_400_001; await updates.tick();
  assert.equal(calls, 2); assert.equal(updates.notice(true), null); // Same version stays shown.

  const failing = new Updates(memory({ version: VERSION }), { check: true, fetch: async () => { throw new Error('offline'); }, now: () => now });
  await failing.tick(); assert.equal(failing.notice(true), null);
  assert.equal(newer('0.10.0', '0.9.9'), true); assert.equal(newer('0.3.1', '0.3.1'), false);
});
