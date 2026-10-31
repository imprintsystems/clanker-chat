#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultHome } from './store.js';
import { localCall } from './local.js';

const help = `agent-post 0.1.0

agent-post start --name Erik       Start local daemon and a Quick Tunnel
agent-post setup                   Set name, start background service, connect an agent
agent-post setup --name Erik --client codex
agent-post start --local           Local-only test mode, no tunnel
agent-post invite                 Print a single-use code (valid 10 minutes)
agent-post pair                    Paste a friend's code on stdin
agent-post pair <code>             Pair using a code (visible in shell history)
agent-post send <peer> <text>       Send a message
agent-post send <peer> --file note.txt --kind session
agent-post send <peer> <text> --kind task_request
agent-post inbox [--unread]        Read received messages
agent-post outbox                  Inspect queued/delivered messages
agent-post watch                   Print incoming messages until interrupted
agent-post read <id>               Mark a message read
agent-post approve <id>            Locally approve an incoming task request
agent-post decline <id>            Locally decline an incoming task request
agent-post complete <id> <result>  Reply to an approved request
agent-post peers                   List paired contacts
agent-post revoke <peer>           Block a peer and cancel queued messages
agent-post retry                   Retry queued deliveries now
agent-post status                  Show connection and delivery status
agent-post mcp                     Run MCP over stdin/stdout
agent-post config                  Print MCP JSON config for this installation

Options: --home <path> (or AGENT_POST_HOME), --name <name>, --port <port>,
         --file <path>, --kind message|session|task_request, --thread <uuid>,
         --reply-to <uuid>, --unread, --after <sequence>, --local, --help
         --client codex|claude|manual, --no-service (for source checkouts)

No incoming message executes code. Task approval is a local workflow gate;
the recipient's agent app still controls permissions for work on its device.
`;

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, name: { type: 'string' }, port: { type: 'string' },
    file: { type: 'string' }, kind: { type: 'string' }, thread: { type: 'string' },
    'reply-to': { type: 'string' }, unread: { type: 'boolean' }, after: { type: 'string' },
    client: { type: 'string' }, 'no-service': { type: 'boolean' },
    local: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  const [command, target, ...words] = positionals; const home = resolve(values.home || defaultHome());
  const output = value => console.log(JSON.stringify(value, null, 2));
  if (values.help || !command || command === 'help') return console.log(help);
  if (command === 'config') {
    const { launchCommand } = await import('./setup.js');
    return output({ mcpServers: { 'agent-post': launchCommand(home, fileURLToPath(import.meta.url)) } });
  }
  if (command === 'setup') {
    const { readProfile, saveProfile, launchCommand, registerClient, startInstalledService } = await import('./setup.js');
    let name = values.name || readProfile(home).name; let client = values.client;
    if (process.stdin.isTTY && (!name || !client)) {
      const { createInterface } = await import('node:readline/promises');
      const input = createInterface({ input: process.stdin, output: process.stderr });
      try {
        name ||= (await input.question('Your name: ')).trim();
        client ||= (await input.question('Connect which app? codex / claude / manual: ')).trim().toLowerCase();
      } finally { input.close(); }
    }
    if (!name) throw new Error('Provide your name with --name, or run setup in an interactive terminal.');
    client ||= 'manual';
    if (!['codex', 'claude', 'manual'].includes(client)) throw new Error('Choose --client codex, claude, or manual.');
    if (!values['no-service'] && home !== resolve(homedir(), '.agent-post')) throw new Error('Homebrew service uses ~/.agent-post. For a custom --home, use --no-service and start the daemon separately.');
    if (!values['no-service'] && !process.env.AGENT_POST_BREW_FORMULA) throw new Error('Install through Homebrew first, or use setup --no-service from this checkout.');
    const profile = saveProfile(home, { name });
    const connection = registerClient(client, launchCommand(home, fileURLToPath(import.meta.url)), { claudeSettings: resolve(homedir(), '.claude.json') });
    const service = values['no-service'] ? { state: 'not started', next: 'Run agent-post start separately.' } : await startInstalledService(home, { formula: process.env.AGENT_POST_BREW_FORMULA });
    output({ name: profile.name, ...service, agent: connection, next: 'Restart your agent app if needed, then run agent-post invite or agent-post pair.' });
    return;
  }
  if (command === 'start') {
    const { AgentPost } = await import('./daemon.js');
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const { readProfile } = await import('./setup.js');
    const name = values.name || readProfile(home).name;
    if (name !== undefined && (!name.trim() || name.length > 80)) throw new Error('Name must have 1 to 80 characters');
    const daemon = new AgentPost({ home, name, port, local: !!values.local, cloudflared: process.env.CLOUDFLARED_BIN });
    daemon.on('warning', value => console.error(`agent-post: ${value}`));
    daemon.on('message', value => console.error(`New Agent Post message ${value.id}. Read it with agent-post inbox.`));
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await daemon.close(); };
    daemon.on('tunnelStopped', () => { process.exitCode = 1; stop(); });
    await daemon.start();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return output({ ...daemon.store.status(), online: daemon.endpointReady, mode: values.local ? 'local test' : 'Cloudflare Quick Tunnel', home });
  }
  if (command === 'mcp') { const { serveMCP } = await import('./mcp.js'); return serveMCP(home); }
  const call = (action, args = {}) => localCall(home, action, args);
  const content = () => values.file ? readFileSync(values.file, 'utf8') : words.join(' ');
  switch (command) {
    case 'invite': { const invite = await call('invite'); console.log(invite.code); console.error(`Single use. Expires ${new Date(invite.expires).toISOString()}. Share only with the intended contact.`); break; }
    case 'pair': {
      let code = target;
      if (!code) { console.error('Paste connection code, then press Enter:'); const { createInterface } = await import('node:readline/promises'); const input = createInterface({ input: process.stdin, output: process.stderr, terminal: false }); for await (const line of input) { code = line.trim(); input.close(); break; } }
      output(await call('pair', { code })); break;
    }
    case 'send': output(await call('send', { to: target, text: content(), kind: values.kind || 'message', ...(values.thread ? { thread: values.thread } : {}), ...(values['reply-to'] ? { replyTo: values['reply-to'] } : {}) })); break;
    case 'inbox': case 'outbox': output(await call('inbox', { unread: !!values.unread, after: Number(values.after || 0), direction: command === 'outbox' ? 'out' : 'in' })); break;
    case 'read': output(await call('read', { id: target })); break;
    case 'approve': case 'decline': output(await call('decide', { id: target, decision: command === 'approve' ? 'approved' : 'declined' })); break;
    case 'complete': output(await call('complete', { id: target, text: content() })); break;
    case 'revoke': output(await call('revoke', { peer: target })); break;
    case 'status': case 'peers': case 'retry': output(await call(command)); break;
    case 'watch': {
      let after = Number(values.after || 0);
      while (true) { const rows = await call('wait', { after, seconds: 20 }); for (const row of rows) { output(row); after = row.seq; } }
    }
    default: throw new Error(`Unknown command: ${command}. Run agent-post --help.`);
  }
}
main().catch(error => { console.error(`agent-post: ${error.message}${['ECONNREFUSED', 'ENOENT'].includes(error.code) ? '. Start the daemon with agent-post start.' : ''}`); process.exitCode = 1; });
