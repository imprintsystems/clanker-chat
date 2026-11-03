import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { clientGrant, enableClient, disableClient, setAgentNote } from '../src/access.js';
import { localCall } from '../src/local.js';
import { inboxNote } from '../src/overview.js';

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-note-context-'));
  const daemon = await new ClankerChat({ home, name: 'Synthetic', local: true, discovery: false, updateCheck: false }).start();
  t.after(async () => { await daemon.close(); rmSync(home, { recursive: true, force: true }); });
  // These tests exercise local commands without asynchronous claim cleanup.
  clearInterval(daemon.timer);
  const credentials = {};
  for (const client of ['omp', 'claude', 'codex']) {
    const grant = clientGrant(home, client, client);
    enableClient(home, client, grant);
    credentials[client] = { id: client, token: grant.token };
  }
  const receive = text => daemon.store.insert('untrusted-peer', 'in', {
    id: randomUUID(), text, kind: 'message', thread: randomUUID(), createdAt: Date.now()
  });
  const context = (boundary, credential = credentials.omp) => localCall(home, 'notification_context', { boundary }, credential);
  return { home, daemon, credentials, receive, context };
}

test('notification context accepts app/MCP credentials and caps the note at the displayed boundary', async t => {
  const { daemon, credentials, receive, context } = await setup(t);
  assert.deepEqual(await context(1), {});
  receive('First displayed message');
  receive('Second displayed message');
  const boundary = daemon.store.status().latest;
  receive('Later undisplayed message');
  const expected = { additionalContext: inboxNote(daemon.store, boundary) };
  for (const credential of Object.values(credentials)) {
    const result = await context(boundary, credential);
    assert.deepEqual(result, expected);
    assert.match(result.additionalContext, /First displayed message/);
    assert.match(result.additionalContext, /Second displayed message/);
    assert.doesNotMatch(result.additionalContext, /Later undisplayed message/);
  }
  assert.deepEqual(await context(Number.MAX_SAFE_INTEGER), { additionalContext: inboxNote(daemon.store) });
  assert.equal(daemon.store.status().unread, 3);
});

test('notification context requires only a positive safe integer boundary and rejects client spoofing', async t => {
  const { home, credentials, receive } = await setup(t);
  receive('Visible only to an enabled app');
  for (const args of [{}, { boundary: 0 }, { boundary: -1 }, { boundary: 1.5 }, { boundary: '1' }, { boundary: null }, { boundary: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(localCall(home, 'notification_context', args, credentials.omp), /Check the arguments/);
  }
  await assert.rejects(localCall(home, 'notification_context', { boundary: 1, client: 'claude' }, credentials.omp), /Check the arguments/);
  await assert.rejects(localCall(home, 'notification_context', { boundary: 1 }, { id: 'claude', token: credentials.omp.token }), /not connected/);
  assert.deepEqual(await localCall(home, 'notification_context', { boundary: 1 }), {}, 'an owner call without an authenticated app cannot choose an app implicitly');
});

test('notification context honors live note settings, enabled app access and revoked credentials', async t => {
  const { home, daemon, credentials, receive, context } = await setup(t);
  receive('Pending inbox message');
  const boundary = daemon.store.status().latest;
  assert.ok((await context(boundary)).additionalContext);
  setAgentNote(home, false);
  assert.deepEqual(await context(boundary), {});
  assert.deepEqual(await context(boundary, credentials.claude), {});
  setAgentNote(home, true);
  assert.ok((await context(boundary)).additionalContext);
  disableClient(home, 'omp');
  await assert.rejects(context(boundary), /not connected/);
  await assert.rejects(localCall(home, 'notification_context', { boundary, client: 'claude' }, credentials.omp), /not connected/);
  assert.ok((await context(boundary, credentials.claude)).additionalContext);
  const grant = clientGrant(home, 'omp', 'omp');
  enableClient(home, 'omp', grant);
  await assert.rejects(context(boundary), /not connected/, 're-enabling an app must not revive its revoked token');
  assert.ok((await context(boundary, { id: 'omp', token: grant.token })).additionalContext);
  assert.equal(daemon.store.status().unread, 1);
});

test('notification context neither consumes Claude/Codex notices nor marks inbox messages read', async t => {
  const { home, daemon, receive, context } = await setup(t);
  const sessions = ['claude', 'codex'].map(client => ({ client, session: randomUUID() }));
  const claims = () => daemon.store.prepare('SELECT * FROM notification_notices ORDER BY client,session').all();
  const messages = () => daemon.store.prepare('SELECT id,seq,read FROM messages ORDER BY seq').all();
  receive('Already displayed batch');
  const firstBoundary = daemon.store.status().latest;
  const before = messages();
  assert.ok((await context(firstBoundary)).additionalContext);
  assert.deepEqual(claims(), [], 'fetching context does not claim either host notice');
  assert.deepEqual(messages(), before);
  for (const session of sessions) {
    assert.ok((await localCall(home, 'notification_notice', session)).systemMessage);
  }
  const displayedClaims = claims();
  receive('An arrival after the displayed batch');
  const unreadMessages = messages();
  assert.ok((await context(firstBoundary)).additionalContext);
  assert.ok((await context(daemon.store.status().latest)).additionalContext);
  assert.deepEqual(claims(), displayedClaims, 'fetching context never advances existing claims');
  assert.deepEqual(messages(), unreadMessages);
  assert.equal(daemon.store.status().unread, 2);
  for (const session of sessions) {
    assert.deepEqual(await localCall(home, 'notification_notice', session), {}, 'the original host claim remains consumed');
  }
  daemon.store.prepare('UPDATE messages SET read=1').run();
  const readMessages = messages();
  assert.deepEqual(await context(daemon.store.status().latest), {});
  assert.deepEqual(claims(), displayedClaims, 'an empty context does not clear claims either');
  assert.deepEqual(messages(), readMessages);
});
