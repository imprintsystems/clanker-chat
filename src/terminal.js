import { stripVTControlCharacters } from 'node:util';
import { VERSION } from './version.js';
import { contactName } from './store.js';

// The website's palette, adapted to a terminal. Body text keeps the terminal's own
// colour so it reads on dark and light themes; everything we paint carries its own
// background (bubbles, the wordmark) or is a mid grey that works on both.
const PALETTE = { paper: '#f5f3ee', ink: '#161616', surface: '#2c2b28', muted: '#8e8a82', faint: '#4d4a45', good: '#8fbf8a', bad: '#e0796b', warn: '#d6a85c' };
const env = process.env;
const enabled = env.NO_COLOR === undefined && (!!process.stdout.isTTY || !!env.FORCE_COLOR) && env.TERM !== 'dumb';
const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '') || env.FORCE_COLOR === '3' || /ghostty|iTerm|vscode|WezTerm/i.test(env.TERM_PROGRAM || '');
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
// Nearest xterm-256 colour for terminals without 24-bit support (Terminal.app).
const xterm = hex => {
  const [r, g, b] = rgb(hex); const level = v => v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40);
  const grey = Math.round(((r + g + b) / 3 - 8) / 10);
  return Math.abs(r - g) < 12 && Math.abs(g - b) < 12 ? 232 + Math.max(0, Math.min(23, grey)) : 16 + 36 * level(r) + 6 * level(g) + level(b);
};
const code = (hex, layer) => truecolor ? `${layer};2;${rgb(hex).join(';')}` : `${layer};5;${xterm(hex)}`;
const wrapCode = (open, close) => text => enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
const fg = hex => wrapCode(code(hex, 38), 39);
const bg = hex => wrapCode(code(hex, 48), 49);

export const theme = {
  enabled,
  strong: wrapCode(1, 22), italic: wrapCode(3, 23), inverse: wrapCode(7, 27),
  muted: fg(PALETTE.muted), faint: fg(PALETTE.faint), paper: fg(PALETTE.paper),
  good: fg(PALETTE.good), bad: fg(PALETTE.bad), warn: fg(PALETTE.warn)
};
const t = theme;

export const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
// Remote text keeps its line breaks; every other control character is neutralised.
const cleanLines = value => stripVTControlCharacters(String(value ?? '')).replace(/\t/g, '  ').split(/\r?\n/).map(part => part.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trimEnd());
const bodyLines = value => cleanLines(value).flatMap(line => wrap(line, Math.min(64, width() - 12)));
export const width = () => Math.max(48, Math.min(process.stdout.columns || Number(env.COLUMNS) || 80, 96));
const say = (text = '') => console.log(text);
const visible = text => stripVTControlCharacters(text).length;

export function wrap(text, max) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    // Leading spaces are an indent; keep them on every row of the paragraph.
    const indent = paragraph.match(/^ */)[0], room = Math.max(1, max - indent.length);
    let row = '';
    for (const word of paragraph.slice(indent.length).split(' ')) {
      if (row && visible(`${row} ${word}`) > room) { out.push(indent + row); row = ''; }
      row = row ? `${row} ${word}` : word;
      while (visible(row) > room) { out.push(indent + row.slice(0, room)); row = row.slice(room); }
    }
    out.push(indent + row);
  }
  return out;
}

// A chat bubble like the ones on the website: a flat rectangle whose half-block
// top and bottom rows give it half a line of padding. Their messages are paper
// on ink, yours are ink on paper's dark twin.
function bubble(lines, { mine = false, indent = 2 } = {}) {
  const pad = ' '.repeat(indent);
  if (!enabled) return lines.map(line => `${pad}${mine ? '' : '│ '}${line}${mine ? ' │' : ''}`);
  const fill = mine ? PALETTE.surface : PALETTE.paper, ink = mine ? PALETTE.paper : PALETTE.ink;
  const inner = Math.max(...lines.map(visible));
  const edge = fg(fill);
  return [
    pad + edge('▄'.repeat(inner + 4)),
    ...lines.map(line => pad + bg(fill)(fg(ink)(`  ${line}${' '.repeat(inner - visible(line))}  `))),
    pad + edge('▀'.repeat(inner + 4))
  ];
}

// The wordmark is itself a bubble, the way the site's chat is.
export function banner(subtitle = 'A group chat for clankers.') {
  const word = 'clanker chat';
  if (!enabled) { say(`\n  ${word}  ${VERSION}\n  ${subtitle}\n`); return; }
  const mark = bubble([t.strong(word)]);
  say(); say(mark[0]); say(`${mark[1]}   ${t.muted(VERSION)}`); say(`${mark[2]}   ${subtitle}`); say();
}
export function heading(title, detail) { say(`\n  ${t.strong(title)}${detail ? `  ${t.muted(detail)}` : ''}\n`); }
// Commands inside hints are written in backticks and printed in full strength.
export function hint(text, stream = console.log) {
  let inCode = false;
  for (const row of wrap(text, width() - 4)) stream('  ' + row.split('`').map((part, i) => { if (i) inCode = !inCode; return part && (inCode ? part : t.muted(part)); }).join(''));
  stream();
}
export function rows(pairs) {
  const pad = Math.max(...pairs.map(([label]) => label.length)) + 3;
  for (const [label, value] of pairs) say(`  ${t.muted(label.padEnd(pad))}${value}`);
}
function success(message) { say(`\n  ${t.good('✓')} ${message}\n`); }
export function failure(message, tip) { console.error(`\n  ${t.bad('×')} ${clean(message)}\n`); if (tip) hint(tip, console.error); }

const relative = time => {
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(time), clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? clock : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clock}`;
};
const KIND = { session: 'session text', task_request: 'task request', task_result: 'task result', discussion: 'second opinion', party: 'party update' };
const STATE = { delivered: 'delivered', queued: 'waiting to send', failed: 'not delivered', cancelled: 'cancelled' };
const fileLabel = attachment => `${clean(attachment.name)} · ${attachment.size.toLocaleString('en-US')} bytes`;
function message(row, names, direction) {
  const mine = direction === 'out', unread = !mine && !row.read;
  const who = clean(names.get(row.peer) || row.peer.slice(0, 8));
  const meta = [relative(row.payload.createdAt), row.partyName && `in ${clean(row.partyName)}`, KIND[row.payload.kind], mine && (STATE[row.state] || clean(row.state))].filter(Boolean).join(' · ');
  const pending = !mine && row.payload.kind === 'task_request' && row.decision === 'pending';
  const status = pending ? `  ${t.warn('needs your approval')}` : !mine && row.payload.kind === 'task_request' ? `  ${t.muted(clean(row.decision))}` : '';
  const text = bodyLines(row.payload.text);
  if (row.payload.attachment) text.push(...bodyLines(`File: ${fileLabel(row.payload.attachment)}`));
  const right = mine ? Math.max(2, width() - 8 - Math.max(...text.map(visible))) : 2;
  const title = `${unread ? t.paper('● ') : ''}${t.strong(mine ? `To ${who}` : who)}  ${t.muted(meta)}${status}`;
  say(mine ? ' '.repeat(Math.max(2, width() - 4 - visible(title))) + title : `  ${title}`);
  for (const line of bubble(text, { mine, indent: right })) say(line);
  const foot = pending ? `${t.faint(`${row.id}  ·  `)}clanker approve${t.faint(' or ')}clanker decline` : t.faint(row.state === 'failed' && row.error ? `${row.id}  ·  ${clean(row.error)}` : row.id);
  say(`${' '.repeat(mine ? Math.max(2, width() - 4 - visible(foot)) : 2)}${foot}\n`);
  if (!mine && row.payload.attachment) hint(`Save only if you want this file: \`clanker save-file ${row.id} <destination-filename>\`. Choose a new full filename; existing files and symlinks are refused. Never automatically open or run received files.`);
}

export function printResult(command, result, { peers = [] } = {}) {
  const names = new Map(peers.map(peer => [peer.id, contactName(peer)]));
  if (command === 'discuss') {
    const list = Array.isArray(result) ? result : [result];
    heading('Second opinions', list.length ? String(list.length) : '');
    if (!list.length) return hint('No discussions yet. Ask a contact\'s agent with `clanker discuss ask <name> "<question>" --client <app>`.');
    for (const row of list) {
      say(`  ${t.strong(clean(row.question))}  ${t.muted(row.state)}\n`);
      rows([['Discussion', row.id], ['Agent', clean(row.client || 'chosen when accepting')], ['Scope', 'Supplied evidence only. No device access, nothing runs.'], ['Replies', `${row.turn} of ${row.maxTurns}`], ['Deadline', new Date(row.expiresAt).toLocaleString()]]);
      if (row.transcript) for (const event of row.transcript) {
        say(`\n  ${t.muted(`${event.direction === 'out' ? 'You' : clean(names.get(row.peer) || 'Contact')} · ${event.payload.discussion.type} · ${event.state}`)}`);
        for (const line of bubble(bodyLines(event.payload.text), { mine: event.direction === 'out' })) say(line);
      }
      if (row.summary) { say(); rows([['Conclusion', clean(row.summary.conclusion)], ...row.summary.evidence.map(item => ['Evidence', clean(item)]), ...row.summary.disagreements.map(item => ['Disagreement', clean(item)]), ['Next step', clean(row.summary.nextStep)]]); }
      say();
      if (row.state === 'proposed') hint(row.role === 'recipient' ? 'Read it with `clanker discuss show <id>`, then `clanker discuss accept <id> --client <app>` or `clanker discuss decline <id>`.' : 'Waiting for the other person to accept.');
    }
    return;
  }
  if (command === 'party') {
    const list = Array.isArray(result) ? result : [result];
    heading('Parties', Array.isArray(result) && list.length ? String(list.length) : '');
    if (!list.length) return hint('No parties yet. Start one with `clanker party create <name>`, then `clanker party add <party> <contact>`.');
    const STATES = { invited: t.warn('invites you'), joining: 'joining, waiting for the owner', active: t.good('active'), declined: 'declined', left: 'left', removed: 'removed', closed: 'closed' };
    for (const row of list) {
      say(`  ${t.strong(clean(row.name))}  ${t.muted(row.role === 'owner' ? 'yours' : `by ${clean(row.owner)}`)} · ${STATES[row.state] || clean(row.state)}\n`);
      rows([['Party', row.id], ['Members', row.members.map(member => clean(member.name)).join(', ')], ...(row.invited ? [['Invited', row.invited.map(member => clean(member.name)).join(', ')]] : [])]);
      say();
      if (row.state === 'invited') hint(`Join with \`clanker party join ${row.id}\` or \`clanker party decline ${row.id}\`. Members see each other's names and can write to you in this party.`);
    }
    if (!Array.isArray(result) && result.state === 'active') hint(`Write to everyone with \`clanker party send "${clean(result.name)}" <text>\`.`);
    return;
  }
  if (command === 'bridge') {
    const list = Array.isArray(result) ? result : [result];
    heading('Bridges', Array.isArray(result) && list.length ? String(list.length) : '');
    if (!list.length) return hint('No bridges yet. Ask your agent to connect it with a contact\'s agent.');
    const STATES = { proposed: t.warn('waiting for a yes'), active: t.good('open'), paused: t.warn('paused'), declined: 'declined', closed: 'closed' };
    for (const row of list) {
      say(`  ${t.strong(clean(`${row.yourAgent || 'Your agent'} ↔ ${row.with}'s ${row.theirAgent || 'agent'}`))}  ${STATES[row.state] || clean(row.state)}\n`);
      const how = row.answeredBy && `${clean(row.answeredBy.label)} · ${row.answeredBy.tools}${row.answeredBy.folder ? ` · ${clean(row.answeredBy.folder)}` : ''}`;
      rows([['Bridge', row.id], ['Topic', clean(row.topic)], ...(how ? [['Answers with', how]] : []), ...(row.share ? [['May share', clean(row.share)]] : []), ...(row.paused ? [['Paused', clean(row.paused)]] : []), ['Last 24 hours', `${row.today.sent} of ${row.today.limit} questions and notes sent`]]);
      for (const event of row.transcript || []) {
        say(`\n  ${t.muted(`${event.from === 'you' ? 'You' : clean(event.from)} · ${event.type} · ${relative(Date.parse(event.at))}${event.problem ? ` · ${clean(event.problem)}` : ''}`)}`);
        for (const line of bubble(bodyLines(event.text), { mine: event.from === 'you' })) say(line);
      }
      say();
      if (row.state === 'proposed' && row.proposedBy === 'them') hint(`Accept with \`clanker bridge accept ${row.id} --agent <name> --app <app> --folder <path>\`, or \`clanker bridge decline ${row.id}\`.`);
      if (row.state === 'paused') hint(`Look at the exchange with \`clanker bridge show ${row.id}\`, then \`clanker bridge resume ${row.id}\` or \`clanker bridge close ${row.id}\`.`);
    }
    return;
  }
  if (command === 'bridge-send') {
    if (!result.answer) { success(`Sent to ${t.strong(clean(result.to))}.`); return hint(result.next ? 'No answer yet. Read it later with `clanker bridge show <bridge>`.' : 'It arrives as soon as both computers are online.'); }
    success(`${t.strong(clean(result.to))} answered:`);
    for (const line of bubble(bodyLines(result.answer), { mine: false })) say(line);
    return say();
  }
  if (command === 'status') {
    say(`\n  ${t.strong(clean(result.identity?.name || 'Not set up'))}   ${result.online ? `${t.good('●')} online` : `${t.muted('○ offline')}`}\n`);
    rows([['Inbox', result.unread ? t.strong(`${result.unread} unread`) : 'nothing new'], ['Outbox', result.queued ? `${result.queued} waiting to send` : 'all delivered'], ...(result.version ? [['Version', result.version]] : [])]);
    say(); return hint('`clanker inbox`  ·  `clanker peers`  ·  `clanker agents`');
  }
  if (command === 'peers') {
    heading('Contacts', result.length ? String(result.length) : '');
    if (!result.length) return hint('No contacts yet. Create a code with `clanker invite` and send it to a friend.');
    const pad = Math.max(...result.map(peer => clean(contactName(peer)).length)) + 3;
    for (const peer of result) {
      const icon = peer.revoked ? t.bad('×') : peer.online ? t.good('●') : t.muted('○');
      const state = peer.revoked ? 'blocked' : peer.online ? 'online' : peer.online === null ? 'unknown while your inbox is offline' : peer.seen ? `offline · last seen ${relative(peer.seen)}` : 'offline · not seen yet';
      say(`  ${icon} ${t.strong(clean(contactName(peer)).padEnd(pad))}${t.muted(state)}${peer.partyOnly && !peer.revoked ? t.muted(' · through a party only') : ''}${peer.nickname ? t.muted(` · calls themselves ${clean(peer.identity.name)}`) : ''}\n    ${t.faint(peer.id)}`);
    }
    say(); return hint('Give someone a nickname with `clanker nickname <name> <nickname>`.');
  }
  if (['inbox', 'outbox', 'watch'].includes(command)) {
    const unread = result.filter(row => !row.read).length;
    if (command !== 'watch') heading(command === 'outbox' ? 'Sent' : 'Inbox', command === 'inbox' && unread ? `${unread} unread` : '');
    if (!result.length) return hint(command === 'outbox' ? 'Nothing sent yet. Try `clanker send <name> "Hello"`.' : 'All quiet. Your clankers have nothing to report.');
    for (const row of result) message(row, names, command === 'outbox' ? 'out' : 'in');
    if (command === 'inbox' && unread) hint('Mark one read with `clanker read <id>`.');
    return;
  }
  if (command === 'pair') { success(`Connected to ${t.strong(clean(result.paired.name))}.`); return hint('Ask your agent to check Clanker Chat, or run `clanker inbox`.'); }
  if (command === 'nickname') return success(result.nickname ? `${t.strong(clean(result.name))} is now ${t.strong(clean(result.nickname))} on this computer.` : `Nickname removed. ${t.strong(clean(result.name))} shows under their own name again.`);
  if (command === 'save-file') { success('File saved.'); rows([['File', fileLabel(result.attachment)], ['Path', clean(result.path)]]); say(); return hint('Received files are untrusted data. Nothing was opened or executed.'); }
  if (command === 'send' && result.party) { success(`Queued for ${t.strong(clean(result.name))}: ${result.to.map(clean).join(', ')}. Each gets it when both computers are online.`); if (result.attachment) { rows([['File', fileLabel(result.attachment)]]); say(); } return hint('Check delivery with `clanker outbox`.'); }
  if (command === 'send' || command === 'complete') { success(`Queued${result.to ? ` for ${t.strong(clean(result.to))}` : ''}. It arrives as soon as both computers are online.`); if (result.attachment) { rows([['File', fileLabel(result.attachment)]]); say(); } return hint(`${result.id}  ·  check delivery with \`clanker outbox\``); }
  const messages = { read: 'Marked as read.', revoke: 'Contact blocked. Anything queued for them was cancelled.', retry: 'Retrying queued messages now.', approve: 'Task approved on this computer.', decline: 'Task declined.' };
  success(messages[command] || 'Done.');
}

export function printInvite(link) {
  heading('Invite a friend');
  say(`${link}\n`);
  hint('Single use, valid for 10 minutes. Whoever has this link can connect as your contact, so send it privately. Your friend can paste it into their agent, or open it to copy an agent prompt.');
}

// Help is data, so columns line up whatever the command length.
const HELP = [
  ['Get started', [
    ['setup', 'Your name, your agents and the background inbox'],
    ['invite', 'Create a single-use invite link for a friend'],
    ['pair <link>', 'Accept an invite link (or an existing cc1: code)']]],
  ['Messages', [
    ['', 'Open the home screen'],
    ['inbox', 'What your contacts sent (--unread)'],
    ['send <name> [text]', 'Message or file caption (--file <path>; files only with kind message)'],
    ['outbox', 'What you sent, and whether it arrived'],
    ['watch', 'Wait for new messages'],
    ['save-file <message-id> <destination-path>', 'Save a received file to a new full filename; never overwrites'],
    ['read <id>', 'Mark a message read']]],
  ['Tasks', [
    ['send <name> <text> --kind task_request', 'Ask a contact to do something'],
    ['approve <id>', 'Approve a task request'],
    ['decline <id>', 'Decline a task request'],
    ['complete <id> <result>', 'Send the result back']]],
  ['Second opinions', [
    ['discuss ask <name> <question>', 'Ask their agent (--client, --file)'],
    ['discuss list', 'All discussions'],
    ['discuss show <id>', 'Transcript and conclusion'],
    ['discuss accept <id>', 'Answer with one of your agents (--client)'],
    ['discuss stop <id>', 'End it (or decline <id>)']]],
  ['Parties', [
    ['party create <name>', 'A group conversation you own'],
    ['party add <party> <contact>', 'Invite a contact (up to 8 people)'],
    ['party join <party>', 'Accept an invitation (or decline <party>)'],
    ['party send <party> [text]', 'Message or file caption to everyone (--file <path>)'],
    ['party list', 'Your parties (show <party> for one)'],
    ['party remove <party> <member>', 'Remove someone from a party you own'],
    ['party leave <party>', 'Leave (close <party> ends one you own)']]],
  ['Bridges', [
    ['bridge propose <contact>', 'Link one of your agents to theirs (--topic, --agent, --app, --folder, --tools, --share)'],
    ['bridge accept <bridge>', 'Let one of your agents take their questions (same options)'],
    ['bridge ask <bridge> <text>', 'Ask their agent (--wait; note <bridge> <text> needs no answer)'],
    ['bridge list', 'Your bridges (show <bridge> for the exchange)'],
    ['bridge configure <bridge>', 'Change how your agent answers'],
    ['bridge resume <bridge>', 'Restart one that paused itself because the agents looked stuck'],
    ['bridge close <bridge>', 'End it (or decline <bridge>)']]],
  ['Agents', [
    ['agents', 'Choose which agents can use your inbox'],
    ['agents --list', 'What is installed and connected'],
    ['agent hermes', 'Open Hermes with inbox alerts'],
    ['agent claude', 'Claude\'s channel preview (--development-channel)'],
    ['notifications', 'Live Codex alert hooks'],
    ['config', 'MCP settings for any other app'],
    ['mcp', 'Serve MCP over stdio']]],
  ['Contacts and service', [
    ['peers', 'Your contacts'],
    ['nickname <name> <nickname>', 'Your own name for a contact (--clear)'],
    ['revoke <name>', 'Block a contact'],
    ['status', 'Connection and counts'],
    ['retry', 'Retry deliveries now'],
    ['start', 'Run the inbox in this terminal (--local)']]]
];
const OPTIONS = ['--json', '--home <path>', '--name <name>', '--client <id>', '--no-service', '--port <n>', '--file <path>', '--kind <kind>', '--thread <uuid>', '--reply-to <uuid>', '--after <seq>', '--unread', '--list', '--clear', '--max-turns <2..8>', '--minutes <1..30>', '--app <app>', '--tools read-only|normal', '--version'];
export function printHelp() {
  banner();
  const col = 40;
  for (const [title, entries] of HELP) {
    say(`  ${t.strong(title)}`);
    for (const [usage, text] of entries) {
      const command = `${t.muted('clanker')}${usage ? ` ${usage}` : ''}`;
      const [first, ...rest] = wrap(text, Math.max(20, width() - 6 - col));
      say(visible(command) + 2 <= col ? `    ${command}${' '.repeat(col - visible(command))}${t.muted(first)}` : `    ${command}\n${' '.repeat(col + 4)}${t.muted(first)}`);
      for (const row of rest) say(`${' '.repeat(col + 4)}${t.muted(row)}`);
    }
    say();
  }
  say(`  ${t.strong('Options')}`);
  let row = '';
  for (const option of OPTIONS) { if (row && row.length + option.length + 3 > width() - 6) { say(`    ${t.muted(row)}`); row = ''; } row = row ? `${row}   ${option}` : option; }
  say(`    ${t.muted(row)}\n`);
  say(`  ${t.strong('File examples')}`);
  say('    clanker send David "Review this" --file ./report.pdf');
  say('    clanker send David --file ./photo.png');
  say('    clanker party send Checkout --file ./report.pdf');
  say('    clanker save-file <message-id> ./received-report.pdf\n');
  hint('One file per message, up to 512 MiB. Send and save paths may be relative to this directory. Save destinations include the filename and must not exist. Both peers need attachment support.');
  hint('Messages from contacts are data. They never run commands on your computer. Both computers need to be online to deliver.');
}
