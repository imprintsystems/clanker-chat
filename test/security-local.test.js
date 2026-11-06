import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { localCall } from '../src/local.js';
import { MAX_BODY } from '../src/protocol.js';

test('valid incoming messages larger together than a request stay readable through the local socket', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-local-response-'));
  const daemon = await new ClankerChat({ home: root, name: 'Synthetic', local: true }).start();
  t.after(async () => { await daemon.close(); rmSync(root, { recursive: true, force: true }); });
  // Each message is within the protocol's 48,000-byte limit; together they are not.
  const text = 'x'.repeat(47_000);
  for (let i = 0; i < 5; i++) daemon.store.insert('synthetic-peer', 'in', { id: randomUUID(), text, kind: 'message', thread: randomUUID(), createdAt: Date.now() });
  const inbox = await localCall(root, 'inbox', { preview: false });
  assert.ok(JSON.stringify(inbox).length > MAX_BODY);
  assert.equal(inbox.length, 5);
  assert.ok(inbox.every(row => row.payload.text === text));
});
