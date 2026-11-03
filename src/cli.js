#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defaultHome } from './store.js';
import { localCall } from './local.js';
import { VERSION } from './version.js';
import { heading, hint, rows, theme, clean, printResult, printHelp, printInvite, failure } from './terminal.js';

async function main() {
  process.umask(0o077);
  if(process.argv[2]==='agent' && !['--help', '-h'].includes(process.argv[3])) {const {launchAgent}=await import('./host-launch.js');process.exitCode=await launchAgent(process.argv[3],process.argv.slice(4));return;}
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, name: { type: 'string' }, port: { type: 'string' },
    file: { type: 'string' }, kind: { type: 'string' }, thread: { type: 'string' },
    'reply-to': { type: 'string' }, unread: { type: 'boolean' }, after: { type: 'string' },
    client: { type: 'string', multiple: true }, 'no-service': { type: 'boolean' },
    'agent-home': {type:'string'}, 'agent-bin': {type:'string'},
    'agent-note': {type:'string'},
    'max-turns': {type:'string'}, minutes:{type:'string'},
    local: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, all: { type: 'boolean' },
    json: { type: 'boolean' }, list: { type: 'boolean' }, version: { type: 'boolean', short: 'v' }, clear: { type: 'boolean' },
    topic: { type: 'string' }, agent: { type: 'string' }, app: { type: 'string' }, folder: { type: 'string' }, tools: { type: 'string' },
    command: { type: 'string' }, share: { type: 'string' }, note: { type: 'string' }, wait: { type: 'boolean' }
  } });
  let [command, target, ...words] = positionals;
  const home = resolve(values.home || defaultHome());
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !values.json;
  const cli = fileURLToPath(import.meta.url);
  const peerNames = ['inbox', 'outbox', 'watch', 'discuss'];
  const output = async (action, value) => values.json ? console.log(JSON.stringify(value, null, 2)) : printResult(action, value, peerNames.includes(action) ? { peers: await localCall(home, 'peers') } : {});
  if (values.version) return console.log(`clanker ${VERSION}`);
  if (values.help || command === 'help') return printHelp(command === 'help' ? target || (values.help ? 'help' : undefined) : command, { all: !!values.all, target: command === 'help' ? words[0] : target });
  if (!command) return printHelp();
  if (command === 'home' && !interactive) throw new Error('The home menu needs an interactive terminal. Ask your agent what needs attention, or run clanker inbox, clanker status or clanker help --all.');
  if (!['start', 'mcp', 'notify', 'setup', 'agents', 'config'].includes(command)) { const { restartIfOutdated } = await import('./setup.js'); await restartIfOutdated(home); }
  if (command === 'home') {
    const { readProfile } = await import('./setup.js');
    if (!readProfile(home).name) return hint('Ask your agent to set up Clanker Chat, or run `clanker setup` when you are ready.');
    const { showHome } = await import('./onboarding.js');
    command = await showHome(home);
    if (!command) return;
  }
  if (command === 'mcp') { const { serveMCP } = await import('./mcp.js'); return serveMCP(home); }
  if(command==='notify' && ['codex','claude'].includes(target)) {const {runNotificationHook}=await import('./host-launch.js');await runNotificationHook(home,target,{agentHome:values['agent-home'],executable:values['agent-bin']});return;}
  if (command === 'notifications') {
    if (values['agent-note'] !== undefined) {
      if (!['on', 'off'].includes(values['agent-note'])) throw new Error('Use --agent-note on or --agent-note off.');
      await localCall(home, 'notification_settings', { agentNote: values['agent-note'] === 'on' });
    }
    const { readAccess } = await import('./access.js');
    const agentNote = readAccess(home).agentNote;
    const alerts = await localCall(home, 'notifications');
    if (values.json) return console.log(JSON.stringify({ agentNote, sessions: alerts }, null, 2));
    heading('Inbox notifications');
    rows([['Agent note', agentNote ? 'on' : 'off']]);
    hint('Change with `clanker notifications --agent-note on|off`.');
    if (!alerts.length) return hint('No live Codex alert hooks. Open /hooks in Codex and trust Clanker Chat alerts.');
    rows(alerts.map(row => ['Codex', `${row.session}${row.error ? ` · ${clean(row.error)}` : ''}`])); console.log(); return;
  }
  if (command === 'config') {
    const { launchCommand } = await import('./setup.js'); const { readAccess } = await import('./access.js');
    const access = readAccess(home); const grant = access.clients.manual;
    if (access.enforced && !grant?.enabled) throw new Error('Select Other MCP app in clanker agents before copying manual settings.');
    const launch = launchCommand(home, cli);
    if (grant?.enabled) Object.assign(launch.env, { CLANKER_CLIENT_ID: 'manual', CLANKER_CLIENT_TOKEN: grant.token });
    return console.log(JSON.stringify({ mcpServers: { clanker: launch } }, null, 2));
  }
  if (command === 'setup' || command === 'agents') {
    const { discoverClients } = await import('./clients.js'); const { readAccess } = await import('./access.js');
    if (command === 'agents' && (values.list || (!interactive && !values.client))) {
      const access = readAccess(home); const { codexAlertsInstalled } = await import('./host-install.js');
      const rows_ = discoverClients().map(client => {
        const { id, label, detected, available, hint } = client; const connected = !!access.clients[id]?.enabled;
        return { id, label, detected, available, hint, connected, ...(id === 'codex' && connected ? { alerts: codexAlertsInstalled(client) } : {}) };
      });
      if (values.json) return console.log(JSON.stringify(rows_, null, 2));
      heading('Connected apps');
      const pad = Math.max(...rows_.map(row => row.label.length)) + 3;
      for (const row of rows_) console.log(`  ${row.connected ? theme.good('●') : theme.muted('○')} ${row.label.padEnd(pad)}${theme.muted(row.connected ? 'connected' : row.hint)}${row.alerts === false ? theme.warn(' · alerts not set up') : ''}`);
      console.log();
      if (rows_.some(row => row.alerts === false)) hint('Codex was connected before alerts existed. Run `clanker agents`, keep Codex selected, then trust the hook in Codex with `/hooks`.');
      else hint('Choose access with `clanker agents`.');
      return;
    }
    const { runSetup } = await import('./onboarding.js');
    const result = await runSetup({ home, cli, name: values.name, selected: values.client?.flatMap(value => value.split(',')).filter(Boolean), noService: !!values['no-service'], json: !!values.json, agentsOnly: command === 'agents', interactive });
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'start') {
    const { ClankerChat } = await import('./daemon.js'); const { readProfile } = await import('./setup.js');
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be a number from 0 to 65535.');
    const name = values.name || readProfile(home).name;
    if (name !== undefined && (!name.trim() || name.length > 80)) throw new Error('Name must have 1 to 80 characters.');
    const brew = !!process.env.CLANKER_BREW_FORMULA;
    const daemon = new ClankerChat({ home, name, port, local: !!values.local, cloudflared: process.env.CLOUDFLARED_BIN, updateCheck: brew && !process.env.CLANKER_NO_UPDATE_CHECK });
    daemon.on('warning', value => console.error(`clanker: ${value}`));
    daemon.on('message', () => console.error('New Clanker Chat message. Run clanker inbox.'));
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await daemon.close(); };
    daemon.on('tunnelStopped', () => { process.exitCode = 1; stop(); });
    await daemon.start(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (brew) {
      // New versions may bring new hooks or plugins. Rewrite only the agents the
      // user already chose, so an upgrade never needs setup again.
      if (daemon.upgraded) {
        const { discoverClients, refreshClients } = await import('./clients.js'); const { launchCommand } = await import('./setup.js');
        for (const row of refreshClients(home, launchCommand(home, cli), discoverClients())) console.error(`clanker: ${row.id} ${row.state}${row.note ? `: ${row.note}` : ''}`);
      }
      // brew upgrade swaps the files under this service. Exit when the installed
      // version changes; the service manager starts the new one.
      const installed = process.env.CLANKER_EXECUTABLE && resolve(process.env.CLANKER_EXECUTABLE, '../../libexec/package.json');
      if (installed) setInterval(() => {
        try { if (JSON.parse(readFileSync(installed, 'utf8')).version !== VERSION) { console.error('clanker: a new version is installed, restarting'); stop(); } } catch { /* Mid-upgrade; check again later. */ }
      }, 60_000).unref();
    }
    return output('status', { ...daemon.store.status(), online: daemon.endpointReady });
  }
  const call = (action, args = {}) => localCall(home, action, args);
  const content = () => values.file ? readFileSync(values.file, 'utf8') : words.join(' ');
  const sendContent = () => ({
    ...(words.length ? { text: words.join(' ') } : {}),
    ...(values.file !== undefined ? { file: resolve(values.file) } : {}),
    kind: values.kind || 'message',
    ...(values.thread ? { thread: values.thread } : {}),
    ...(values['reply-to'] ? { replyTo: values['reply-to'] } : {})
  });
  switch (command) {
    case 'discuss': {
      const selected=values.client?.flatMap(value=>value.split(','));
      const oneClient=()=>{if(selected?.length!==1)throw new Error('Choose one connected agent with --client <app-id>. See clanker agents --list.');return selected[0];};
      let result;
      if(target==='ask')result=await call('discussion_start',{to:words[0],question:words.slice(1).join(' '),evidence:values.file?readFileSync(values.file,'utf8'):'',client:oneClient(),...(values['max-turns']?{maxTurns:Number(values['max-turns'])}:{}),...(values.minutes?{minutes:Number(values.minutes)}:{})});
      else if(target==='list')result=await call('discussion_list');
      else if(target==='show')result=await call('discussion_get',{id:words[0]});
      else if(target==='accept')result=await call('discussion_accept',{id:words[0],client:oneClient()});
      else if(['stop','decline'].includes(target))result=await call('discussion_stop',{id:words[0],reason:target==='decline'?'declined':'stopped'});
      else throw new Error('Use clanker discuss ask, list, show, accept, stop or decline.');
      await output('discuss',result);break;
    }
    case 'party': {
      const need = (value, usage) => { if (!value) throw new Error(`Use clanker party ${usage}.`); return value; };
      let result;
      if (!target || target === 'list') result = await call('parties');
      else if (target === 'show') result = await call('party_get', { party: need(words[0], 'show <party>') });
      else if (target === 'create') result = await call('party', { action: 'create', name: need(words.join(' '), 'create <name>') });
      else if (target === 'add') result = await call('party', { action: 'add', party: need(words[0], 'add <party> <contact>'), contact: need(words.slice(1).join(' '), 'add <party> <contact>') });
      else if (target === 'remove') result = await call('party', { action: 'remove', party: need(words[0], 'remove <party> <member>'), member: need(words.slice(1).join(' '), 'remove <party> <member>') });
      else if (['leave', 'close', 'decline'].includes(target)) result = await call('party', { action: target, party: need(words[0], `${target} <party>`) });
      else if (target === 'join') result = await call('party_join', { party: need(words[0], 'join <party>') });
      else if (target === 'send') { const party = need(words.shift(), 'send <party> [caption] --file <path>, or send <party> <text>'); result = await call('send', { party, ...sendContent() }); }
      else throw new Error('Use clanker party list, show, create, add, join, decline, send, remove, leave or close.');
      await output(target === 'send' ? 'send' : 'party', result); break;
    }
    case 'bridge': {
      const need = (value, usage) => { if (!value) throw new Error(`Use clanker bridge ${usage}.`); return value; };
      const { ENV_KEYS } = await import('./bridges.js');
      // How this side answers, from the options given. The folder defaults to here.
      const runner = fresh => ({ ...Object.fromEntries(['app', 'tools', 'command', 'share'].filter(key => values[key] !== undefined).map(key => [key, values[key]])),
        ...(values.folder !== undefined || fresh ? { folder: resolve(values.folder || '.') } : {}),
        env: Object.fromEntries(ENV_KEYS.filter(key => process.env[key]).map(key => [key, process.env[key]])) });
      let result;
      if (!target || target === 'list') result = await call('bridges');
      else if (target === 'show') result = await call('bridge_get', { bridge: need(words.join(' '), 'show <bridge>') });
      else if (target === 'propose') result = await call('bridge', { action: 'propose', to: need(words.join(' '), 'propose <contact> --topic <topic> --agent <name> --app <app>'), topic: values.topic, agent: values.agent, ...(values.note ? { note: values.note } : {}), ...runner(true) });
      else if (target === 'accept') result = await call('bridge', { action: 'accept', bridge: need(words.join(' '), 'accept <bridge> --agent <name> --app <app>'), agent: values.agent, ...runner(true) });
      else if (target === 'configure') result = await call('bridge', { action: 'configure', bridge: need(words.join(' '), 'configure <bridge> --app <app>'), ...runner(false) });
      else if (['decline', 'close', 'resume'].includes(target)) result = await call('bridge', { action: target, bridge: need(words.join(' '), `${target} <bridge>`) });
      else if (target === 'ask' || target === 'note') {
        const bridge = need(words.shift(), `${target} <bridge> <text>`), text = need(content(), `${target} <bridge> <text>`);
        result = await call('bridge_send', { bridge, text, note: target === 'note', seconds: target === 'ask' && values.wait ? 20 : 0 });
        // A script can wait up to five minutes for the other agent's answer.
        for (let after = 0, end = Date.now() + 300_000; target === 'ask' && values.wait && !result.answer && Date.now() < end;) {
          for (const event of await call('bridge_wait', { bridge: result.bridge, after, seconds: 20 })) { after = event.seq; if (event.type === 'answer' && event.replyTo === result.id) result = { ...result, answer: event.text }; }
        }
        await output('bridge-send', result); break;
      }
      else if (target === 'answer') result = await call('bridge_answer', { ask: need(words.shift(), 'answer <question-id> <text>'), text: need(content(), 'answer <question-id> <text>') });
      else throw new Error('Use clanker bridge list, show, propose, accept, configure, ask, note, answer, resume, decline or close.');
      await output(target === 'answer' ? 'bridge-send' : 'bridge', result); break;
    }
    case 'invite': {
      const invite = await call('invite');
      if (values.json) console.log(JSON.stringify(invite));
      else printInvite(invite.link);
      break;
    }
    case 'pair': {
      let code = target;
      if (!code && interactive) {
        const p = await import('./prompts.js'); code = await p.text({ message: 'Paste your invite link', placeholder: 'https://clanker.imprintsystems.ai/connect/#cc1:…' });
        if (p.isCancel(code)) return;
      } else if (!code) {
        const { createInterface } = await import('node:readline/promises'); const input = createInterface({ input: process.stdin, terminal: false });
        for await (const text of input) { code = text.trim(); input.close(); break; }
      }
      await output('pair', await call('pair', { code: code?.trim() })); break;
    }
    case 'send': await output('send', await call('send', { to: target, ...sendContent() })); break;
    case 'save-file': {
      if (!target || words.length !== 1) throw new Error('Use clanker save-file <message-id> <destination-path>, including the full filename.');
      await output(command, await call('save_file', { id: target, path: resolve(words[0]) })); break;
    }
    case 'inbox': case 'outbox': await output(command, await call('inbox', { unread: !!values.unread, after: Number(values.after || 0), direction: command === 'outbox' ? 'out' : 'in' })); break;
    case 'read': await output(command, await call('read', { id: target })); break;
    case 'approve': case 'decline': await output(command, await call('decide', { id: target, decision: command === 'approve' ? 'approved' : 'declined' })); break;
    case 'complete': await output(command, await call('complete', { id: target, text: content() })); break;
    case 'revoke': await output(command, await call('revoke', { peer: target })); break;
    case 'nickname': {
      if (!target || (!words.length && !values.clear)) throw new Error('Use clanker nickname <name> <nickname>, or clanker nickname <name> --clear.');
      await output(command, await call('nickname', { peer: target, nickname: values.clear ? null : words.join(' ') })); break;
    }
    case 'status': case 'peers': case 'retry': await output(command, await call(command)); break;
    case 'watch': {
      let after = Number(values.after || 0);
      if (!values.json) heading('Waiting for messages', 'Ctrl-C to stop');
      while (true) { const rows_ = await call('wait', { after, seconds: 20 }); if (rows_.length) await output('watch', rows_); for (const row of rows_) after = row.seq; }
    }
    default: throw new Error(`Unknown command: ${command}. Run clanker --help.`);
  }
}
main().catch(error => {
  if (error.constructor.name === 'Cancelled') { process.exitCode = 0; return; }
  process.exitCode = 1;
  if (error.syscall === 'connect' && ['ECONNREFUSED', 'ENOENT'].includes(error.code)) return failure('Your inbox is not running.', 'Start it with `clanker setup`, or `clanker start` for a source checkout.');
  failure(error.message);
});
