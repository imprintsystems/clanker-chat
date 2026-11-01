import * as prompts from '@clack/prompts';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { banner, theme as c, clean, rows, heading, hint, printResult, printInvite } from './terminal.js';
import { readProfile, saveProfile, launchCommand, startInstalledService } from './setup.js';
import { discoverClients, applyClientSelection, clientIsConfigured } from './clients.js';
import { readAccess, clientGrant, enableClient } from './access.js';
import { localCall } from './local.js';

export class Cancelled extends Error {}
function unwrap(value, p) { if (p.isCancel(value)) { p.cancel('Cancelled.'); throw new Cancelled(); } return value; }
export async function runSetup({ home, cli, name, selected, noService = false, json = false, agentsOnly = false, interactive = !!process.stdin.isTTY && !!process.stdout.isTTY, discovery, run, p = prompts, startService = startInstalledService, env = process.env } = {}) {
  const profile = readProfile(home); const launch = launchCommand(home, cli, env);
  const state = readAccess(home);
  const clients = discoverClients(discovery);
  const manual = { id: 'manual', label: 'Other MCP app', detected: true, available: true, hint: 'Get a configuration to copy yourself' };
  const all = [...clients, manual];
  if (interactive && !json) { banner(agentsOnly ? 'Choose which agents can use your inbox.' : 'A group chat for clankers. Setup takes a minute.'); p.intro(c.inverse(agentsOnly ? ' clanker agents ' : ' clanker setup ')); }
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
    selected = unwrap(await p.multiselect({ message: 'Which of your agents can join the chat?', required: false, initialValues: [...new Set(initial)], options: ordered.map(client => ({ value: client.id, label: `${client.label}${!client.detected ? ' (not found)' : ''}`, hint: state.clients[client.id]?.enabled ? 'connected' : client.hint, disabled: !client.available })) }), p);
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
    const alerts=selected.some(id=>['codex','hermes','omp'].includes(id))?'\n\nIdle alerts add a local hook or plugin for these apps. Codex asks you to trust its hook. Accepted second-opinion discussions can start agent turns and use model usage.':'';
    p.note(`${clean(name)}\n${chosen.length ? chosen.join(', ') : 'No agent access'}${alerts}\n\nYou can change this later with clanker agents.`, 'Your setup');
    if (!unwrap(await p.confirm({ message: agentsOnly ? 'Save these agent connections?' : 'Ready to connect?', initialValue: true }), p)) { p.cancel('Nothing changed.'); throw new Cancelled(); }
  }
  saveProfile(home, { name });
  let service = { state: 'not started' };
  if (!noService) {
    const spin = interactive && !json ? p.spinner() : null; spin?.start('Starting your local inbox…');
    try { service = await startService(home, { formula: env.CLANKER_BREW_FORMULA, expectedName: name }); spin?.stop('Inbox online. Starts automatically when you log in.'); }
    catch (error) { spin?.stop('Inbox could not start. Your existing app connections were kept.'); throw error; }
  }
  const results = applyClientSelection(home, selected.filter(id => id !== 'manual'), launch, clients, { run });
  if (selected.includes('manual')) enableClient(home, 'manual', clientGrant(home, 'manual', manual.label));
  else if (state.clients.manual?.enabled) { const { disableClient } = await import('./access.js'); disableClient(home, 'manual'); }
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
  const cmd = c.strong;
  if (selected.includes('manual')) p.log.info(`For your other app, paste the output of ${cmd('clanker config')} into its MCP settings.`);
  if (selected.length) p.log.info('Restart connected apps if needed. They may ask you to approve the new tools.');
  if(selected.includes('codex'))p.log.info('In Codex, open /hooks and trust Clanker Chat alerts once.');
  if(selected.includes('claude'))p.log.info(`Claude custom Channels are preview-only. See ${cmd('clanker agent claude')} for the explicit development opt-in.`);
  if(selected.includes('hermes'))p.log.info(`Open ${cmd('clanker agent hermes')} for Hermes TUI alerts. Use /clanker to enable alerts before the first turn. The classic CLI defers notices until a turn ends.`);
  if (noService) p.log.info(`Start the inbox separately with ${cmd('clanker start')}.`);
  if (failures.length) { p.outro(`Some apps need attention. Run ${cmd('clanker agents')} to try again.`); return response; }
  if (agentsOnly || noService) { p.outro('Connections saved.'); return response; }
  const next = unwrap(await p.select({ message: 'Connect with a friend now?', options: [
    { value: 'invite', label: 'Create an invite', hint: 'A single-use code to send them' },
    { value: 'pair', label: 'Use an invite', hint: 'Paste the code they sent you' },
    { value: 'later', label: 'Later' }
  ] }), p);
  if (next === 'invite') {
    const invite = await localCall(home, 'invite');
    p.log.success('Invite ready. Single use, valid for 10 minutes. Send it privately.');
    console.log(`\n${invite.code}\n`);
    p.log.info(`Your friend installs Clanker Chat, then runs ${cmd('clanker pair')} and pastes it.`);
  } else if (next === 'pair') {
    const code = unwrap(await p.text({ message: 'Paste your invite code', validate: value => !value?.trim().startsWith('cc1:') ? 'Invite codes start with cc1:.' : undefined }), p);
    const spin = p.spinner(); spin.start('Connecting…');
    try { const result = await localCall(home, 'pair', { code: code.trim() }); spin.stop(`Connected to ${clean(result.paired.name)}.`); }
    catch (error) { spin.stop('Could not connect.'); throw error; }
  }
  p.outro(`Done. Your clankers can talk now. Run ${cmd('clanker')} to open your inbox.`);
  return response;
}
export async function showHome(home) {
  let status;
  try { status = await localCall(home, 'status'); } catch { banner(); hint('Your inbox is offline. Run `clanker setup` to start it again.'); return; }
  banner(`Hi ${clean(status.identity.name)}. ${status.unread ? c.strong(`${status.unread} unread`) : 'Nothing new'}${status.queued ? `, ${status.queued} waiting to send` : ''}.`);
  const action = unwrap(await prompts.select({ message: 'What would you like to do?', options: [
    { value: 'inbox', label: 'Read messages', hint: status.unread ? `${status.unread} unread` : undefined }, { value: 'discussions', label: 'Second opinions', hint: 'Agent discussions and results' }, { value: 'invite', label: 'Invite a friend' }, { value: 'pair', label: 'Use an invite code' },
    { value: 'agents', label: 'Choose agents' }, { value: 'peers', label: 'Contacts' }, { value: 'exit', label: 'Close' }
  ] }), prompts);
  if (action === 'exit') return;
  if (action === 'agents') return 'agents';
  const peers = () => localCall(home, 'peers');
  if (action === 'discussions') return printResult('discuss', await localCall(home, 'discussion_list'), { peers: await peers() });
  if (action === 'invite') return printInvite((await localCall(home, 'invite')).code);
  if (action === 'pair') { const code = unwrap(await prompts.text({ message: 'Paste your invite code' }), prompts); return printResult('pair', await localCall(home, 'pair', { code: code.trim() })); }
  printResult(action, await localCall(home, action), action === 'inbox' ? { peers: await peers() } : {});
}
