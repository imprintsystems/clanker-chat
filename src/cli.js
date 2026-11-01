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
  if(process.argv[2]==='agent') {const {launchAgent}=await import('./host-launch.js');process.exitCode=await launchAgent(process.argv[3],process.argv.slice(4));return;}
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, name: { type: 'string' }, port: { type: 'string' },
    file: { type: 'string' }, kind: { type: 'string' }, thread: { type: 'string' },
    'reply-to': { type: 'string' }, unread: { type: 'boolean' }, after: { type: 'string' },
    client: { type: 'string', multiple: true }, 'no-service': { type: 'boolean' },
    'agent-home': {type:'string'}, 'agent-bin': {type:'string'},
    'max-turns': {type:'string'}, minutes:{type:'string'},
    local: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' }, list: { type: 'boolean' }, version: { type: 'boolean', short: 'v' }
  } });
  let [command, target, ...words] = positionals;
  const home = resolve(values.home || defaultHome());
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !values.json;
  const cli = fileURLToPath(import.meta.url);
  const peerNames = ['inbox', 'outbox', 'watch', 'discuss'];
  const output = async (action, value, extra = {}) => values.json ? console.log(JSON.stringify(value, null, 2)) : printResult(action, value, { ...extra, ...(peerNames.includes(action) ? { peers: await localCall(home, 'peers') } : {}) });
  if (values.version) return console.log(`clanker ${VERSION}`);
  if (values.help || command === 'help') return printHelp();
  if (!command) {
    if (!interactive) return printHelp();
    const { readProfile } = await import('./setup.js');
    if (!readProfile(home).name) command = 'setup';
    else { const { showHome } = await import('./onboarding.js'); command = await showHome(home); if (!command) return; }
  }
  if (command === 'mcp') { const { serveMCP } = await import('./mcp.js'); return serveMCP(home); }
  if(command==='notify' && target==='codex') {const {runCodexHook}=await import('./host-launch.js');await runCodexHook(home,{agentHome:values['agent-home'],executable:values['agent-bin']});return;}
  if (command === 'notifications') {
    const alerts = await localCall(home, 'notifications');
    if (values.json) return console.log(JSON.stringify(alerts, null, 2));
    heading('Session alerts', alerts.length ? String(alerts.length) : '');
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
      heading('Agents on this computer');
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
    const daemon = new ClankerChat({ home, name, port, local: !!values.local, cloudflared: process.env.CLOUDFLARED_BIN });
    daemon.on('warning', value => console.error(`clanker: ${value}`));
    daemon.on('message', () => console.error('New Clanker Chat message. Run clanker inbox.'));
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await daemon.close(); };
    daemon.on('tunnelStopped', () => { process.exitCode = 1; stop(); });
    await daemon.start(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return output('status', { ...daemon.store.status(), online: daemon.endpointReady });
  }
  const call = (action, args = {}) => localCall(home, action, args);
  const content = () => values.file ? readFileSync(values.file, 'utf8') : words.join(' ');
  switch (command) {
    case 'discuss': {
      const selected=values.client?.flatMap(value=>value.split(','));
      const oneClient=()=>{if(selected?.length!==1)throw new Error('Choose one connected agent with --client codex, claude, hermes or omp.');return selected[0];};
      let result;
      if(target==='ask')result=await call('discussion_start',{to:words[0],question:words.slice(1).join(' '),evidence:values.file?readFileSync(values.file,'utf8'):'',client:oneClient(),...(values['max-turns']?{maxTurns:Number(values['max-turns'])}:{}),...(values.minutes?{minutes:Number(values.minutes)}:{})});
      else if(target==='list')result=await call('discussion_list');
      else if(target==='show')result=await call('discussion_get',{id:words[0]});
      else if(target==='accept')result=await call('discussion_accept',{id:words[0],client:oneClient()});
      else if(['stop','decline'].includes(target))result=await call('discussion_stop',{id:words[0],reason:target==='decline'?'declined':'stopped'});
      else throw new Error('Use clanker discuss ask, list, show, accept, stop or decline.');
      await output('discuss',result);break;
    }
    case 'invite': {
      const invite = await call('invite');
      if (values.json) console.log(JSON.stringify(invite));
      else printInvite(invite.code);
      break;
    }
    case 'pair': {
      let code = target;
      if (!code && interactive) {
        const p = await import('./prompts.js'); code = await p.text({ message: 'Paste your invite code', placeholder: 'cc1:…' });
        if (p.isCancel(code)) return;
      } else if (!code) {
        const { createInterface } = await import('node:readline/promises'); const input = createInterface({ input: process.stdin, terminal: false });
        for await (const text of input) { code = text.trim(); input.close(); break; }
      }
      await output('pair', await call('pair', { code: code?.trim() })); break;
    }
    case 'send': await output('send', await call('send', { to: target, text: content(), kind: values.kind || 'message', ...(values.thread ? { thread: values.thread } : {}), ...(values['reply-to'] ? { replyTo: values['reply-to'] } : {}) }), { to: target }); break;
    case 'inbox': case 'outbox': await output(command, await call('inbox', { unread: !!values.unread, after: Number(values.after || 0), direction: command === 'outbox' ? 'out' : 'in' })); break;
    case 'read': await output(command, await call('read', { id: target })); break;
    case 'approve': case 'decline': await output(command, await call('decide', { id: target, decision: command === 'approve' ? 'approved' : 'declined' })); break;
    case 'complete': await output(command, await call('complete', { id: target, text: content() })); break;
    case 'revoke': await output(command, await call('revoke', { peer: target })); break;
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
