#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defaultHome } from './store.js';
import { localCall } from './local.js';
import { VERSION } from './version.js';
import { banner, line, printResult, failure } from './terminal.js';

const help = `clanker ${VERSION}

  Your agents. In the loop.

  GET CONNECTED
    clanker setup                      Guided setup with app discovery
    clanker agents                     Choose which agents can use your inbox
    clanker agents --list               Show detected and connected apps
    clanker agent hermes                Open Hermes TUI with inbox alerts
    clanker agent claude --development-channel
                                        Open Claude's local channel preview
    clanker notifications              Show live Codex alert hooks
    clanker invite                     Create a single-use invite
    clanker pair                       Paste an invite from someone else

  YOUR INBOX
    clanker                            Open the interactive home screen
    clanker inbox [--unread]            Read received messages
    clanker send David "Hello"          Send a message
    clanker outbox                     Check delivery
    clanker peers                      Your contacts
    clanker status                     Connection and unread counts
    clanker watch                      Wait for messages
    clanker read <id>                   Mark a message read
    clanker revoke <peer>               Block a contact

  WORK TOGETHER
    clanker discuss ask David "Review this?" --client codex --file evidence.txt
    clanker discuss list               Show second-opinion discussions
    clanker discuss show <id>          Read scope, transcript and summary
    clanker discuss accept <id> --client claude
                                        Accept supplied-evidence discussion
    clanker discuss stop <id>          Stop an accepted discussion
    clanker discuss decline <id>       Decline a proposal
    clanker send David --file note.txt --kind session
    clanker send David "Please test this" --kind task_request
    clanker approve <id>                Approve a local task request
    clanker decline <id>                Decline a local task request
    clanker complete <id> "Result"      Send a result for an approved task

  AUTOMATION & SETTINGS
    clanker setup --name Erik --client hermes --client omp
    clanker agents --client none        Disconnect all agent apps
    clanker config                     Manual MCP connection settings
    clanker mcp                        MCP over stdin/stdout
    clanker start                      Run the inbox in the foreground
    clanker start --local               Local-only test mode
    clanker retry                      Retry queued deliveries

  Options: --json, --home <path>, --no-service, --name <name>, --client <id>
           --port <port>, --file <path>, --kind <kind>, --thread <uuid>
           --reply-to <uuid>, --after <sequence>, --unread, --list, --help
           --max-turns <2..8>, --minutes <1..30>

  Incoming messages never execute commands. Both devices must be online to deliver.
`;

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
  const output = (action, value) => values.json ? console.log(JSON.stringify(value, null, 2)) : printResult(action, value);
  if (values.version) return console.log(`clanker ${VERSION}`);
  if (values.help || command === 'help') return console.log(help);
  if (!command) {
    if (!interactive) return console.log(help);
    const { readProfile } = await import('./setup.js');
    if (!readProfile(home).name) command = 'setup';
    else { const { showHome } = await import('./onboarding.js'); command = await showHome(home); if (!command) return; }
  }
  if (command === 'mcp') { const { serveMCP } = await import('./mcp.js'); return serveMCP(home); }
  if(command==='notify' && target==='codex') {const {runCodexHook}=await import('./host-launch.js');await runCodexHook(home,{agentHome:values['agent-home'],executable:values['agent-bin']});return;}
  if(command==='notifications') {const rows=await localCall(home,'notifications');if(values.json)console.log(JSON.stringify(rows,null,2));else{banner('Session alerts');for(const row of rows)line('Codex',`${row.session}${row.error?` · ${row.error}`:''}`);if(!rows.length)console.log('  No live Codex alert hooks. Open /hooks in Codex to trust Clanker Chat alerts.\n');}return;}
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
      const access = readAccess(home);
      const rows = discoverClients().map(({ id, label, detected, available, hint }) => ({ id, label, detected, available, hint, connected: !!access.clients[id]?.enabled }));
      if (values.json) return console.log(JSON.stringify(rows, null, 2));
      banner('Agents on this device');
      for (const row of rows) line(row.id, `${row.label} · ${row.connected ? 'connected' : row.hint}`);
      console.log('\n  Run clanker agents to choose access.\n'); return;
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
      output('discuss',result);break;
    }
    case 'invite': {
      const invite = await call('invite');
      if (values.json) console.log(JSON.stringify(invite));
      else { banner('Invite someone to Clanker Chat'); console.log(`  ${invite.code}\n\n  Single use. Valid for 10 minutes. Share privately.\n`); }
      break;
    }
    case 'pair': {
      let code = target;
      if (!code && interactive) {
        const p = await import('@clack/prompts'); code = await p.text({ message: 'Paste your invite code' });
        if (p.isCancel(code)) return;
      } else if (!code) {
        const { createInterface } = await import('node:readline/promises'); const input = createInterface({ input: process.stdin, terminal: false });
        for await (const text of input) { code = text.trim(); input.close(); break; }
      }
      output('pair', await call('pair', { code: code?.trim() })); break;
    }
    case 'send': output('send', await call('send', { to: target, text: content(), kind: values.kind || 'message', ...(values.thread ? { thread: values.thread } : {}), ...(values['reply-to'] ? { replyTo: values['reply-to'] } : {}) })); break;
    case 'inbox': case 'outbox': output(command, await call('inbox', { unread: !!values.unread, after: Number(values.after || 0), direction: command === 'outbox' ? 'out' : 'in' })); break;
    case 'read': output(command, await call('read', { id: target })); break;
    case 'approve': case 'decline': output(command, await call('decide', { id: target, decision: command === 'approve' ? 'approved' : 'declined' })); break;
    case 'complete': output(command, await call('complete', { id: target, text: content() })); break;
    case 'revoke': output(command, await call('revoke', { peer: target })); break;
    case 'status': case 'peers': case 'retry': output(command, await call(command)); break;
    case 'watch': {
      let after = Number(values.after || 0);
      if (!values.json) banner('Waiting for messages. Ctrl-C to close.');
      while (true) { const rows = await call('wait', { after, seconds: 20 }); if (rows.length) output('watch', rows); for (const row of rows) after = row.seq; }
    }
    default: throw new Error(`Unknown command: ${command}. Run clanker --help.`);
  }
}
main().catch(error => {
  if (error.constructor.name === 'Cancelled') { process.exitCode = 0; return; }
  const hint = ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? ' Run clanker setup to start your inbox.' : '';
  failure(`${error.message}${hint}`); process.exitCode = 1;
});
