import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ClankerChat } from '../src/daemon.js';
import { seal, post } from '../src/protocol.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await pause(40); } throw new Error('Timed out'); }

// A stand-in agent: reads the prompt on stdin and answers the question in it.
// "fail" exits with an error, "slow" takes a while, anything else is echoed back
// with the folder it ran in and the access it was given.
const AGENT = `let input = '';
process.stdin.on('data', chunk => input += chunk).on('end', () => {
  const question = input.match(/<question[^>]*>\\n([\\s\\S]*)\\n<\\/question>/)[1];
  if (question.includes('fail')) { console.error('model quota exceeded'); process.exit(3); }
  const answer = () => console.log(\`\${process.cwd()} \${process.env.CLANKER_BRIDGE_TOOLS}: \${question.toUpperCase()}\`);
  question.includes('slow') ? setTimeout(answer, 1500) : answer();
});`;

// Erik's X agent answers by itself; David's runs a command. They paired by code.
async function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bridge-')));
  const folder = join(root, 'david-x-agent'); mkdirSync(folder); writeFileSync(join(folder, 'agent.mjs'), AGENT);
  const start = (name, extra = {}) => new ClankerChat({ home: join(root, name.toLowerCase()), name, local: true, bridges: { retry: 50, ...extra } }).start();
  const people = { erik: await start('Erik', options.erik), david: await start('David', options.david) };
  t.after(async () => { for (const daemon of Object.values(people)) await daemon.close(); rmSync(root, { recursive: true, force: true }); });
  await people.david.command('pair', { code: (await people.erik.command('invite')).code });
  const restart = async name => { await people[name].close(); people[name] = await new ClankerChat({ ...people[name].options }).start(); return people[name]; };
  return { root, folder, people, restart, command: `"${process.execPath}" agent.mjs` };
}
async function open(f) {
  const { erik, david } = f.people;
  await erik.command('bridge', { action: 'propose', to: 'David', topic: 'What we post on X and when', agent: 'X content', app: 'self' });
  await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE state='proposed'").get());
  const accepted = await david.command('bridge', { action: 'accept', bridge: 'Erik', agent: 'Posts', app: 'custom', command: f.command, folder: f.folder });
  await until(() => erik.store.db.prepare("SELECT 1 FROM bridges WHERE state='active'").get());
  return accepted.id;
}
const runs = (daemon, state) => daemon.store.db.prepare('SELECT * FROM bridge_runs WHERE state=?').all(state);

test('opening a bridge needs both owners\' yes; afterwards agents answer each other without them', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  const proposal = { action: 'propose', to: 'David', topic: 'What we post on X and when', agent: 'X content', app: 'self' };
  await assert.rejects(erik.command('bridge', proposal, { client: 'codex' }), /Ask the user first/);
  await erik.command('bridge', { ...proposal, consent: 'chat' }, { client: 'codex' });
  await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE state='proposed'").get());

  // The proposal waits for David; he answers it through his agent.
  const invite = (await david.command('overview')).bridgeInvites[0];
  assert.equal(invite.from, 'Erik'); assert.equal(invite.theirAgent, 'X content'); assert.equal(invite.topic, 'What we post on X and when');
  const acceptance = { action: 'accept', bridge: 'Erik', agent: 'Posts', app: 'custom', command: f.command, folder: f.folder };
  await assert.rejects(david.command('bridge', acceptance, { client: 'claude' }), /Ask the user first/);
  await assert.rejects(erik.command('bridge_send', { bridge: 'David', text: 'too early' }), /waiting for them to accept/);
  await david.command('bridge', { ...acceptance, consent: 'dialog' }, { client: 'claude' });
  await until(() => erik.store.db.prepare("SELECT 1 FROM bridges WHERE state='active'").get());
  assert.equal((await david.command('overview')).bridgeInvites, undefined);

  // Erik's agent asks; David's command answers from its folder, read-only by default.
  const asked = await erik.command('bridge_send', { bridge: "David's Posts", text: 'Are you posting about pricing on Tuesday?', seconds: 20 });
  assert.equal(asked.answer, `${f.folder} read-only: ARE YOU POSTING ABOUT PRICING ON TUESDAY?`);
  assert.equal(asked.to, "David's Posts");

  // David's agent asks back; Erik's agent answers itself, once.
  const seen = (await erik.command('bridge_wait', { bridge: 'David', seconds: 0 })).at(-1).seq;
  const back = await david.command('bridge_send', { bridge: 'Erik', text: 'Which day suits you?' });
  const [question] = await erik.command('bridge_wait', { bridge: 'David', after: seen, seconds: 10 });
  assert.equal(question.type, 'ask');
  assert.equal(question.id, back.id); assert.match(question.answer, /clanker_bridge_answer/);
  await erik.command('bridge_answer', { ask: question.id, text: 'Wednesday works.' });
  await assert.rejects(erik.command('bridge_answer', { ask: question.id, text: 'Again' }), /already answered/);
  await until(async () => (await david.command('bridge_get', { bridge: 'Erik' })).transcript.some(event => event.type === 'answer' && event.text === 'Wednesday works.'));

  // None of this is inbox news for either owner.
  for (const daemon of [erik, david]) {
    const overview = await daemon.command('overview');
    assert.equal(overview.unread, 0); assert.equal(daemon.store.status().unread, 0);
    assert.ok((await daemon.command('inbox', {})).every(row => row.payload.bridgeEvent?.type === 'propose'));
  }
});

test('a failing agent is retried, then the asker hears there is no answer and the owner sees why', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  await open(f);
  const asked = await erik.command('bridge_send', { bridge: 'David', text: 'This will fail' });
  await until(() => runs(david, 'failed').length === 1);
  assert.equal(runs(david, 'failed')[0].attempts, 2);
  await until(async () => (await erik.command('bridge_get', { bridge: 'David' })).transcript.some(event => event.replyTo === asked.id && /No answer: the agent on this side could not run/.test(event.text)));
  const [problem] = (await david.command('overview')).bridgeProblems;
  assert.equal(problem.with, 'Erik'); assert.equal(problem.failed, 1); assert.match(problem.error, /model quota exceeded/);
});

test('closing stops a running answer and ends the bridge on both sides', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  await open(f);
  await erik.command('bridge_send', { bridge: 'David', text: 'A slow question' });
  await until(() => runs(david, 'running').length === 1);
  await erik.command('bridge', { action: 'close', bridge: 'David' });
  await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE state='closed'").get());
  assert.equal(runs(david, 'cancelled').length, 1);
  await pause(2000);
  assert.equal(david.store.db.prepare("SELECT count(*) AS n FROM messages WHERE direction='out' AND json_extract(payload,'$.bridgeEvent.type')='answer'").get().n, 0);
  await assert.rejects(erik.command('bridge_send', { bridge: f.people.erik.bridges.list()[0].id, text: 'Still there?' }), /closed/);
  await assert.rejects(david.command('bridge_send', { bridge: david.bridges.list()[0].id, text: 'Still there?' }), /closed/);
});

test('an answer interrupted by a restart runs again; blocking the contact closes the bridge', async t => {
  const f = await fixture(t), { erik } = f.people;
  await open(f);
  const asked = await erik.command('bridge_send', { bridge: 'David', text: 'A slow question after restart' });
  await until(() => runs(f.people.david, 'running').length === 1);
  const david = await f.restart('david');
  await until(async () => (await erik.command('bridge_get', { bridge: 'David' })).transcript.some(event => event.replyTo === asked.id), 15_000);
  assert.equal(runs(david, 'answered')[0].attempts, 1);
  await erik.command('revoke', { peer: 'David' });
  assert.equal(erik.bridges.list()[0].state, 'closed');
});

test('each side sends at most 30 questions and notes a day; a weekly summary comes once', async t => {
  let shift = 0;
  const f = await fixture(t, { david: { now: () => Date.now() + shift } }), { erik, david } = f.people;
  await open(f);
  await erik.command('bridge_send', { bridge: 'David', text: 'Which day do we post?', seconds: 20 });
  for (let i = 0; i < 29; i++) await erik.command('bridge_send', { bridge: 'David', text: `Note ${i}`, note: true });
  await david.command('bridge_send', { bridge: 'Erik', text: 'Wednesday is ours.', note: true });
  await assert.rejects(erik.command('bridge_send', { bridge: 'David', text: 'One more' }), /limit of 30/);
  await until(() => david.store.db.prepare("SELECT count(*) AS n FROM messages WHERE direction='in' AND json_extract(payload,'$.bridgeEvent.type')='note'").get().n === 29);
  assert.equal((await david.command('overview')).bridgeWeek, undefined);
  shift = 7 * 86_400_000;
  const [week] = (await david.command('overview')).bridgeWeek.bridges;
  assert.equal(week.with, 'Erik'); assert.equal(week.agents, 'Posts ↔ X content');
  assert.deepEqual(week.sinceLastSummary, { since: week.sinceLastSummary.since, theyAsked: 1, youAsked: 0, notes: 30 });
  assert.equal((await david.command('overview')).bridgeWeek, undefined);
});

test('the daily limit counts when questions arrived, not the time a sender claims', async t => {
  let shift = 0;
  const f = await fixture(t, { erik: { now: () => Date.now() + shift } }), { erik, david } = f.people;
  const id = await open(f);
  // A sender backdating its questions, spread out so they never look like a burst, still gets only 30 a day into Erik's agent.
  for (let i = 0; i < 31; i++) {
    if (i && i % 10 === 0) shift += 11 * 60_000;
    const ask = { id: randomUUID(), kind: 'bridge', thread: id, bridge: id, text: `Question ${i}`, createdAt: 1, bridgeEvent: { type: 'ask' } };
    await post(erik.origin, '/v1/messages', seal(david.store.identity, erik.store.identity.public, 'message', ask), true);
  }
  assert.equal((await erik.command('bridge_get', { bridge: 'David' })).unanswered.length, 30);
  assert.deepEqual(runs(erik, 'skipped').map(run => run.error), ['Daily limit reached']);
  assert.equal(erik.bridges.find('David').state, 'active');
});

test('agents stuck in a loop are stopped: an answer cannot ask back, and bursts or repeats pause the bridge until its owner resumes it', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  // David's agent tries to ask back from inside its answer, through Clanker's own CLI.
  writeFileSync(join(f.folder, 'echo.sh'), `#!/bin/sh\ncat >/dev/null\n"${process.execPath}" "${resolve('src/cli.js')}" bridge ask Erik "Ask me back first" --home "${david.options.home}" 2>&1\necho Confirmed.\n`, { mode: 0o755 });
  const id = await open(f);
  await david.command('bridge', { action: 'configure', bridge: 'Erik', command: './echo.sh' });
  const asked = await erik.command('bridge_send', { bridge: 'David', text: 'Which day?', seconds: 20 });
  assert.match(asked.answer, /can only read[\s\S]*Confirmed\./);
  assert.equal(david.store.db.prepare("SELECT count(*) AS n FROM messages WHERE direction='out' AND json_extract(payload,'$.bridgeEvent.type')='ask'").get().n, 0);

  // Erik's agent repeats itself: the third identical question pauses the bridge.
  await erik.command('bridge_send', { bridge: 'David', text: 'Which day?!' });
  await assert.rejects(erik.command('bridge_send', { bridge: 'David', text: 'which day' }), /now paused: The same question came up three times/);
  await assert.rejects(erik.command('bridge_send', { bridge: 'David', text: 'Something new' }), /is paused/);
  assert.match((await erik.command('overview')).bridgeProblems[0].paused, /same question/);
  await assert.rejects(erik.command('bridge', { action: 'resume', bridge: 'David' }, { client: 'claude' }), /Ask the user first/);
  await erik.command('bridge', { action: 'resume', bridge: 'David' });
  await erik.command('bridge_send', { bridge: 'David', text: 'Which day? Last try.' });

  // A burst from the other side pauses it too: with Erik's own question, the twelfth question
  // within ten minutes pauses the bridge, and later ones get a fixed reply and no run.
  for (let i = 0; i < 13; i++) {
    const ask = { id: randomUUID(), kind: 'bridge', thread: id, bridge: id, text: `Burst ${i}`, createdAt: Date.now(), bridgeEvent: { type: 'ask' } };
    await post(erik.origin, '/v1/messages', seal(david.store.identity, erik.store.identity.public, 'message', ask), true);
  }
  assert.equal(erik.bridges.find('David').state, 'paused');
  assert.match(erik.bridges.find('David').pause, /12 questions/);
  assert.deepEqual(runs(erik, 'skipped').map(run => run.error), ['Bridge paused', 'Bridge paused', 'Bridge paused']);
  assert.equal((await erik.command('bridge_get', { bridge: 'David' })).unanswered.length, 10);
  // The owner may close it instead of resuming, and both sides end it.
  assert.equal((await erik.command('bridge', { action: 'close', bridge: 'David' })).state, 'closed');
  await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE state='closed'").get());
});

test('a change that lets the other side see or run more needs a yes; other changes keep the approved app', async t => {
  const f = await fixture(t), { david } = f.people;
  await open(f);
  await assert.rejects(david.command('bridge', { action: 'configure', bridge: 'Erik', share: 'Everything, including internal plans' }, { client: 'claude' }), /Ask the user first/);
  // Two different programs called claude; the bridge keeps the one approved.
  const fake = name => { const dir = join(f.root, name); mkdirSync(dir); writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho hi\n', { mode: 0o755 }); return dir; };
  const approved = fake('approved'), other = fake('other');
  await david.command('bridge', { action: 'configure', bridge: 'Erik', app: 'claude', env: { PATH: approved } });
  await david.command('bridge', { action: 'configure', bridge: 'Erik', app: 'claude', folder: f.folder, env: { PATH: other } }, { client: 'claude' });
  assert.equal(JSON.parse(david.bridges.find('Erik').runner).executable, join(approved, 'claude'));
});

test('the dialog shows a custom command in full, and a yes stays tied to the proposal it described', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  const propose = topic => erik.command('bridge', { action: 'propose', to: 'David', topic, agent: 'X content', app: 'self' });
  const first = await propose('Public posting dates');
  await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE id=? AND state='proposed'").get(first.id));
  // While David reads the dialog, Erik swaps the proposal for a broader one.
  const asked = [];
  const client = new Client({ name: 'synthetic-agent', version: '1.0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    asked.push(request.params.message);
    await erik.command('bridge', { action: 'close', bridge: first.id });
    const second = await propose('Everything you are working on');
    await until(() => david.store.db.prepare("SELECT 1 FROM bridges WHERE id=? AND state='proposed'").get(second.id));
    return { action: 'accept', content: { confirm: true } };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], cwd: f.folder, env: { ...process.env, CLANKER_HOME: david.options.home }, stderr: 'pipe' }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'clanker_bridge', arguments: { action: 'accept', bridge: 'Erik', agent: 'Posts', app: 'custom', command: f.command } });
  assert.match(asked[0], /"Public posting dates"/);
  assert.ok(asked[0].includes(`running this command in ${f.folder}: ${f.command}`));
  assert.match(asked[0], /Clanker cannot make a command read-only/);
  assert.equal(result.isError, true);
  assert.equal(david.store.db.prepare("SELECT count(*) AS n FROM bridges WHERE state='active'").get().n, 0);
});
