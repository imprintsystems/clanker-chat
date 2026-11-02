import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localCall } from '../src/local.js';
import { clientGrant, enableClient, disableClient } from '../src/access.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${description}`);
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
const cli = resolve('src/cli.js');
const data = result => { assert.equal(result.isError, undefined, result.content[0]?.text); return JSON.parse(result.content[0].text); };

test('forced daemon crashes preserve queued messages, identity, approvals and an existing MCP connection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-crash-')); const children = [];
  const homeA = join(root, 'a'); const homeB = join(root, 'b');
  const grant = clientGrant(homeB, 'test', 'Temporary MCP client'); enableClient(homeB, 'test', grant);
  const client = new Client({ name: 'crash-recovery-test', version: '1.0' });
  t.after(async () => { await client.close(); await Promise.all(children.map(kill)); rmSync(root, { recursive: true, force: true }); });
  async function start(home, name) {
    const child = spawn(process.execPath, [cli, 'start', '--local', '--home', home, '--name', name, '--json'], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child); let errors = ''; child.stderr.on('data', value => { errors = (errors + value).slice(-2000); });
    let status;
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test daemon exited: ${errors}`);
      try { status = await localCall(home, 'status'); return status.online; } catch { return false; }
    }, 'test daemon startup');
    return { child, status };
  }
  const a = await start(homeA, 'Synthetic A'); const b = await start(homeB, 'Synthetic B');
  await localCall(homeB, 'pair', { code: (await localCall(homeA, 'invite')).code });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...process.env, CLANKER_HOME: homeB, CLANKER_CLIENT_ID: 'test', CLANKER_CLIENT_TOKEN: grant.token }, stderr: 'pipe' }));
  const tool = (name, args = {}) => client.callTool({ name, arguments: args });
  const history = data(await tool('clanker_send', { to: a.status.identity.id, text: 'History that must survive a crash.' }));
  await until(async () => (await localCall(homeA, 'inbox')).some(row => row.id === history.id), 'initial message');
  await localCall(homeA, 'read', { id: history.id });
  const request = await localCall(homeA, 'send', { to: b.status.identity.id, kind: 'task_request', text: 'Synthetic task; no command execution.' });
  await until(async () => (await localCall(homeB, 'inbox')).some(row => row.id === request.id), 'task request');
  assert.equal((await tool('clanker_complete_task', { id: request.id, text: 'Premature result' })).isError, true);
  await localCall(homeB, 'decide', { id: request.id, decision: 'approved' });
  await kill(b.child);
  assert.equal((await tool('clanker_status')).isError, true);
  const queued = await localCall(homeA, 'send', { to: b.status.identity.id, text: 'Queued before the sender crashes.' });
  await until(async () => (await localCall(homeA, 'inbox', { direction: 'out' })).find(row => row.id === queued.id)?.attempts > 0, 'offline delivery attempt');
  await kill(a.child);

  const replacementA = await start(homeA, 'Synthetic A'); const replacementB = await start(homeB, 'Synthetic B');
  assert.equal(replacementA.status.identity.id, a.status.identity.id); assert.equal(replacementB.status.identity.id, b.status.identity.id);
  assert.ok((await localCall(homeA, 'peers')).some(peer => peer.id === b.status.identity.id));
  const savedHistory = (await localCall(homeA, 'inbox')).find(row => row.id === history.id); assert.equal(savedHistory.read, 1);
  assert.equal((await localCall(homeA, 'inbox', { direction: 'out' })).find(row => row.id === queued.id).state, 'queued');
  assert.equal((await localCall(homeB, 'inbox')).find(row => row.id === request.id).decision, 'approved');
  // Both random endpoints changed. A fresh invitation is the documented recovery path.
  await localCall(homeB, 'pair', { code: (await localCall(homeA, 'invite')).code });
  await localCall(homeA, 'retry');
  await until(async () => (await localCall(homeA, 'inbox', { direction: 'out' })).find(row => row.id === queued.id)?.state === 'delivered', 'queued message recovery');
  assert.equal((await localCall(homeB, 'inbox')).filter(row => row.id === queued.id).length, 1);
  assert.equal(data(await tool('clanker_status')).identity.id, b.status.identity.id);
  const completed = data(await tool('clanker_complete_task', { id: request.id, text: 'Approved result after recovery.' }));
  await until(async () => (await localCall(homeA, 'inbox')).some(row => row.id === completed.id), 'task result recovery');
  const result = (await localCall(homeA, 'inbox')).find(row => row.id === completed.id);
  assert.equal(result.payload.thread, request.thread); assert.equal(result.payload.replyTo, request.id);
  disableClient(homeB, 'test'); assert.equal((await tool('clanker_inbox')).isError, true);
});

test('a failed tunnel makes the foreground process exit for a supervisor to restart it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-tunnel-exit-')); const fake = join(root, 'cloudflared');
  writeFileSync(fake, `#!${process.execPath}\nconsole.log('https://synthetic-tunnel.trycloudflare.com');\nsetTimeout(() => process.exit(1), 500);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [cli, 'start', '--home', join(root, 'profile'), '--name', 'Synthetic', '--json'], { env: { ...process.env, CLOUDFLARED_BIN: fake }, stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(async () => { await kill(child); rmSync(root, { recursive: true, force: true }); });
  await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
  assert.equal(child.exitCode, 1); assert.equal(child.signalCode, null);
});
