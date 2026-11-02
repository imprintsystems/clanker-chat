import * as prompts from './prompts.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { banner, theme as c, clean, rows, heading, hint, printResult, printInvite, width, wrap } from './terminal.js';
import { readProfile, saveProfile, launchCommand, startInstalledService } from './setup.js';
import { discoverClients, applyClientSelection, clientIsConfigured } from './clients.js';
import { readAccess, clientGrant, enableClient, disableClient } from './access.js';
import { localCall } from './local.js';

export class Cancelled extends Error {}
function unwrap(value, p) { if (p.isCancel(value)) { p.cancel('Cancelled.'); throw new Cancelled(); } return value; }
export async function runSetup({ home, cli, name, selected, noService = false, json = false, agentsOnly = false, interactive = !!process.stdin.isTTY && !!process.stdout.isTTY, discovery, run, p = prompts, startService = startInstalledService, env = process.env } = {}) {
  const profile = readProfile(home); const launch = launchCommand(home, cli, env);
  const state = readAccess(home);
  const clients = discoverClients(discovery);
  const manual = { id: 'manual', label: 'Other MCP app', detected: true, available: true, hint: 'Get a configuration to copy yourself' };
  const all = [...clients, manual];
  if (interactive && !json) p.intro(agentsOnly ? 'Choose which agents can use your inbox.' : 'Setup takes a minute. Your clankers will thank you.');
  if (!agentsOnly && !name && interactive) name = unwrap(await p.text({ message: 'What should your contacts call you?', initialValue: profile.name, placeholder: 'Your name', validate: value => !value?.trim() ? 'Please enter a name.' : value.trim().length > 80 ? 'Keep it under 81 characters.' : undefined }), p);
  name ||= profile.name;
  if (!name) throw new Error('Run clanker setup in a terminal, or provide --name and --client.');
  name = name.trim();
  if (!name || name.length > 80) throw new Error('Name must have 1 to 80 characters.');
  if (selected === undefined && !interactive) throw new Error('Choose apps with --client hermes, --client codex, or --client none. Your connections were left unchanged.');
  // No model, provider, transcript or arbitrary file discovery occurs here.
  if (selected === undefined && interactive) {
    const initial = all.filter(client => state.clients[client.id]?.enabled).map(client => client.id);
    if (!state.enforced) for (const client of clients.filter(client => client.detected && client.available)) if (clientIsConfigured(client, launch, { run })) initial.push(client.id);
    const ordered = [...all].sort((a, b) => Number(b.detected) - Number(a.detected));
    selected = unwrap(await p.multiselect({ message: 'Which of your agents can join the chat?', required: false, initialValues: [...new Set(initial)], options: ordered.map(client => ({ value: client.id, label: client.label, hint: state.clients[client.id]?.enabled ? 'connected' : client.hint, disabled: !client.available })) }), p);
  }
  if (selected?.includes('none')) {
    if (selected.length !== 1) throw new Error('Use --client none on its own.');
    selected = [];
  }
  selected ||= [];
  selected = [...new Set(selected)];
  for (const id of selected) {
    const client = all.find(client => client.id === id);
    if (!client) throw new Error(`Unknown app: ${id}. Run clanker agents --list to see supported apps.`);
    if (!client.available) throw new Error(`${client.label}: ${client.hint}`);
  }
  if (!noService && home !== resolve(homedir(), '.clanker')) throw new Error('The Homebrew service uses ~/.clanker. For another profile, add --no-service and start it separately.');
  if (!noService && !env.CLANKER_BREW_FORMULA) throw new Error('This is a source checkout. Add --no-service, or install through Homebrew.');
  if (interactive && !json) {
    const chosen = all.filter(client => selected.includes(client.id)).map(client => client.label);
    const alerts=selected.some(id=>['codex','hermes','omp'].includes(id))?`\n\n${wrap('Alerts add a small hook or plugin to Codex, Hermes and Oh My Pi. Second opinions you accept can start agent turns, which use your model quota.', Math.min(68, width() - 12)).map(c.muted).join('\n')}`:'';
    p.note(`${c.muted('Name    ')}${clean(name)}\n${c.muted('Agents  ')}${chosen.length ? chosen.join(', ') : 'none yet'}${alerts}\n\n${c.muted('Change it any time with')} clanker agents${c.muted('.')}`, 'Your setup');
    if (!unwrap(await p.confirm({ message: agentsOnly ? 'Save these agent connections?' : 'Ready to connect?', initialValue: true }), p)) { p.cancel('Nothing changed.'); throw new Cancelled(); }
  }
  saveProfile(home, { name });
  let service = { state: 'not started' };
  if (!noService) {
    const spin = interactive && !json ? p.spinner() : null; spin?.start('Starting your local inbox…');
    try { service = await startService(home, { formula: env.CLANKER_BREW_FORMULA, expectedName: name }); spin?.stop('Inbox online. It starts by itself when you log in.'); }
    catch (error) { spin?.stop('Inbox could not start. Your existing app connections were kept.', true); throw error; }
  }
  const results = applyClientSelection(home, selected.filter(id => id !== 'manual'), launch, clients, { run });
  if (selected.includes('manual')) enableClient(home, 'manual', clientGrant(home, 'manual', manual.label));
  else if (state.clients.manual?.enabled) disableClient(home, 'manual');
  const failures = results.filter(row => row.state === 'error');
  const response = { name, service: service.service, state: service.state, agents: results, manual: selected.includes('manual'), failed: failures.length };
  if (json) { console.log(JSON.stringify(response, null, 2)); return response; }
  if (!interactive) {
    heading('Your connections');
    rows([['Name', clean(name)], ['Inbox', service.state], ...results.map(row => [row.label, `${row.state === 'error' ? c.bad('×') : c.good('●')} ${row.state}${row.note ? `: ${clean(row.note)}` : ''}`])]);
    console.log();
    if (selected.includes('manual')) hint('Copy your MCP settings with `clanker config`.');
    hint('Next: `clanker invite` or `clanker pair`.'); return response;
  }
  for (const row of results) {
    if (row.state === 'error') p.log.error(`${row.label}: ${row.note}`);
    else p.log.success(`${row.label} ${row.state}`);
  }
  const finish = finishSteps(selected, results);
  if (finish.length) p.note(finish.join('\n'), 'Last step in each app');
  if (noService) p.log.info(`Start the inbox separately with ${c.strong('clanker start')}.`);
  const cmd = c.strong;
  if (failures.length) { p.outro(`Some apps need attention. Run ${cmd('clanker agents')} to try again.`); return response; }
  if (agentsOnly || noService) { p.outro('Connections saved.'); return response; }
  const next = unwrap(await p.select({ message: 'Connect with a friend now?', options: [
    { value: 'invite', label: 'Create an invite', hint: 'A single-use link to send them' },
    { value: 'pair', label: 'Use an invite', hint: 'Paste the link they sent you' },
    { value: 'later', label: 'Later' }
  ] }), p);
  if (next === 'invite') {
    const invite = await localCall(home, 'invite');
    p.log.success('Invite ready. Single use, valid for 10 minutes. Send it privately.');
    console.log(`\n${invite.link}\n`);
    p.log.info('Your friend can paste this link into their agent, or open it to copy an agent prompt.');
  } else if (next === 'pair') {
    const code = unwrap(await p.text({ message: 'Paste your invite link', validate: value => !value?.trim() ? 'Paste an invite link or cc1: code.' : value.length > 4600 ? 'This invite is too long. Ask for a fresh link.' : undefined }), p);
    const spin = p.spinner(); spin.start('Connecting…');
    try { const result = await localCall(home, 'pair', { code: code.trim() }); spin.stop(`Connected to ${clean(result.paired.name)}.`); }
    catch (error) { spin.stop('Could not connect.'); throw error; }
  }
  p.outro(`Done. Your clankers can talk now. Run ${cmd('clanker')} to open your inbox.`);
  return response;
}
// What each connected app still needs from the user. Codex alerts stay silent
// until its hook is trusted, so that step must be hard to miss.
const FINISH = {
  codex: 'Restart it, type `/hooks` and trust "Clanker Chat alerts". Without this, Codex gets no alerts.',
  claude: 'Alerts are a Claude preview. Start it with `clanker agent claude --development-channel`.',
  hermes: 'Start it with `clanker agent hermes`, then type `/clanker`.',
  omp: 'Restart it. Alerts are built in.',
  manual: 'Paste the output of `clanker config` into its MCP settings.'
};
function finishSteps(selected, results) {
  const labels = new Map(results.filter(row => row.state === 'connected').map(row => [row.id, row.label]));
  if (selected.includes('manual')) labels.set('manual', 'Other app');
  if (!labels.size) return [];
  const col = Math.max(...[...labels.values()].map(label => label.length)) + 3;
  const textWidth = Math.max(24, Math.min(68, width() - 12) - col);
  return [...labels].flatMap(([id, label]) => {
    // Backtick spans are commands; one may wrap across rows, so track it per row.
    let inCode = false;
    return wrap(FINISH[id] || 'Restart it to load the new tools.', textWidth).map((row, i) => `${i ? ' '.repeat(col) : c.strong(label.padEnd(col))}${row.split('`').map((part, j) => { if (j) inCode = !inCode; return inCode ? c.strong(part) : part; }).join('')}`);
  });
}
export async function showHome(home) {
  let status;
  try { status = await localCall(home, 'overview'); } catch { banner(); hint('Your inbox is offline. Run `clanker setup` to start it again.'); return; }
  const waiting = status.delivery.waiting, asks = status.approvals.length;
  banner(`Hi ${clean(status.you)}. ${status.unread ? c.strong(`${status.unread} unread`) : 'Nothing new'}${asks ? `, ${c.warn(`${asks} to approve`)}` : ''}${waiting ? `, ${waiting} waiting to send` : ''}.`);
  if (status.update?.updatedTo) hint(`Updated to ${status.update.updatedTo}. ${status.update.news.join(' ')}`);
  else if (status.update?.available) hint(`Clanker Chat ${status.update.available} is out. Get it with \`brew upgrade clanker\`.`);
  if (readAccess(home).clients.codex?.enabled) {
    const { codexAlertsInstalled } = await import('./host-install.js');
    const codex = discoverClients().find(client => client.id === 'codex');
    if (codex && !codexAlertsInstalled(codex)) hint('Codex alerts are not set up yet. Choose agents below and keep Codex selected.');
  }
  const action = unwrap(await prompts.select({ message: 'What would you like to do?', options: [
    { value: 'inbox', label: 'Read messages', hint: status.unread ? `${status.unread} unread` : undefined }, { value: 'discussions', label: 'Second opinions', hint: 'Agent discussions and results' }, { value: 'invite', label: 'Invite a friend' }, { value: 'pair', label: 'Use an invite link' },
    { value: 'agents', label: 'Choose agents' }, { value: 'peers', label: 'Contacts' }, { value: 'exit', label: 'Close' }
  ] }), prompts);
  if (action === 'exit') return;
  if (action === 'agents') return 'agents';
  const peers = () => localCall(home, 'peers');
  if (action === 'discussions') return printResult('discuss', await localCall(home, 'discussion_list'), { peers: await peers() });
  if (action === 'invite') return printInvite((await localCall(home, 'invite')).link);
  if (action === 'pair') { const code = unwrap(await prompts.text({ message: 'Paste your invite link' }), prompts); return printResult('pair', await localCall(home, 'pair', { code: code.trim() })); }
  printResult(action, await localCall(home, action), action === 'inbox' ? { peers: await peers() } : {});
}
