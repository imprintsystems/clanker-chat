import pc from 'picocolors';
import { stripVTControlCharacters } from 'node:util';
import { VERSION } from './version.js';

const c = pc.createColors(process.env.NO_COLOR === undefined && (process.stdout.isTTY || !!process.env.FORCE_COLOR));
// Terminal adaptation of the design-taste brief: one warm accent, clear hierarchy,
// generous spacing, feedback-only motion. The user's terminal owns the background.
export const theme = { accent: c.yellow, dim: c.dim, bold: c.bold, good: c.green, bad: c.red };
export const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
export function banner(subtitle = 'Your agents. In the loop.') {
  console.log(`\n  ${c.yellow('┌─┐')}  ${c.bold('CLANKER CHAT')}  ${c.dim(VERSION)}\n  ${c.yellow('└┬┘')}  ${c.dim(subtitle)}\n`);
}
export function line(label, value) { console.log(`  ${c.dim(label.padEnd(17))} ${clean(value)}`); }
export function success(message) { console.log(`\n  ${c.green('✓')} ${message}\n`); }
export function failure(message) { console.error(`\n  ${c.red('×')} ${clean(message)}\n`); }
export function printResult(command, result) {
  if (command === 'status') {
    banner('Your local inbox');
    line('You', result.identity?.name || 'Not set up'); line('Connection', result.online ? 'Online' : 'Offline');
    line('Inbox', `${result.unread} unread`); line('Outbox', `${result.queued} waiting to send`);
    console.log(`\n  ${c.dim('clanker inbox  ·  clanker peers  ·  clanker agents')}\n`); return;
  }
  if (command === 'peers') {
    banner('People you are connected to');
    if (!result.length) { console.log('  No contacts yet. Run clanker invite to connect someone.\n'); return; }
    for (const peer of result) { line(peer.revoked ? 'Blocked' : 'Connected', peer.identity.name); console.log(`                ${c.dim(peer.id)}\n`); } return;
  }
  if (['inbox', 'outbox', 'watch'].includes(command)) {
    if (command !== 'watch') banner(command === 'outbox' ? 'Messages you sent' : 'Messages from your contacts');
    if (!result.length) { console.log(`  ${command === 'outbox' ? 'Nothing sent yet.' : 'Your inbox is clear.'}\n`); return; }
    for (const row of result) {
      console.log(`  ${c.yellow(row.payload.kind.replaceAll('_', ' '))} ${c.dim(`· ${row.state}${row.decision && row.payload.kind === 'task_request' ? ` · ${row.decision}` : ''}`)}`);
      console.log(`  ${clean(row.payload.text).replace(/ {2,}/g, ' ')}\n  ${c.dim(row.id)}\n`);
    } return;
  }
  if (command === 'pair') { success(`Connected to ${clean(result.paired.name)}.`); console.log('  Ask your agent to check Clanker Chat, or run clanker inbox.\n'); return; }
  if (command === 'send' || command === 'complete') { success('Message saved and queued for delivery.'); line('Message', result.id); console.log('\n  Check delivery with clanker outbox.\n'); return; }
  const messages = { read: 'Marked as read.', revoke: 'Contact blocked. Their queued messages were cancelled.', retry: 'Retrying queued messages.', approve: 'Task approved locally.', decline: 'Task declined locally.' };
  success(messages[command] || 'Done.');
}
