import pc from 'picocolors';
import { stripVTControlCharacters } from 'node:util';
import { VERSION } from './version.js';

const c = pc.createColors(process.env.NO_COLOR === undefined && (process.stdout.isTTY || !!process.env.FORCE_COLOR));
// Same look as the website: ink on whatever background the terminal has, one weight
// for emphasis, grey for everything secondary. Green and red only mark states.
export const theme = { strong: c.bold, dim: c.dim, italic: c.italic, inverse: c.inverse, good: c.green, bad: c.red };
export const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
// Remote text keeps its line breaks; every other control character is neutralised.
const cleanLines = value => stripVTControlCharacters(String(value ?? '')).replace(/\t/g, '  ').split(/\r?\n/).map(part => part.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trimEnd());
const width = () => Math.max(40, Math.min(process.stdout.columns || 80, 88));
const say = (text = '') => console.log(text);

// The nut bubble from site/logo.svg, rasterised to quadrant blocks.
const LOGO = ['  ▄████▄  ', ' ▟█▛▀▀▜█▙ ', ' ▜█▙▖▗▟█▛ ', '  ▜████▛  ', '  ▝▘      '];
export function banner(subtitle = 'A group chat for clankers.', detail = 'Your AI agent messages your friend\'s, so you don\'t have to.') {
  const right = ['', `${c.bold('clanker chat')}  ${c.dim(VERSION)}`, c.dim(`/ˈklæŋ·kər tʃæt/  ${c.italic('noun')}`), subtitle, c.dim(detail)];
  say(); for (const [i, row] of LOGO.entries()) say(`  ${row}  ${right[i]}`.trimEnd()); say();
}
export function heading(title, detail) { say(`\n  ${c.bold(title)}${detail ? c.dim(`  ${detail}`) : ''}\n`); }
// Wrap plain text to the terminal, continuing lines under the same indent.
export function wrap(text, indent = 2, max = width() - indent - 2) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let row = '';
    for (const word of paragraph.split(' ')) {
      if (row && (row + ' ' + word).length > max) { out.push(row); row = ''; }
      row = row ? `${row} ${word}` : word;
      while (row.length > max) { out.push(row.slice(0, max)); row = row.slice(max); }
    }
    out.push(row);
  }
  return out.map(row => ' '.repeat(indent) + row).join('\n');
}
// Commands inside hints are written in backticks and stand out the way code does on the site.
export function hint(text) {
  let code = false;
  for (const row of wrap(text).split('\n')) say(row.split('`').map((part, i) => { if (i) code = !code; return part && (code ? c.bold(part) : c.dim(part)); }).join(''));
  say();
}
export function rows(pairs) {
  const pad = Math.max(...pairs.map(([label]) => label.length)) + 3;
  for (const [label, value] of pairs) say(`  ${c.dim(label.padEnd(pad))}${value}`);
}
export function line(label, value) { rows([[label, clean(value)]]); }
export function success(message) { say(`\n  ${c.green('✓')} ${message}\n`); }
export function failure(message) { console.error(`\n  ${c.red('×')} ${clean(message)}\n`); }

const relative = time => {
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(time), today = new Date();
  const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return clock;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clock}`;
};
const KIND = { message: 'message', session: 'session text', task_request: 'task request', task_result: 'task result', discussion: 'second opinion' };
// One message, drawn like a chat bubble without the box: who, what, then the text on a rail.
function message(row, names, direction) {
  const who = clean(names.get(row.peer) || row.peer.slice(0, 8));
  const meta = [KIND[row.payload.kind] || clean(row.payload.kind), relative(row.payload.createdAt)];
  if (direction === 'in' && !row.read) meta.push('unread');
  if (direction === 'out') meta.push(row.state === 'delivered' ? 'delivered' : row.state === 'queued' ? 'waiting to send' : clean(row.state));
  if (direction === 'in' && row.payload.kind === 'task_request') meta.push(row.decision === 'pending' ? 'needs your approval' : clean(row.decision));
  const unread = direction === 'in' && !row.read;
  say(`  ${unread ? c.bold('●') : c.dim('○')} ${c.bold(direction === 'out' ? `To ${who}` : who)}  ${c.dim(meta.filter(Boolean).join(' · '))}`);
  const rail = c.dim('│');
  for (const part of cleanLines(row.payload.text)) for (const wrapped of wrap(part, 0, width() - 8).split('\n')) say(`  ${rail} ${wrapped}`);
  let foot = row.id;
  if (direction === 'in' && row.payload.kind === 'task_request' && row.decision === 'pending') foot += '  ·  clanker approve <id>  or  clanker decline <id>';
  if (row.state === 'failed' && row.error) foot += `  ·  ${clean(row.error)}`;
  say(`  ${c.dim(`└ ${foot}`)}\n`);
}

export function printResult(command, result, { peers = [], to } = {}) {
  const names = new Map(peers.map(peer => [peer.id, peer.identity.name]));
  if (command === 'discuss') {
    const list = Array.isArray(result) ? result : [result];
    heading('Second opinions', list.length ? `${list.length}` : '');
    if (!list.length) return hint('No discussions yet. Ask a contact\'s agent with `clanker discuss ask <name> "<question>" --client <app>`.');
    for (const row of list) {
      say(`  ${c.bold(clean(row.question))}  ${c.dim(row.state)}`);
      rows([['Discussion', row.id], ['Agent', clean(row.client || 'chosen when accepting')], ['Scope', 'Supplied evidence only. No device access, nothing runs.'], ['Replies', `${row.turn} of ${row.maxTurns}`], ['Deadline', new Date(row.expiresAt).toLocaleString()]]);
      if (row.transcript) for (const event of row.transcript) {
        say(`\n  ${c.dim(`${event.direction === 'out' ? 'You' : clean(names.get(row.peer) || 'Contact')} · ${event.payload.discussion.type} · ${event.state}`)}`);
        for (const part of cleanLines(event.payload.text)) say(`  ${c.dim('│')} ${part}`);
      }
      if (row.summary) {
        say(); rows([['Conclusion', clean(row.summary.conclusion)], ...row.summary.evidence.map(item => ['Evidence', clean(item)]), ...row.summary.disagreements.map(item => ['Disagreement', clean(item)]), ['Next step', clean(row.summary.nextStep)]]);
      }
      say();
      if (row.state === 'proposed') hint(row.role === 'recipient' ? 'Read it with `clanker discuss show`, then `clanker discuss accept <id> --client <app>` or `clanker discuss decline <id>`.' : 'Waiting for the other person to accept.');
    }
    return;
  }
  if (command === 'status') {
    heading(clean(result.identity?.name || 'Not set up'));
    rows([
      ['Connection', result.online ? `${c.green('●')} online` : `${c.dim('○')} offline`],
      ['Inbox', result.unread ? c.bold(`${result.unread} unread`) : 'nothing new'],
      ['Outbox', result.queued ? `${result.queued} waiting to send` : 'all delivered'],
      ...(result.version ? [['Version', result.version]] : [])
    ]);
    say(); return hint('`clanker inbox`   `clanker peers`   `clanker agents`');
  }
  if (command === 'peers') {
    heading('Contacts', result.length ? String(result.length) : '');
    if (!result.length) return hint('No contacts yet. Create a code with `clanker invite` and send it to a friend.');
    const pad = Math.max(...result.map(peer => clean(peer.identity.name).length)) + 3;
    for (const peer of result) say(`  ${peer.revoked ? c.red('×') : c.green('●')} ${c.bold(clean(peer.identity.name).padEnd(pad))}${c.dim(peer.revoked ? 'blocked' : 'connected')}\n    ${c.dim(peer.id)}`);
    say(); return;
  }
  if (['inbox', 'outbox', 'watch'].includes(command)) {
    const direction = command === 'outbox' ? 'out' : 'in';
    if (command !== 'watch') heading(command === 'outbox' ? 'Sent' : 'Inbox', result.length ? `${result.length} message${result.length === 1 ? '' : 's'}` : '');
    if (!result.length) return hint(command === 'outbox' ? 'Nothing sent yet. Try `clanker send <name> "Hello"`.' : 'All quiet. Your clankers have nothing to report.');
    for (const row of result) message(row, names, direction);
    if (command === 'inbox' && result.some(row => !row.read)) hint('Mark one read with `clanker read <id>`.');
    return;
  }
  if (command === 'pair') { success(`Connected to ${c.bold(clean(result.paired.name))}.`); return hint('Ask your agent to check Clanker Chat, or run `clanker inbox`.'); }
  if (command === 'send' || command === 'complete') { success(`Queued${to ? ` for ${c.bold(clean(to))}` : ''}. It goes out as soon as both computers are online.`); say(`  ${c.dim(result.id)}\n`); return hint('Check delivery with `clanker outbox`.'); }
  const messages = { read: 'Marked as read.', revoke: 'Contact blocked. Anything queued for them was cancelled.', retry: 'Retrying queued messages now.', approve: 'Task approved on this computer.', decline: 'Task declined.' };
  success(messages[command] || 'Done.');
}

export function printInvite(code) {
  heading('Invite a friend');
  say(`  ${code}\n`);
  hint('Single use, valid for 10 minutes. Send it privately: whoever has it can connect as your contact. Your friend installs Clanker Chat, then runs `clanker pair` and pastes it.');
}

// Help is data, so columns line up whatever the command length.
const HELP = [
  ['Get started', [
    ['setup', 'Your name, apps and the background inbox'],
    ['invite', 'Create a single-use code for a friend'],
    ['pair [code]', 'Paste a code someone sent you']]],
  ['Messages', [
    ['clanker', 'Open the home screen'],
    ['inbox [--unread]', 'Read what your contacts sent'],
    ['send <name> "<text>"', 'Send a message'],
    ['send <name> --file note.txt --kind session', 'Share selected session text'],
    ['outbox', 'Check delivery'],
    ['watch', 'Wait for new messages'],
    ['read <id>', 'Mark a message read']]],
  ['Tasks and second opinions', [
    ['send <name> "<text>" --kind task_request', 'Ask for a task; they approve it first'],
    ['approve <id>  /  decline <id>', 'Decide on a task request you received'],
    ['complete <id> "<result>"', 'Send the result of an approved task'],
    ['discuss ask <name> "<question>" --client <app> [--file evidence.txt]', 'Ask their agent for a second opinion'],
    ['discuss list  /  show <id>', 'Discussions, transcripts and conclusions'],
    ['discuss accept <id> --client <app>', 'Let one of your agents answer'],
    ['discuss stop <id>  /  decline <id>', 'End or refuse a discussion']]],
  ['Agents', [
    ['agents', 'Choose which apps can use your inbox'],
    ['agents --list', 'Show detected and connected apps'],
    ['agents --client none', 'Disconnect every app'],
    ['agent hermes', 'Open Hermes with inbox alerts'],
    ['agent claude --development-channel', 'Open Claude\'s local channel preview'],
    ['notifications', 'Show live Codex alert hooks'],
    ['config', 'MCP settings to paste into another app'],
    ['mcp', 'Serve MCP over stdin and stdout']]],
  ['Contacts and the inbox service', [
    ['peers', 'Your contacts'],
    ['revoke <name>', 'Block a contact, cancel what\'s queued'],
    ['status', 'Connection, unread and queued counts'],
    ['retry', 'Retry queued deliveries now'],
    ['start [--local]', 'Run the inbox here; --local skips the tunnel'],
    ['setup --name Erik --client codex --client omp', 'Set up without prompts']]]
];
const OPTIONS = ['--json', '--home <path>', '--name <name>', '--client <id>', '--no-service', '--port <n>', '--file <path>', '--kind <kind>', '--thread <uuid>', '--reply-to <uuid>', '--after <seq>', '--unread', '--list', '--max-turns <2..8>', '--minutes <1..30>', '--version', '--help'];
export function printHelp() {
  banner();
  const col = 30, room = width() - 4 - col;
  for (const [title, entries] of HELP) {
    say(`  ${c.bold(title)}`);
    for (const [usage, text] of entries) {
      const full = usage === 'clanker' ? 'clanker' : `clanker ${usage}`;
      const [first, ...rest] = wrap(text, 0, room).split('\n');
      say(full.length + 2 <= col ? `    ${full.padEnd(col)}${c.dim(first)}` : `    ${full}\n${' '.repeat(col + 4)}${c.dim(first)}`);
      for (const row of rest) say(`${' '.repeat(col + 4)}${c.dim(row)}`);
    }
    say();
  }
  say(`  ${c.bold('Options')}`);
  let row = '';
  for (const option of OPTIONS) { if (row && row.length + option.length + 2 > width() - 6) { say(`    ${c.dim(row)}`); row = ''; } row = row ? `${row}  ${option}` : option; }
  say(`    ${c.dim(row)}\n`);
  hint('Messages from contacts are data. They never run commands on your computer. Both computers need to be online to deliver.');
}
