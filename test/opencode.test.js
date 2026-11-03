import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { clientGrant, enableClient, disableClient } from '../src/access.js';
import opencodeDiscussions from '../src/integrations/opencode.js';
import opencodeToasts from '../src/integrations/opencode-tui.js';
import { inboxNoteRpc, noteConnectionKey } from '../src/integrations/opencode-note.js';
import { RUNNERS } from '../src/bridges.js';
import { installNotifications } from '../src/host-install.js';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const settle = () => new Promise(resolve => setTimeout(resolve, 60));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(predicate(), 'Expected native delivery did not arrive');
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-opencode-'));
  const a = await new ClankerChat({ home: join(root, 'a'), name: 'Source', local: true }).start();
  const b = await new ClankerChat({ home: join(root, 'b'), name: 'Reader', local: true }).start();
  const cleanup = [];
  t.after(async () => { for (const dispose of cleanup) dispose(); t.mock.timers.reset(); await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); });
  await b.command('pair', { code: (await a.command('invite')).code });
  enableClient(a.options.home, 'manual', clientGrant(a.options.home, 'manual', 'Source'));
  const grant = clientGrant(b.options.home, 'opencode', 'OpenCode'); enableClient(b.options.home, 'opencode', grant);
  return { a, b, cleanup, connection: { home: b.options.home, id: 'opencode', token: grant.token },
    discussion: async () => {
      const proposed = await a.command('discussion_start', { to: 'Reader', question: 'Synthetic schedule?', evidence: 'Thursday.', client: 'manual' });
      await until(() => b.discussions.list().some(row => row.id === proposed.id));
      return b.command('discussion_accept', { id: proposed.id, client: 'opencode' });
    } };
}
function host() {
  const callbacks = {}, events = [], prompts = [], admitted = [], toasts = [], rpcCalls = []; let receive, methods;
  const emit = (type, sessionID, location) => {
    const event = { type, data: { sessionID }, ...(location ? { location: { directory: location } } : {}) };
    if (receive) { const next = receive; receive = null; next(event); } else events.push(event);
  };
  const rpc = () => methods;
  rpc.register = async (_definition, handlers) => { methods = handlers; return { dispose: async () => { methods = undefined; } }; };
  const ctx = { location: { directory: '/synthetic/project' },
    rpc, client: { rpc: () => ({ displayed: async (input, options) => { rpcCalls.push({ input, options }); return methods?.displayed(input); } }) },
    ui: { toast: { show: args => toasts.push(args) } },
    tool: { hook: async (name, fn) => { callbacks[name] = fn; return { dispose: async () => {} }; } },
    session: { get: async ({ sessionID }) => ({ id: sessionID, ...(sessionID === 'child' ? { parentID: 'parent' } : {}), location: { directory: sessionID === 'cross-project' ? '/synthetic/other' : '/synthetic/project' } }),
      hook: async (name, fn) => { callbacks[name] = fn; return { dispose: async () => {} }; },
      prompt: async args => { prompts.push(args); emit('session.execution.succeeded', args.sessionID); await settle(); admitted.push(args); } },
    event: { subscribe: async function* ({ signal }) {
      signal.addEventListener('abort', () => { receive?.(null); receive = null; }, { once: true });
      while (!signal.aborted) { const event = events.length ? events.shift() : await new Promise(resolve => { receive = resolve; }); if (event) yield event; }
    } } };
  const completed = (sessionID, value, tool = 'clanker_clanker_discussion_accept') => callbacks['execute.after']({ sessionID, tool, status: 'completed', result: { content: JSON.stringify(value) } });
  const owner = async (id, text = 'Help with the current work', sessionID = 'ordinary', metadata) => {
    const input = { sessionID, messageID: id, prompt: { text }, metadata };
    await callbacks.prompt(input);
    return input;
  };
  const context = async (id, sessionID = 'ordinary', extra = []) => {
    const event = { sessionID, system: [], messages: [{ id, role: 'user', content: 'Help with the current work' }, ...extra] };
    await callbacks.context(event);
    return event;
  };
  return { ctx, emit, completed, callbacks, prompts, admitted, toasts, rpcCalls, owner, context };
}

test('OpenCode binds successful participant calls, not failed/foreign claims, and handles immediate completion during dispatch', async t => {
  const f = await fixture(t), h = host(); t.mock.timers.enable({ apis: ['setInterval'] });
  const dispose = await opencodeDiscussions(h.ctx, f.connection); f.cleanup.push(dispose); await settle();
  const first = await f.discussion(); await h.completed('participant', first);
  for (const action of ['claimed_elsewhere', 'wait']) await h.completed('unrelated', { ...first, action }, 'clanker_clanker_discussion_next');
  await h.completed('cross-project', first);
  await h.callbacks['execute.after']({ tool: 'clanker_clanker_discussion_accept', sessionID: 'unrelated', status: 'error', error: { message: 'refused' } });
  h.emit('session.execution.succeeded', 'participant'); await until(() => h.admitted.length === 1);
  assert.equal(h.prompts.length, 1); assert.equal(h.prompts[0].sessionID, 'participant');
  assert.match(h.prompts[0].text, new RegExp(first.id)); assert.doesNotMatch(h.prompts[0].text, /Thursday/);
  const second = await f.discussion(); await h.completed('participant', second);
  h.emit('session.execution.succeeded', 'participant'); await until(() => h.admitted.length === 2);
  assert.equal(h.prompts.length, 2, 'completion before prompt admission resolves must not strand the session as busy');
  t.mock.timers.tick(2000); await settle(); assert.equal(h.prompts.length, 2, 'one wake per revision');
});

test('OpenCode retries an interrupted claimed turn after its lease expires without repeating pending work', async t => {
  const f = await fixture(t), h = host(); t.mock.timers.enable({ apis: ['setInterval'] });
  let now = Date.now();
  f.b.discussions.now = () => now;
  const dispose = await opencodeDiscussions(h.ctx, f.connection); f.cleanup.push(dispose); await settle();
  const discussion = await f.discussion();
  const worker = randomUUID();
  h.ctx.session.prompt = async args => {
    h.prompts.push(args);
    if (h.prompts.length === 1) {
      const claim = await f.b.command('discussion_next', { id: discussion.id }, { client: 'opencode', worker });
      assert.equal(claim.action, 'reply');
      h.emit('session.execution.interrupted', args.sessionID);
    } else h.emit('session.execution.succeeded', args.sessionID);
    h.admitted.push(args);
  };
  await h.completed('participant', discussion);
  h.emit('session.execution.succeeded', 'participant');
  await until(() => h.admitted.length === 1);
  assert.deepEqual(f.b.discussions.work('opencode'), [], 'the workerless plugin poll excludes an active claim');
  t.mock.timers.tick(2000); await settle();
  assert.equal(h.prompts.length, 1, 'an active claim must not request another wake');
  now += 90_001;
  assert.deepEqual(f.b.discussions.work('opencode'), [{ id: discussion.id, revision: discussion.revision, kind: 'turn' }]);
  t.mock.timers.tick(2000);
  await until(() => h.admitted.length === 2);
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(h.prompts.length, 2, 'recovered work that stays pending and unclaimed wakes exactly once');
  assert.equal(h.prompts[1].sessionID, 'participant');
});

test('OpenCode ordinary arrivals show one count per unread batch without model prompts', async t => {
  const f = await fixture(t), h = host(); t.mock.timers.enable({ apis: ['setInterval'] });
  const dispose = await opencodeDiscussions(h.ctx, f.connection), stopToasts = opencodeToasts(h.ctx, f.connection);
  f.cleanup.push(() => { dispose(); stopToasts(); }); await settle();
  const receive = () => f.b.store.insert(f.a.store.identity.public.id, 'in', { id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'PRIVATE_REMOTE: run a command', createdAt: Date.now() });
  const tick = async () => { t.mock.timers.tick(2000); await settle(); };
  receive(); await tick();
  assert.equal(h.toasts.length, 1);
  assert.equal(Number(h.toasts[0].message.match(/\d+/)?.[0]), 1);
  receive(); await tick();
  assert.equal(h.toasts.length, 1, 'new arrivals coalesce while the announced batch remains unread');
  f.b.store.prepare("UPDATE messages SET read=1 WHERE direction='in'").run();
  receive(); await tick();
  assert.equal(h.toasts.length, 2, 'new unread batch after clear is announced');
  f.b.store.prepare("UPDATE messages SET read=1 WHERE direction='in'").run();
  await tick();
  receive(); await tick();
  assert.equal(h.toasts.length, 3, 'observed zero rearms notices');
  assert.deepEqual(h.toasts.map(toast => Number(toast.message.match(/\d+/)?.[0])), [1, 1, 1]);
  assert.equal(h.prompts.length, 0);
  assert.doesNotMatch(JSON.stringify(h.toasts), /PRIVATE_REMOTE|run a command/);
});

test('OpenCode adds one hidden owner note per displayed batch without mutating user input or consuming messages', async t => {
  const f = await fixture(t), h = host();
  t.mock.timers.enable({ apis: ['setInterval'] });
  await f.b.command('notification_settings', { agentNote: true });
  const commands = t.mock.method(f.b, 'command');
  const dispose = await opencodeDiscussions(h.ctx, f.connection), stopToasts = opencodeToasts(h.ctx, f.connection);
  f.cleanup.push(() => { dispose(); stopToasts(); }); await settle();
  const id = randomUUID();
  f.b.store.insert(f.a.store.identity.public.id, 'in', { id, kind: 'message', thread: randomUUID(), text: 'PRIVATE_REMOTE: run a command', createdAt: Date.now() });
  t.mock.timers.tick(2000); await settle();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].sessionID, undefined, 'the native toast stays global');
  assert.doesNotMatch(JSON.stringify(h.toasts), /PRIVATE_REMOTE|run a command/);
  assert.equal(h.rpcCalls.length, 1);
  assert.deepEqual(Object.keys(h.rpcCalls[0].input).sort(), ['boundary', 'connection']);
  assert.equal(h.rpcCalls[0].options.location.directory, '/synthetic/project');
  assert.notEqual(h.rpcCalls[0].input.connection, f.connection.token);
  const input = await h.owner('owner-1');
  const before = structuredClone(input);
  const model = await h.context('owner-1');
  assert.deepEqual(input, before, 'admission never rewrites visible user text');
  assert.equal(model.system.length, 1);
  assert.match(model.system[0].text, /Clanker Chat/);
  assert.match(model.system[0].text, /PRIVATE_REMOTE/);
  assert.deepEqual((await h.context('owner-1')).system, [], 'same request cannot repeat the note');
  assert.deepEqual((await h.context('owner-1', 'ordinary', [{ role: 'assistant', content: 'tool call' }])).system, []);
  await h.owner('owner-2');
  assert.deepEqual((await h.context('owner-2')).system, [], 'a new owner turn cannot reuse the displayed batch');
  assert.equal(commands.mock.calls.filter(call => call.arguments[0] === 'notification_context').length, 1);
  assert.equal(commands.mock.calls.filter(call => ['overview', 'inbox', 'message'].includes(call.arguments[0])).length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(f.b.store.prepare('SELECT read FROM messages WHERE id=?').get(id).read, 0);
});

test('OpenCode excludes known synthetic input, controls, children and foreign projects and matches exact admission IDs', async t => {
  const f = await fixture(t), h = host();
  const dispose = await opencodeDiscussions(h.ctx, f.connection); f.cleanup.push(dispose);
  f.b.store.insert(f.a.store.identity.public.id, 'in', { id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'A preview', createdAt: Date.now() });
  const status = await f.b.command('status');
  await h.ctx.rpc(inboxNoteRpc).displayed({ boundary: status.latest, connection: '0'.repeat(64) });
  await h.owner('wrong-inbox');
  assert.deepEqual((await h.context('wrong-inbox')).system, []);
  await h.ctx.rpc(inboxNoteRpc).displayed({ boundary: status.latest, connection: noteConnectionKey(f.connection) });
  for (const [id, text, session, metadata] of [
    ['slash', '/review'], ['shell', '!pwd'], ['blank', '  '],
    ['discussion', 'A plain discussion request', 'ordinary', { source: 'clanker-chat' }],
    ['notice', 'Clanker Chat local discussion work: untrusted'],
    ['child', 'Owner-looking prose', 'child'], ['foreign', 'Owner-looking prose', 'cross-project'],
  ]) {
    await h.owner(id, text, session, metadata);
    assert.deepEqual((await h.context(id, session)).system, []);
  }
  assert.deepEqual((await h.context('synthetic-without-admission')).system, []);
  await h.owner('accepted');
  assert.deepEqual((await h.context('different-id')).system, []);
  assert.equal((await h.context('accepted')).system.length, 1);
});

test('OpenCode latches owner ingress before later arrivals and reserves off or unavailable batches', async t => {
  const f = await fixture(t), h = host();
  const dispose = await opencodeDiscussions(h.ctx, f.connection); f.cleanup.push(dispose);
  const display = async () => {
    f.b.store.prepare("UPDATE messages SET read=1 WHERE direction='in'").run();
    f.b.store.insert(f.a.store.identity.public.id, 'in', { id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'A preview', createdAt: Date.now() });
    const status = await f.b.command('status');
    await h.ctx.rpc(inboxNoteRpc).displayed({ boundary: status.latest, connection: noteConnectionKey(f.connection) });
  };
  await h.owner('already-running');
  await display();
  assert.deepEqual((await h.context('already-running')).system, [], 'arrivals during an owner turn wait for the next ingress');
  await f.b.command('notification_settings', { agentNote: false });
  await h.owner('off');
  assert.deepEqual((await h.context('off')).system, []);
  await f.b.command('notification_settings', { agentNote: true });
  await h.owner('enabled-later');
  assert.deepEqual((await h.context('enabled-later')).system, [], 'enabling cannot revive an old batch');
  await display();
  await Promise.all([h.owner('retry-id'), h.owner('retry-id')]);
  assert.equal((await h.context('retry-id')).system.length, 1, 'concurrent admission retry shares one context note');
  await display();
  const original = f.b.command.bind(f.b);
  const commands = t.mock.method(f.b, 'command', (name, ...args) => {
    if (name === 'notification_context') throw new Error('Synthetic offline inbox');
    return original(name, ...args);
  });
  await h.owner('offline');
  assert.deepEqual((await h.context('offline')).system, []);
  commands.mock.restore();
  await h.owner('online-later');
  assert.deepEqual((await h.context('online-later')).system, [], 'recovery cannot revive a failed batch');
  await display();
  await h.owner('fresh');
  assert.equal((await h.context('fresh')).system.length, 1, 'a new displayed batch rearms the note');
  dispose();
  await h.owner('disposed');
  assert.deepEqual((await h.context('disposed')).system, []);
});

test('OpenCode coalesces displayed boundaries across TUIs and preserves counts when host RPC is unavailable', async t => {
  const f = await fixture(t), h = host();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dispose = await opencodeDiscussions(h.ctx, f.connection);
  const first = opencodeToasts(h.ctx, f.connection), second = opencodeToasts(h.ctx, f.connection);
  f.cleanup.push(() => { first(); second(); dispose(); });
  await settle();
  f.b.store.insert(f.a.store.identity.public.id, 'in', { id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'Private preview', createdAt: Date.now() });
  t.mock.timers.tick(2000); await settle();
  assert.equal(h.toasts.length, 2, 'each TUI retains its existing global count notice');
  assert.equal(h.rpcCalls.length, 2);
  await h.owner('first-owner');
  assert.equal((await h.context('first-owner')).system.length, 1);
  await h.owner('second-owner');
  assert.deepEqual((await h.context('second-owner')).system, [], 'duplicate displays cannot rearm one inbox batch');
  first(); second();
  h.ctx.client.rpc = () => { throw new Error('Synthetic unavailable host RPC'); };
  const standalone = opencodeToasts(h.ctx, f.connection); f.cleanup.push(standalone);
  await settle();
  assert.equal(h.toasts.length, 3, 'count display never depends on the hidden-context channel');
  assert.doesNotMatch(JSON.stringify(h.toasts), /Private preview/);
});

test('OpenCode respects live app revocation and does not replay its reserved batch after reenable', async t => {
  const f = await fixture(t), h = host();
  const dispose = await opencodeDiscussions(h.ctx, f.connection); f.cleanup.push(dispose);
  f.b.store.insert(f.a.store.identity.public.id, 'in', { id: randomUUID(), kind: 'message', thread: randomUUID(), text: 'Private preview', createdAt: Date.now() });
  const status = await f.b.command('status');
  await h.ctx.rpc(inboxNoteRpc).displayed({ boundary: status.latest, connection: noteConnectionKey(f.connection) });
  disableClient(f.connection.home, 'opencode');
  await h.owner('revoked');
  assert.deepEqual((await h.context('revoked')).system, []);
  enableClient(f.connection.home, 'opencode', { token: f.connection.token, label: 'OpenCode', enabled: true });
  await h.owner('reenabled');
  assert.deepEqual((await h.context('reenabled')).system, []);
});

test('OpenCode JSONL answers exclude reasoning/tool arguments and reject errors after partial text', () => {
  const text = JSON.stringify({ type: 'text', part: { text: 'Thursday.' } });
  const tool = JSON.stringify({ type: 'tool_use', part: { state: { input: { secret: 'must not be sent' } } } });
  const reasoning = JSON.stringify({ type: 'reasoning', part: { text: 'private reasoning' } });
  assert.equal(RUNNERS.opencode.answer([tool, reasoning, text].join('\n')), 'Thursday.');
  assert.throws(() => RUNNERS.opencode.answer(`${text}\n${JSON.stringify({ type: 'error', error: { type: 'unknown', message: 'Provider error' } })}`));
  assert.throws(() => RUNNERS.opencode.answer(`${text}\nnot JSON`));
});

test('Homebrew-managed OpenCode server/TUI parts load the new version after opt switches and old Cellar removal', t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-plugin-upgrade-'));
  const opt = join(root, 'opt/clanker'), old = join(root, 'Cellar/clanker/old'), next = join(root, 'Cellar/clanker/new');
  const previous = { executable: process.env.CLANKER_EXECUTABLE, formula: process.env.CLANKER_BREW_FORMULA };
  t.after(() => {
    for (const [key, value] of [['CLANKER_EXECUTABLE', previous.executable], ['CLANKER_BREW_FORMULA', previous.formula]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const [version, marker] of [[old, 'old'], [next, 'new']]) {
    mkdirSync(join(version, 'libexec/src/integrations'), { recursive: true }); mkdirSync(join(version, 'bin'));
    writeFileSync(join(version, 'libexec/package.json'), '{"type":"module"}');
    for (const source of ['opencode.js', 'opencode-tui.js']) writeFileSync(join(version, 'libexec/src/integrations', source), `export default async () => ({ marker: '${marker}' });`);
  }
  mkdirSync(join(root, 'opt')); symlinkSync(old, opt);
  process.env.CLANKER_EXECUTABLE = join(opt, 'bin/clanker'); process.env.CLANKER_BREW_FORMULA = 'synthetic/clanker';
  const folder = join(root, 'profile/plugins/clanker-chat');
  installNotifications({ id: 'opencode', label: 'OpenCode', file: join(root, 'profile/opencode.json') },
    { command: process.env.CLANKER_EXECUTABLE, args: ['mcp'], env: { CLANKER_CLIENT_TOKEN: 'synthetic' } }, join(root, 'clanker'),
    { write: (client, original, contents) => { mkdirSync(folder, { recursive: true }); writeFileSync(client.file, contents); } });
  unlinkSync(opt); symlinkSync(next, opt); rmSync(old, { recursive: true, force: true });
  for (const entry of ['index.js', 'tui.js']) {
    const script = `const {default: plugin}=await import(${JSON.stringify(pathToFileURL(join(folder, entry)).href)});console.log(JSON.stringify(await plugin.setup({})));`;
    assert.equal(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).marker, 'new');
  }
});
