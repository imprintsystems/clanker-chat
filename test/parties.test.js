import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { seal, post, newIdentity, identityCard } from '../src/protocol.js';
import { clientGrant, enableClient } from '../src/access.js';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await pause(40); } throw new Error('Timed out'); }

// Erik owns the party. David and Mia each paired with Erik, never with each other.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-party-'));
  const start = name => new ClankerChat({ home: join(root, name.toLowerCase()), name, local: true }).start();
  const people = { erik: await start('Erik'), david: await start('David'), mia: await start('Mia') };
  t.after(async () => { for (const daemon of Object.values(people)) await daemon.close(); rmSync(root, { recursive: true, force: true }); });
  for (const friend of [people.david, people.mia]) await friend.command('pair', { code: (await people.erik.command('invite')).code });
  const restart = async name => { await people[name].close(); people[name] = await new ClankerChat({ ...people[name].options }).start(); return people[name]; };
  const state = {}, party = name => people[name].parties.row(state.id);
  return { root, people, restart, party, state };
}
async function joined(f) {
  const { erik, david, mia } = f.people;
  const created = await erik.command('party', { action: 'create', name: 'Checkout' }); f.state.id = created.id;
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'David' });
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'Mia' });
  await until(() => david.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get() && mia.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get());
  await david.command('party_join', { party: 'Checkout' });
  await mia.command('party_join', { party: created.id });
  await until(() => f.party('david').members.length === 3 && f.party('mia').members.length === 3 && f.party('david').state === 'active' && f.party('mia').state === 'active');
  return created.id;
}
const inbox = (daemon, party) => daemon.store.list({ limit: 100 }).filter(row => row.payload.party === party && row.payload.kind !== 'party');

test('joining needs local consent; members who never paired can talk only inside the party', async t => {
  const f = await fixture(t), { erik, david, mia } = f.people;
  const created = await erik.command('party', { action: 'create', name: 'Checkout' }); f.state.id = created.id;
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'David' });
  await until(() => david.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get());
  const invite = (await david.command('overview')).partyInvites[0];
  assert.equal(invite.party, 'Checkout'); assert.deepEqual(invite.members, ['Erik']);
  await assert.rejects(david.command('party_join', { party: 'Checkout' }, { client: 'codex' }), /needs the user's yes/);
  await assert.rejects(david.command('send', { party: 'Checkout', text: 'too early' }), /invited/);
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'Mia' });
  await until(() => mia.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get());
  await david.command('party_join', { party: 'Checkout' }); await mia.command('party_join', { party: 'Checkout' });
  await until(() => f.party('david').members.length === 3 && f.party('mia').members.length === 3);
  assert.equal((await david.command('overview')).partyInvites.length, 0);

  const miaAtDavid = david.store.peer('Mia');
  assert.equal(miaAtDavid.partyOnly, 1);
  const sent = await david.command('send', { party: 'Checkout', text: 'I take src/web, Mia takes src/api.' });
  assert.deepEqual(sent.to.sort(), ['Erik', 'Mia']);
  await until(() => inbox(mia, created.id).length === 1 && inbox(erik, created.id).length === 1);
  assert.equal(inbox(mia, created.id)[0].payload.text, 'I take src/web, Mia takes src/api.');
  assert.equal((await mia.command('overview')).messages[0].party, 'Checkout');
  await mia.command('send', { party: 'Checkout', text: 'Deal.' });
  await until(() => inbox(david, created.id).length === 1);

  await assert.rejects(david.command('send', { to: 'Mia', text: 'direct' }), /only through a party/);
  await assert.rejects(david.command('send', { party: 'Checkout', text: 'task', kind: 'task_request' }));
  enableClient(david.options.home, 'codex', clientGrant(david.options.home, 'codex', 'Codex'));
  await assert.rejects(david.command('discussion_start', { to: 'Mia', question: 'Q?', client: 'codex' }), /only through a party/);
  const direct = { id: randomUUID(), kind: 'message', text: 'outside the party', thread: randomUUID(), createdAt: Date.now() };
  await assert.rejects(post(mia.origin, '/v1/messages', seal(david.store.identity, mia.store.identity.public, 'message', direct), true));
  const otherParty = { ...direct, id: randomUUID(), party: randomUUID() };
  await assert.rejects(post(mia.origin, '/v1/messages', seal(david.store.identity, mia.store.identity.public, 'message', otherParty), true));
});

test('only the owner changes a party; forged, stale and colliding events change nothing', async t => {
  const f = await fixture(t), { erik, david, mia } = f.people, id = await joined(f);
  const event = (partyEvent, extra = {}) => ({ id: randomUUID(), kind: 'party', text: 'synthetic', thread: id, party: id, createdAt: Date.now(), partyEvent, ...extra });
  const members = [erik, david].map(daemon => ({ identity: daemon.store.identity.public, endpoint: daemon.origin, card: identityCard(daemon.store.identity) }));
  // A member pretending to be the owner, to the owner and to a party-only contact.
  await assert.rejects(post(erik.origin, '/v1/messages', seal(david.store.identity, erik.store.identity.public, 'message', event({ type: 'members', name: 'Checkout', revision: 99, members })), true));
  await assert.rejects(post(mia.origin, '/v1/messages', seal(david.store.identity, mia.store.identity.public, 'message', event({ type: 'close' })), true));
  // The real owner replaying an old member list.
  const before = f.party('david').revision;
  await post(david.origin, '/v1/messages', seal(erik.store.identity, david.store.identity.public, 'message', event({ type: 'members', name: 'Checkout', revision: 1, members })), true);
  assert.equal(f.party('david').revision, before); assert.equal(f.party('david').members.length, 3);
  // Someone else's party ID cannot be taken over by an invitation.
  await assert.rejects(post(erik.origin, '/v1/messages', seal(david.store.identity, erik.store.identity.public, 'message', event({ type: 'invite', name: 'Mine now', invitation: randomUUID(), members: [david.store.identity.public] })), true));
  assert.equal(f.party('erik').name, 'Checkout');
  // An acceptance nobody was invited for is ignored.
  await erik.command('party', { action: 'remove', party: 'Checkout', member: 'Mia' });
  await post(erik.origin, '/v1/messages', seal(mia.store.identity, erik.store.identity.public, 'message', event({ type: 'accept', invitation: randomUUID(), card: identityCard(mia.store.identity) })), true);
  assert.deepEqual(f.party('erik').members.map(member => member.name).sort(), ['David', 'Erik']);
  await assert.rejects(david.command('party', { action: 'add', party: 'Checkout', contact: 'Erik' }), /Only Erik/);
});

test('member cards stop key swaps; late answers change nothing; withdrawn invitations end on both sides', async t => {
  const f = await fixture(t), { erik, david, mia } = f.people, id = await joined(f);
  const miaId = mia.store.identity.public.id, genuine = david.store.peer(miaId).identity.boxKey, owner = f.party('erik');
  // The owner swaps Mia's encryption key for one it controls.
  const swapped = { ...mia.store.identity.public, boxKey: newIdentity('Mallory').public.boxKey };
  const members = owner.members.map(identity => ({ identity: identity.id === miaId ? swapped : identity, endpoint: erik.origin, card: identity.id === erik.store.identity.public.id ? identityCard(erik.store.identity) : owner.cards[identity.id] }));
  const update = { id: randomUUID(), kind: 'party', text: 'synthetic', thread: id, party: id, createdAt: Date.now(), partyEvent: { type: 'members', name: 'Checkout', revision: 50, members } };
  await assert.rejects(post(david.origin, '/v1/messages', seal(erik.store.identity, david.store.identity.public, 'message', update), true));
  assert.equal(david.store.peer(miaId).identity.boxKey, genuine);
  // The same for someone David has never seen: nothing about them is stored.
  const zed = newIdentity('Zed'), zedSwapped = { ...zed.public, boxKey: newIdentity('Mallory').public.boxKey };
  const stranger = { ...update, id: randomUUID(), partyEvent: { ...update.partyEvent, revision: 51, members: [...members.filter(entry => entry.identity.id !== miaId), { identity: zedSwapped, endpoint: erik.origin, card: identityCard(zed) }] } };
  await assert.rejects(post(david.origin, '/v1/messages', seal(erik.store.identity, david.store.identity.public, 'message', stranger), true));
  assert.equal(david.store.db.prepare('SELECT 1 FROM peers WHERE id=?').get(zed.public.id), undefined);

  // An answer to a withdrawn invitation does not accept the next one.
  const launch = await erik.command('party', { action: 'create', name: 'Launch' });
  await erik.command('party', { action: 'add', party: 'Launch', contact: 'Mia' });
  const first = erik.parties.row(launch.id).invited[0].invitation;
  await erik.command('party', { action: 'remove', party: 'Launch', member: 'Mia' });
  await erik.command('party', { action: 'add', party: 'Launch', contact: 'Mia' });
  const late = { id: randomUUID(), kind: 'party', text: 'Joined Launch.', thread: launch.id, party: launch.id, createdAt: Date.now(), partyEvent: { type: 'accept', invitation: first, card: identityCard(mia.store.identity) } };
  await post(erik.origin, '/v1/messages', seal(mia.store.identity, erik.store.identity.public, 'message', late), true);
  assert.equal(erik.parties.row(launch.id).members.length, 1);
  assert.equal(erik.parties.row(launch.id).invited.length, 1);

  // A withdrawn invitation that may have arrived (its receipt was lost) is closed on the other side too.
  erik.endpointReady = false; await erik.busy;
  const lost = await erik.command('party', { action: 'create', name: 'Lost receipt' });
  await erik.command('party', { action: 'add', party: 'Lost receipt', contact: 'Mia' });
  const invite = erik.store.list({ direction: 'out', limit: 200 }).find(row => row.payload.party === lost.id).payload;
  await post(mia.origin, '/v1/messages', seal(erik.store.identity, mia.store.identity.public, 'message', invite), true);
  assert.equal(mia.parties.row(lost.id).state, 'invited');
  await erik.command('party', { action: 'remove', party: 'Lost receipt', member: 'Mia' });
  erik.endpointReady = true; erik.tick();
  await until(() => mia.parties.row(lost.id).state === 'closed');

  // An invitation that never left is cancelled and stops retrying.
  const ghost = newIdentity('Offline friend').public; erik.store.savePeer(ghost, 'http://127.0.0.1:9');
  await erik.command('party', { action: 'create', name: 'Ghost town' });
  await erik.command('party', { action: 'add', party: 'Ghost town', contact: ghost.id });
  await erik.command('party', { action: 'close', party: 'Ghost town' });
  const toGhost = erik.store.list({ direction: 'out', limit: 200 }).filter(row => row.peer === ghost.id);
  assert.deepEqual(toGhost.map(row => [row.payload.partyEvent.type, row.state]), [['invite', 'cancelled'], ['close', 'queued']]);
});

test('removal and leaving cancel undelivered messages, stop addresses and survive restarts', async t => {
  const f = await fixture(t), { erik, david } = f.people, id = await joined(f);
  await f.people.mia.close();
  await david.command('send', { party: 'Checkout', text: 'Mia is offline for this one.' });
  await until(() => inbox(erik, id).length === 1);
  const toMia = () => david.store.list({ direction: 'out', limit: 100 }).find(row => row.payload.party === id && row.payload.kind !== 'party' && row.peer === f.people.mia.store.identity.public.id);
  assert.equal(toMia().state, 'queued');
  await erik.command('party', { action: 'remove', party: 'Checkout', member: 'Mia' });
  await until(() => f.party('david').members.length === 2);
  assert.equal(toMia().state, 'cancelled');
  assert.equal(david.parties.shared(f.people.mia.store.identity.public.id), false);

  const mia = await f.restart('mia');
  await until(async () => { await erik.command('retry'); return f.party('mia').state === 'removed'; }, 15_000);
  await assert.rejects(mia.command('send', { party: id, text: 'still here?' }), /removed/);
  const late = { id: randomUUID(), kind: 'message', text: 'late', thread: id, party: id, createdAt: Date.now() };
  await assert.rejects(post(david.origin, '/v1/messages', seal(mia.store.identity, david.store.identity.public, 'message', late), true));

  await f.restart('david');
  assert.equal(f.party('david').state, 'active');
  await f.people.david.command('party', { action: 'leave', party: 'Checkout' });
  await until(async () => { await f.people.david.command('retry'); return f.party('erik').members.length === 1; }, 15_000);
  assert.equal(f.party('david').state, 'left');
});

test('a message that outruns its membership update arrives after the update', async t => {
  const f = await fixture(t), { erik, mia } = f.people;
  const created = await erik.command('party', { action: 'create', name: 'Checkout' }); f.state.id = created.id;
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'David' });
  await until(() => f.people.david.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get());
  await f.people.david.command('party_join', { party: 'Checkout' });
  await until(() => f.party('erik').members.length === 2);
  await f.people.david.close();
  await erik.command('party', { action: 'add', party: 'Checkout', contact: 'Mia' });
  await until(() => mia.store.db.prepare("SELECT 1 FROM parties WHERE state='invited'").get());
  await mia.command('party_join', { party: 'Checkout' });
  await until(() => f.party('mia').state === 'active');
  await mia.command('send', { party: 'Checkout', text: 'Hi David, I joined while you were away.' });
  const david = await f.restart('david');
  await until(async () => { await erik.command('retry'); await mia.command('retry'); return inbox(f.people.david, created.id).length === 1; }, 15_000);
  assert.equal(f.party('david').members.length, 3);
  assert.equal(inbox(david, created.id)[0].payload.text, 'Hi David, I joined while you were away.');
});

test('revoking the owner ends their party for you; revoking a member removes them', async t => {
  const f = await fixture(t), { erik, david, mia } = f.people, id = await joined(f);
  await erik.command('revoke', { peer: 'Mia' });
  assert.deepEqual(f.party('erik').members.map(member => member.name).sort(), ['David', 'Erik']);
  await until(() => f.party('david').members.length === 2);
  await mia.command('revoke', { peer: 'Erik' });
  assert.equal(f.party('mia').state, 'left');
  await assert.rejects(mia.command('send', { party: id, text: 'x' }), /left/);
});

test('a party holds at most 8 people counting invitations, and only paired contacts can be invited', async t => {
  const f = await fixture(t), { erik } = f.people;
  await erik.command('party', { action: 'create', name: 'Big' });
  const added = ['David', 'Mia'];
  for (let i = 0; i < 6; i++) { const identity = newIdentity(`Friend ${i}`).public; erik.store.savePeer(identity, 'http://127.0.0.1:9'); added.push(identity.id); }
  for (const contact of added.slice(0, 7)) await erik.command('party', { action: 'add', party: 'Big', contact });
  await assert.rejects(erik.command('party', { action: 'add', party: 'Big', contact: added[7] }), /at most 8/);
  const stranger = newIdentity('Stranger').public; erik.store.introduce(stranger, 'http://127.0.0.1:9');
  await erik.command('party', { action: 'remove', party: 'Big', member: added[6] });
  await assert.rejects(erik.command('party', { action: 'add', party: 'Big', contact: stranger.id }), /only through a party/);
});

test('an agent joins only with the user\'s yes: a dialog where the app can show it, otherwise a confirmed answer in chat', async t => {
  const f = await fixture(t), { erik, david } = f.people;
  const agent = async answer => {
    const client = new Client({ name: 'synthetic-agent', version: '1.0' }, answer ? { capabilities: { elicitation: {} } } : {});
    const asked = [];
    if (answer) client.setRequestHandler(ElicitRequestSchema, async request => { asked.push(request.params.message); return answer(); });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], env: { ...process.env, CLANKER_HOME: david.options.home }, stderr: 'pipe' }));
    t.after(() => client.close());
    const call = async args => { const result = await client.callTool({ name: 'clanker_party', arguments: args }); return { error: !!result.isError, text: result.content[0].text }; };
    return { call, asked };
  };
  const invite = async name => {
    await erik.command('party', { action: 'create', name }); await erik.command('party', { action: 'add', party: name, contact: 'David' });
    await until(() => david.store.db.prepare("SELECT 1 FROM parties WHERE state='invited' AND name=?").get(name));
  };
  // No dialog: the agent is told exactly what to ask, and joins once the user said yes.
  await invite('Chat');
  const chat = await agent();
  const first = await chat.call({ action: 'join', party: 'Chat' });
  assert.equal(first.error, true); assert.match(first.text, /Ask the user first: "Join the party "Chat" from Erik\?/);
  assert.equal((await chat.call({ action: 'join', party: 'Chat', userConfirmed: true })).error, false);
  await until(() => david.parties.find('Chat').state === 'active');
  // A dialog: the user's answer there decides, and userConfirmed cannot override a no.
  await invite('Dialog');
  const no = await agent(() => ({ action: 'decline' }));
  const refused = await no.call({ action: 'join', party: 'Dialog', userConfirmed: true });
  assert.equal(refused.error, true); assert.match(refused.text, /said no/);
  assert.match(no.asked[0], /Join the party "Dialog" from Erik/);
  assert.equal(david.parties.find('Dialog').state, 'invited');
  // Closing a dialog that was on screen is a no too.
  const closed = await agent(async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { action: 'cancel' }; });
  const dismissed = await closed.call({ action: 'join', party: 'Dialog', userConfirmed: true });
  assert.equal(dismissed.error, true); assert.match(dismissed.text, /closed the confirmation dialog/);
  assert.equal(david.parties.find('Dialog').state, 'invited');
  // An app that cancels at once never showed it (Claude Code in print mode): ask in chat instead.
  const headless = await agent(() => ({ action: 'cancel' }));
  const unasked = await headless.call({ action: 'join', party: 'Dialog' });
  assert.equal(unasked.error, true); assert.match(unasked.text, /Ask the user first: "Join the party "Dialog"/);
  assert.equal(david.parties.find('Dialog').state, 'invited');
  const yes = await agent(() => ({ action: 'accept', content: { confirm: true } }));
  assert.equal((await yes.call({ action: 'join', party: 'Dialog' })).error, false);
  await until(() => david.parties.find('Dialog').state === 'active');
  await invite('Headless');
  assert.equal((await headless.call({ action: 'join', party: 'Headless', userConfirmed: true })).error, false);
  await until(() => david.parties.find('Headless').state === 'active');
});
