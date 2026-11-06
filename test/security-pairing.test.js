import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { TextPrompt } from '@clack/core';
import { ClankerChat } from '../src/daemon.js';
import { decodeInvite, newIdentity, seal } from '../src/protocol.js';
import { text } from '../src/prompts.js';

async function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'cc-security-pair-'));
  const daemons = [];
  t.after(async () => {
    for (const daemon of daemons) await daemon.close();
    rmSync(base, { recursive: true, force: true });
  });
  for (const name of ['Inviter', 'Joiner']) {
    const daemon = new ClankerChat({ home: join(base, name), name, local: true, discovery: false });
    daemons.push(daemon); await daemon.start();
  }
  return { a: daemons[0], b: daemons[1] };
}
async function request(daemon, body) {
  const response = await fetch(`${daemon.origin}/v1/pair`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  return response.status;
}
function wrongToken(daemon, identity) {
  return seal(identity, daemon.store.identity.public, 'pair', {
    identity: identity.public, endpoint: 'http://127.0.0.1:1', token: '0'.repeat(64)
  });
}
function runCLI(t, home, args, input) {
  const child = spawn(process.execPath, [resolve('src/cli.js'), '--home', home, ...args], {
    env: { ...process.env, CLANKER_NO_UPDATE_CHECK: '1', CLANKER_NO_DISCOVERY: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  child.stdin.end(`${input}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Pairing CLI timed out')); }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', status => { clearTimeout(timeout); resolve({ status, stdout, stderr, argv: child.spawnargs }); });
  });
}
function assertPrivate(result, invite) {
  for (const secret of [invite.code, invite.link, decodeInvite(invite.code, true).token]) {
    assert.equal(result.argv.some(arg => arg.includes(secret)), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
}

test('forty malformed pairing requests cannot block a valid invitation in the same window', async t => {
  const { a, b } = await fixture(t);
  const invite = await a.command('invite');
  for (let i = 0; i < 40; i++) assert.equal(await request(a, {}), 400);
  const window = a.rate.at;
  await b.command('pair', { code: invite.code });
  assert.equal(a.rate.at, window);
  assert.equal(a.store.peers()[0].id, b.store.identity.public.id);
});

test('invalid-token flood is throttled but a valid bearer bypasses its exhausted allowance', async t => {
  const { a, b } = await fixture(t);
  const invite = await a.command('invite');
  const envelope = wrongToken(a, newIdentity('Flooder'));
  for (let i = 0; i < 35; i++) assert.equal(await request(a, envelope), i < 30 ? 400 : 429);
  const window = a.rate.at;
  await b.command('pair', { code: invite.link });
  assert.equal(a.rate.at, window);
  assert.equal(a.store.peers()[0].id, b.store.identity.public.id);
});

test('invalid-token throttling does not reveal whether an invitation is open', async t => {
  const { a, b } = await fixture(t);
  await a.command('invite');
  const identity = newIdentity('Flooder');
  const openEnvelope = wrongToken(a, identity), closedEnvelope = wrongToken(b, identity);
  for (let i = 0; i < 32; i++) {
    const expected = i < 30 ? 400 : 429;
    assert.equal(await request(a, openEnvelope), expected);
    assert.equal(await request(b, closedEnvelope), expected);
  }
});

test('invitation token checks preserve stored hashes, expiry and single use', async t => {
  const { a, b } = await fixture(t);
  const first = a.store.invite(), second = a.store.invite();
  assert.equal(a.store.validInvite(first.token), true);
  assert.equal(a.store.validInvite(second.token), true);
  assert.equal(a.store.validInvite('0'.repeat(64)), false);
  assert.equal(a.store.validInvite('not-a-token'), false);
  assert.equal(a.store.prepare('SELECT hash FROM invites').all().some(row => row.hash === first.token), false);
  a.store.acceptInvite(first.token, b.store.identity.public, b.origin);
  assert.equal(a.store.validInvite(first.token), false);
  assert.throws(() => a.store.acceptInvite(first.token, b.store.identity.public, b.origin), /Invalid or used/);
  a.store.prepare('UPDATE invites SET expires=0').run();
  assert.equal(a.store.validInvite(second.token), false);
});

test('pairing from explicit and implicit stdin keeps invite secrets out of argv and output', async t => {
  const { a, b } = await fixture(t);
  for (const args of [['pair', '-', '--json'], ['pair', '--json']]) {
    const invite = await a.command('invite');
    const result = await runCLI(t, b.options.home, args, invite.link);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).paired.id, a.store.identity.public.id);
    assertPrivate(result, invite);
  }
});

test('legacy pairing arguments still work with a secret-free exposure warning', async t => {
  const { a, b } = await fixture(t);
  const invite = await a.command('invite');
  const result = await runCLI(t, b.options.home, ['pair', invite.link, '--json'], '');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /process lists and shell history/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(invite.link), false);
});

test('invalid decoded invitations cannot expose parser excerpts in CLI output', async t => {
  const { b } = await fixture(t);
  const secret = 'b'.repeat(64);
  const code = `cc1:${Buffer.from(`{"token":"${secret}",INVALID}`).toString('base64url')}`;
  const result = await runCLI(t, b.options.home, ['pair', '-', '--json'], code);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid connection link or code/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(code), false);
});

test('hidden pairing prompts never render input while typing, submitting or cancelling', async t => {
  const secret = 'cc1:private-bearer-token';
  const frames = [];
  t.mock.method(TextPrompt.prototype, 'prompt', function () {
    Object.defineProperty(this, 'userInput', { value: secret });
    Object.defineProperty(this, 'userInputWithCursor', { value: secret });
    this.value = secret;
    for (const state of ['initial', 'active', 'submit', 'cancel']) {
      this.state = state; frames.push(this._render());
    }
    return Promise.resolve(secret);
  });
  assert.equal(await text({ message: 'Paste your invite link', secret: true }), secret);
  for (const frame of frames) assert.equal(frame.includes(secret), false);
});
