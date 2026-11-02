import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClankerChat } from '../src/daemon.js';
import { decodeInvite, seal, open, post, newIdentity } from '../src/protocol.js';
import { localCall } from '../src/local.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { clientGrant, enableClient, disableClient } from '../src/access.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 6000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await check()) return; await pause(50); } throw new Error('Condition timed out'); }
async function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'ap-'));
  const a = await new ClankerChat({ home: join(base, 'a'), name: 'Erik', local: true }).start();
  const b = await new ClankerChat({ home: join(base, 'b'), name: 'David', local: true }).start();
  t.after(async () => { await a.close(); await b.close(); rmSync(base, { recursive: true, force: true }); });
  const invite = await a.command('invite'); await b.command('pair', { code: invite.code });
  return { base, a, b, invite };
}
test('two identities pair once, exchange selected sessions with durable receipts, deduplicate, and reject strangers', async t => {
  const { base, a, b, invite } = await setup(t);
  assert.equal(a.store.peers()[0].identity.name, 'David');
  assert.equal(b.store.peers()[0].identity.name, 'Erik');
  await assert.rejects(() => b.command('pair', { code: invite.code }));
  assert.equal(statSync(join(base, 'a')).mode & 0o777, 0o700);
  assert.equal(statSync(join(base, 'a', 'inbox.db')).mode & 0o777, 0o600);
  const sent = await localCall(a.options.home, 'send', { to: 'David', text: 'Should we implement these changes? Selected session: use SQLite.', kind: 'session' });
  await until(() => b.store.status().unread === 1);
  await until(() => a.store.list({ direction: 'out' })[0].state === 'delivered');
  const message = b.store.list()[0];
  assert.equal(message.payload.id, sent.id); assert.equal(message.payload.kind, 'session');
  assert.match(message.trust, /remote content/);
  const duplicate = seal(a.store.identity, b.store.identity.public, 'message', message.payload);
  const receipt = open(a.store.identity, await post(b.origin, '/v1/messages', duplicate, true), b.store.identity.public, 'receipt');
  assert.equal(receipt.messageId, sent.id); assert.equal(b.store.list().length, 1);
  const stranger = newIdentity('Impersonator');
  await assert.rejects(() => post(b.origin, '/v1/messages', seal(stranger, b.store.identity.public, 'message', message.payload), true));
  await b.command('read', { id: sent.id }); assert.equal(b.store.status().unread, 0);
  await assert.rejects(() => a.command('send', { to: 'David', text: '🙂'.repeat(13_000) }));
});
test('task requests require local approval, results preserve the thread, and revoked contacts cannot send', async t => {
  const { a, b } = await setup(t);
  const request = await a.command('send', { to: 'David', text: 'Please test the preview on your device.', kind: 'task_request' });
  await until(() => b.store.list().length === 1);
  await assert.rejects(() => b.command('complete', { id: request.id, text: 'premature result' }), /approval/);
  await assert.rejects(() => b.command('decide', { id: request.id, decision: 'approved' }, { client: 'codex' }), /needs the user's yes/);
  await b.command('decide', { id: request.id, decision: 'approved', consent: 'chat' }, { client: 'codex' });
  const result = await b.command('complete', { id: request.id, text: 'Preview loads on this device.' });
  await until(() => a.store.list().length === 1);
  assert.equal(a.store.list()[0].payload.id, result.id);
  assert.equal(a.store.list()[0].payload.replyTo, request.id);
  assert.equal(a.store.list()[0].payload.thread, request.thread);
  await assert.rejects(() => b.command('complete', { id: request.id, text: 'duplicate result' }));
  await b.command('revoke', { peer: 'Erik' });
  const envelope = seal(a.store.identity, b.store.identity.public, 'message', { ...b.store.list()[0].payload, text: 'blocked' });
  await assert.rejects(() => post(b.origin, '/v1/messages', envelope, true));
  await assert.rejects(() => b.command('send', { to: 'Erik', text: 'no' }), /revoked/);
});
test('offline outbox survives restart and address announcements restore delivery', async t => {
  const { a, b } = await setup(t);
  const oldId = b.store.identity.public.id;
  await b.close();
  // close is idempotent so cleanup can call it again after the replacement.
  b.close = async () => {};
  const sent = await a.command('send', { to: 'David', text: 'Queued while David is offline.' });
  await until(() => a.store.list({ direction: 'out' })[0].attempts > 0);
  await a.close(); a.close = async () => {};
  const replacementA = await new ClankerChat({ ...a.options }).start();
  t.after(() => replacementA.close());
  assert.equal(replacementA.store.list({ direction: 'out' })[0].id, sent.id);
  const replacementB = await new ClankerChat({ ...b.options }).start();
  t.after(() => replacementB.close());
  assert.equal(replacementB.store.identity.public.id, oldId);
  // Both addresses changed: re-exchange a code to restore discovery.
  const invite = await replacementA.command('invite'); await replacementB.command('pair', { code: invite.code });
  await replacementA.command('retry');
  await until(() => replacementB.store.list().length === 1);
  assert.equal(replacementB.store.list()[0].id, sent.id);
  assert.equal(replacementA.store.list({ direction: 'out' })[0].state, 'delivered');
});
test('one device restarting can announce its new address to a friend that stayed online', async t => {
  const { a, b } = await setup(t);
  await b.close(); b.close = async () => {};
  const replacement = await new ClankerChat({ ...b.options }).start();
  t.after(() => replacement.close());
  await until(() => a.store.peer('David').endpoint === replacement.origin);
  await a.command('send', { to: 'David', text: 'Found your new address.' });
  await until(() => replacement.store.list().length === 1);
});
test('MCP client discovers tools, reads an inbox, waits, and receives resource notifications', async t => {
  const { a, b } = await setup(t);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], env: { ...process.env, CLANKER_HOME: b.options.home }, stderr: 'pipe' });
  t.after(() => client.close());
  let notices = 0; let resourceUpdates = 0;
  client.setNotificationHandler(LoggingMessageNotificationSchema, () => { notices++; });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => { resourceUpdates++; });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'clanker_send'));
  assert.equal(tools.tools.some(tool => /approve|execute|shell/.test(tool.name)), false);
  await client.subscribeResource({ uri: 'clanker://inbox' });
  await pause(2200); // Establish notification cursor before the message arrives.
  const waiting = client.callTool({ name: 'clanker_wait', arguments: { after: 0, seconds: 5 } });
  const long = `MCP notification proof. ${'Reference draft line. '.repeat(40)}`;
  await a.command('send', { to: 'David', text: long });
  const data = result => JSON.parse(result.content[0].text);
  const [preview] = data(await waiting);
  assert.equal(preview.from, 'Erik'); assert.equal(preview.chars, long.length);
  assert.ok(preview.preview.startsWith('MCP notification proof.') && preview.preview.length <= 160);
  const overview = data(await client.callTool({ name: 'clanker_overview', arguments: {} }));
  assert.equal(overview.unread, 1); assert.deepEqual(overview.messages.map(row => row.id), [preview.id]);
  assert.equal(data(await client.callTool({ name: 'clanker_message', arguments: { id: preview.id } })).text, long);
  const inbox = await client.readResource({ uri: 'clanker://inbox' });
  assert.match(inbox.contents[0].text, /MCP notification proof/);
  await until(() => notices > 0 && resourceUpdates > 0);
  const sent = await client.callTool({ name: 'clanker_send', arguments: { to: 'Erik', text: 'Reply through MCP.' } });
  assert.equal(sent.isError, undefined);
  await until(() => a.store.list().length === 1);
  assert.equal(a.store.list()[0].payload.text, 'Reply through MCP.');
});
test('a second daemon cannot replace an active local socket', async t => {
  const { a } = await setup(t);
  const second = new ClankerChat({ ...a.options });
  await assert.rejects(() => second.start(), /already running/);
  assert.equal((await localCall(a.options.home, 'status')).online, true);
});
test('selected MCP client credentials work and revocation also blocks a pending inbox wait', async t => {
  const { a, b } = await setup(t);
  const grant = clientGrant(b.options.home, 'hermes', 'Hermes'); enableClient(b.options.home, 'hermes', grant);
  const client = new Client({ name: 'selected-client', version: '1.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], env: { ...process.env, CLANKER_HOME: b.options.home, CLANKER_CLIENT_ID: 'hermes', CLANKER_CLIENT_TOKEN: grant.token }, stderr: 'pipe' }));
  const status = await client.callTool({ name: 'clanker_status', arguments: {} }); assert.equal(status.isError, undefined);
  const waiting = client.callTool({ name: 'clanker_wait', arguments: { after: 0, seconds: 5 } });
  await pause(100); disableClient(b.options.home, 'hermes');
  await a.command('send', { to: 'David', text: 'Do not disclose this after revocation.' });
  const result = await waiting;
  assert.equal(result.isError, true); assert.match(result.content[0].text, /not connected/); assert.doesNotMatch(result.content[0].text, /Do not disclose/);
  const blocked = await client.callTool({ name: 'clanker_inbox', arguments: {} }); assert.equal(blocked.isError, true);
  const anonymous = new Client({ name: 'unselected-client', version: '1.0' }); t.after(() => anonymous.close());
  await anonymous.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], env: { ...process.env, CLANKER_HOME: b.options.home }, stderr: 'pipe' }));
  assert.equal((await anonymous.callTool({ name: 'clanker_status', arguments: {} })).isError, true);
});
