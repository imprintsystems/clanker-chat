import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ClankerChat } from '../src/daemon.js';
import { newIdentity } from '../src/protocol.js';
import { findExecutable, executableSearchPath } from '../src/clients.js';
import { launchCommand, startInstalledService } from '../src/setup.js';

const source = name => new URL(`../src/${name}`, import.meta.url).href;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-security-runner-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function executable(path, body = '') {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}
function child(code, cwd, env = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15_000,
  });
}

test('findExecutable ignores empty and relative PATH entries, directories and non-executables', t => {
  const root = fixture(t), blocked = join(root, 'blocked'), safe = join(root, 'safe');
  mkdirSync(blocked); mkdirSync(safe); mkdirSync(join(blocked, 'codex'));
  executable(join(safe, 'codex'));
  writeFileSync(join(blocked, 'claude'), 'not executable', { mode: 0o644 });
  assert.equal(findExecutable('codex', `bin${delimiter}.${delimiter}${delimiter}${blocked}${delimiter}${safe}`), realpathSync(join(safe, 'codex')));
  assert.equal(findExecutable('claude', blocked), null);
  assert.equal(findExecutable('codex', `bin${delimiter}.${delimiter}`), null);
  assert.equal(executableSearchPath(`.${delimiter}${safe}${delimiter}bin${delimiter}`), safe);
  symlinkSync(join(safe, 'codex'), join(blocked, 'alias'));
  assert.equal(findExecutable('alias', blocked), realpathSync(join(safe, 'codex')));
});

const bridgeScenario = legacy => `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from ${JSON.stringify(source('store.js'))};
import { Bridges } from ${JSON.stringify(source('bridges.js'))};
import { newIdentity, messageSchema } from ${JSON.stringify(source('protocol.js'))};
const root = process.env.SCENARIO_ROOT;
const store = new Store(join(root, 'home'), 'Owner'), peer = newIdentity('Contact').public;
store.savePeer(peer, 'http://127.0.0.1:1');
const bridges = new Bridges(store);
try {
  const args = { to: peer.id, topic: 'Schedule', agent: 'Local', app: 'codex', folder: join(root, 'project'), env: { PATH: process.env.PATH } };
  const check = bridges.check('propose', args);
  const proposed = bridges.propose(args), id = proposed.id;
  const message = (event, text) => messageSchema.parse({ id: randomUUID(), kind: 'bridge', thread: id, bridge: id, text, createdAt: Date.now(), bridgeEvent: event });
  bridges.receive(peer.id, message({ type: 'accept', agent: 'Remote' }, 'Accepted'));
  ${legacy ? `const legacyRunner = JSON.parse(bridges.row(id).runner);
  legacyRunner.executable = 'bin/codex';
  legacyRunner.env.PATH = process.env.PATH;
  store.prepare('UPDATE bridges SET runner=? WHERE id=?').run(JSON.stringify(legacyRunner), id);` : ''}
  const ask = message({ type: 'ask' }, 'Which day?');
  bridges.receive(peer.id, ask);
  store.prepare("UPDATE bridge_runs SET state='running',attempts=1 WHERE ask=?").run(ask.id);
  await bridges.run({ bridge: id, ask: ask.id });
  const run = store.prepare('SELECT * FROM bridge_runs WHERE ask=?').get(ask.id);
  const runner = JSON.parse(bridges.row(id).runner);
  console.log(JSON.stringify({ runner, consent: check.runner, run, widens: bridges.check('configure', { bridge: id }).widens,
    approvedRan: existsSync(join(root, 'approved-ran')), projectRan: existsSync(join(root, 'project-ran')), relativeRan: existsSync(join(root, 'relative-ran')) }));
} finally { bridges.stop(); store.close(); }
`;
function bridgeFixture(t) {
  const root = fixture(t), approval = join(root, 'approval'), safe = join(root, 'safe'), project = join(root, 'project');
  for (const dir of [join(approval, 'bin'), join(project, 'bin'), safe]) mkdirSync(dir, { recursive: true });
  const agent = (marker, answer) => `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(root, marker))}, 'ran'); fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], ${JSON.stringify(answer)});`;
  executable(join(approval, 'bin/codex'), agent('relative-ran', 'relative approval'));
  executable(join(project, 'bin/codex'), agent('project-ran', 'substituted project binary'));
  executable(join(safe, 'real-codex'), agent('approved-ran', 'approved answer'));
  symlinkSync(join(safe, 'real-codex'), join(safe, 'codex'));
  return { root, approval, safe };
}

test('bridge approval and execution in different folders never run a relative-PATH project substitute', t => {
  const { root, approval, safe } = bridgeFixture(t);
  const result = JSON.parse(child(bridgeScenario(false), approval, { PATH: `bin${delimiter}${safe}`, SCENARIO_ROOT: root }));
  assert.equal(result.projectRan, false);
  assert.equal(result.relativeRan, false);
  assert.equal(result.approvedRan, true);
  assert.equal(result.runner.executable, join(safe, 'real-codex'));
  assert.equal(result.consent.executable, result.runner.executable);
  assert.equal(result.runner.env.PATH, safe);
  assert.equal(result.run.state, 'answered');
});

test('legacy relative bridge runners fail closed and require owner re-approval', t => {
  const { root, approval, safe } = bridgeFixture(t);
  const result = JSON.parse(child(bridgeScenario(true), approval, { PATH: `bin${delimiter}${safe}`, SCENARIO_ROOT: root }));
  assert.equal(result.projectRan, false);
  assert.equal(result.approvedRan, false);
  assert.equal(result.run.state, 'failed');
  assert.match(result.run.error, /re-approve/);
  assert.equal(result.widens, true);
});

test('source launch configs pin Node and the CLI and reject relative executable overrides', t => {
  const home = fixture(t), launch = launchCommand(home, 'src/cli.js', {});
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [resolve('src/cli.js'), 'mcp']);
  assert.throws(() => launchCommand(home, '/src/cli.js', { CLANKER_EXECUTABLE: 'bin/clanker' }), /absolute path/);
});

test('agent launch ignores relative PATH candidates and strips them from the child environment', t => {
  const root = fixture(t), safe = join(root, 'safe'); mkdirSync(join(root, 'bin')); mkdirSync(safe);
  executable(join(root, 'bin/claude'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'project-ran'))}, 'ran');`);
  executable(join(safe, 'claude'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'approved-ran'))}, process.env.PATH);`);
  child(`import { launchAgent } from ${JSON.stringify(source('host-launch.js'))}; process.exitCode = await launchAgent('claude', []);`, root, { PATH: `bin${delimiter}${safe}` });
  assert.equal(existsSync(join(root, 'project-ran')), false);
  assert.equal(existsSync(join(root, 'approved-ran')), true);
  assert.equal(readFileSync(join(root, 'approved-ran'), 'utf8'), safe);
});

test('source-mode tunnel startup refuses cloudflared from a relative PATH entry', t => {
  const root = fixture(t); mkdirSync(join(root, 'bin'));
  executable(join(root, 'bin/cloudflared'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'project-ran'))}, 'ran');`);
  child(`import assert from 'node:assert/strict'; import { ClankerChat } from ${JSON.stringify(source('daemon.js'))};
    const daemon = new ClankerChat({ home: ${JSON.stringify(root)} });
    await assert.rejects(daemon.startTunnel(), /cloudflared.*absolute PATH/);`, root, { PATH: 'bin' });
  assert.equal(existsSync(join(root, 'project-ran')), false);
});

test('Homebrew service setup uses a canonical executable and never a relative PATH entry', async t => {
  const root = fixture(t), bin = join(root, 'bin'); mkdirSync(bin); executable(join(bin, 'brew'));
  const calls = [];
  await startInstalledService(root, { formula: 'owner/tap/clanker', wait: false, env: { PATH: `bin${delimiter}${bin}` }, run: (command, args) => calls.push({ command, args }) });
  assert.equal(calls[0].command, realpathSync(join(bin, 'brew')));
  await assert.rejects(startInstalledService(root, { formula: 'owner/tap/clanker', wait: false, env: { PATH: 'bin' }, run: () => assert.fail('must not run') }), /absolute PATH/);
});

test('bridge setup rejects a symlink target changed after its canonical path was shown for approval', t => {
  const { root, approval, safe } = bridgeFixture(t);
  executable(join(safe, 'replacement'));
  child(`import assert from 'node:assert/strict';
    import { unlinkSync, symlinkSync } from 'node:fs';
    import { join } from 'node:path';
    import { Store } from ${JSON.stringify(source('store.js'))};
    import { Bridges } from ${JSON.stringify(source('bridges.js'))};
    import { newIdentity } from ${JSON.stringify(source('protocol.js'))};
    const root = process.env.SCENARIO_ROOT, store = new Store(join(root, 'home'));
    const bridges = new Bridges(store), peer = newIdentity('Contact').public;
    try {
      store.savePeer(peer, 'http://127.0.0.1:1');
      const input = { to: peer.id, topic: 'Schedule', agent: 'Local', app: 'codex', folder: join(root, 'project'), env: { PATH: process.env.PATH } };
      const checked = bridges.check('propose', input);
      unlinkSync(join(root, 'safe/codex')); symlinkSync(join(root, 'safe/replacement'), join(root, 'safe/codex'));
      assert.throws(() => bridges.propose({ ...input, executable: checked.runner.executable }), /changed during approval/);
    } finally { bridges.stop(); store.close(); }`, approval, { PATH: safe, SCENARIO_ROOT: root });
});

test('bridge consent shows the canonical executable that will be approved', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-security-consent-')));
  const approval = join(root, 'approval'), safe = join(root, 'safe'), home = join(root, 'home');
  for (const folder of [approval, safe, join(root, 'project')]) mkdirSync(folder);
  executable(join(safe, 'real-codex')); symlinkSync(join(safe, 'real-codex'), join(safe, 'codex'));
  const daemon = await new ClankerChat({ home, name: 'Owner', local: true, discovery: false }).start();
  const client = new Client({ name: 'security-runner', version: '1.0' }, { capabilities: { elicitation: {} } });
  t.after(async () => { await client.close(); await daemon.close(); rmSync(root, { recursive: true, force: true }); });
  daemon.store.savePeer(newIdentity('Contact').public, 'http://127.0.0.1:1');
  const questions = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    questions.push(request.params.message);
    return { action: 'cancel' };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'mcp'], cwd: approval,
    env: { ...process.env, CLANKER_HOME: home, PATH: `bin${delimiter}${safe}` }, stderr: 'pipe' }));
  await client.callTool({ name: 'clanker_bridge', arguments: {
    action: 'propose', to: 'Contact', topic: 'Schedule', agent: 'Local', app: 'codex', folder: join(root, 'project'),
  } });
  assert.equal(questions.length, 1);
  assert.ok(questions[0].includes(join(safe, 'real-codex')));
  assert.equal(daemon.store.prepare('SELECT count(*) AS n FROM bridges').get().n, 0);
});
