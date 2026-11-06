import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Parties } from '../src/parties.js';
import { overview } from '../src/overview.js';
import { newIdentity, identityCard, messageSchema } from '../src/protocol.js';

const ADDRESS = 'http://127.0.0.1:4321';
const WEEK = 7 * 24 * 60 * 60_000;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-security-parties-'));
  const store = new Store(home, 'Recipient'), clock = { value: 1_800_000_000_000 };
  const parties = new Parties(store, { local: true, origin: () => ADDRESS, now: () => clock.value });
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const owner = newIdentity('Owner');
  store.savePeer(owner.public, ADDRESS);
  const event = (partyEvent, party = randomUUID()) => messageSchema.parse({ id: randomUUID(), kind: 'party', text: 'Party update', thread: party, party, createdAt: clock.value, partyEvent });
  const invite = (person = owner, party = randomUUID(), members = [person.public]) => {
    const payload = event({ type: 'invite', name: 'Project', invitation: randomUUID(), members }, party);
    parties.receive(person.public.id, payload);
    return payload;
  };
  return { store, parties, clock, owner, event, invite };
}
const entry = (person, name = person.public.name) => ({ identity: { ...person.public, name }, endpoint: ADDRESS, card: identityCard(person) });

test('party invitations retain known direct and party-only identities, not owner-selected aliases', t => {
  const { store, parties, owner, invite } = fixture(t);
  const direct = newIdentity('Direct friend'), member = newIdentity('Known member');
  store.savePeer(direct.public, ADDRESS);
  store.introduce(member.public, ADDRESS);
  const payload = invite(owner, randomUUID(), [
    { ...owner.public, name: 'Fake owner' },
    { ...direct.public, name: 'Fake direct' },
    { ...member.public, name: 'Fake member' }
  ]);
  const row = parties.row(payload.party);
  assert.deepEqual(row.members, [owner.public, direct.public, member.public]);
  assert.throws(() => parties.pick(row, 'Fake direct'), /Nobody called/);
  assert.throws(() => parties.pick(row, 'Fake member'), /Nobody called/);
  assert.equal(parties.pick(row, 'Direct friend'), direct.public.id);
  assert.deepEqual(store.peer(direct.public.id).identity, direct.public);
  assert.deepEqual(store.peer(member.public.id).identity, member.public);
});

test('signed membership cards cannot rename known people, self, or previously introduced members', t => {
  const { store, parties, owner, event, invite } = fixture(t);
  const direct = newIdentity('Direct friend'), stranger = newIdentity('Stranger');
  store.savePeer(direct.public, ADDRESS);
  const invitation = invite();
  parties.join(invitation.party);
  const first = event({ type: 'members', name: 'Project', revision: 1, members: [
    entry(owner, 'Fake owner'), entry(store.identity, 'Fake self'), entry(direct, 'Fake direct'), entry(stranger, 'Owner-provided stranger')
  ] }, invitation.party);
  parties.receive(owner.public.id, first);
  const row = parties.row(invitation.party);
  assert.deepEqual(row.members.slice(0, 3), [owner.public, store.identity.public, direct.public]);
  assert.equal(row.members[3].name, 'Owner-provided stranger');
  const shown = parties.get(invitation.party).members.find(member => member.id === stranger.public.id);
  assert.equal(shown.nameSource, 'party-owner');
  assert.equal(parties.get(invitation.party).members.find(member => member.id === direct.public.id).nameSource, undefined);
  parties.receive(owner.public.id, event({ ...first.partyEvent, revision: 2, members: first.partyEvent.members.map(member => ({ ...member, identity: { ...member.identity, name: 'Changed after joining' } })) }, invitation.party));
  assert.deepEqual(parties.row(invitation.party).members, row.members);
  assert.equal(store.peer(stranger.public.id).identity.name, 'Owner-provided stranger');
  assert.throws(() => parties.pick(parties.row(invitation.party), 'Changed after joining'), /Nobody called/);
  store.nickname(stranger.public.id, 'Local nickname');
  assert.equal(parties.get(invitation.party).members.find(member => member.id === stranger.public.id).nameSource, undefined);
});

test('direct pairing replaces only a party-provided name with the authenticated contact name', t => {
  const { store } = fixture(t), person = newIdentity('Genuine name');
  store.introduce({ ...person.public, name: 'Owner-picked name' }, ADDRESS);
  store.savePeer(person.public, ADDRESS);
  assert.equal(store.peer(person.public.id).partyOnly, 0);
  assert.deepEqual(store.peer(person.public.id).identity, person.public);
  store.introduce({ ...person.public, name: 'Another owner-picked name' }, ADDRESS);
  assert.deepEqual(store.peer(person.public.id).identity, person.public);
});

test('invitation previews explicitly attribute unknown member names to the party owner', t => {
  const { store, owner, invite } = fixture(t), stranger = newIdentity('New member');
  invite(owner, randomUUID(), [owner.public, stranger.public]);
  const result = overview(store, { expire() {} }, { online: true });
  assert.deepEqual(result.partyInvites[0].members, ['Owner', 'New member (name supplied by party owner)']);
});

test('one inviter cannot consume the global invitation pool and existing invites remain updatable', t => {
  const { store, parties, owner, invite } = fixture(t);
  const pending = Array.from({ length: 5 }, () => invite());
  assert.throws(() => invite(), /Too many open party invitations from this contact/);
  invite(owner, pending[0].party);
  const other = newIdentity('Other inviter'); store.savePeer(other.public, ADDRESS);
  const accepted = invite(other);
  assert.equal(parties.row(accepted.party).state, 'invited');
  assert.equal(store.prepare("SELECT count(*) AS n FROM parties WHERE state='invited'").get().n, 6);
});

test('invitation expiry uses receipt time, cannot be extended by updates, and releases quota', t => {
  const { store, parties, clock, owner, event } = fixture(t), party = randomUUID();
  const payload = event({ type: 'invite', name: 'Old project', invitation: randomUUID(), members: [owner.public] }, party);
  payload.createdAt = 1;
  parties.receive(owner.public.id, payload);
  clock.value += WEEK - 1;
  assert.equal(parties.row(party).state, 'invited');
  parties.receive(owner.public.id, event({ ...payload.partyEvent, name: 'Updated project' }, party));
  clock.value++;
  assert.equal(parties.row(party).state, 'expired');
  assert.equal(store.prepare('SELECT read FROM messages WHERE id=?').get(payload.id).read, 1);
  assert.throws(() => parties.join(party), /no open invitation/);
  for (let i = 0; i < 5; i++) parties.receive(owner.public.id, event(payload.partyEvent));
  assert.equal(store.prepare("SELECT count(*) AS n FROM parties WHERE state='invited'").get().n, 5);
});

test('overview expires stale stored invitations and revocation clears all pending invites from that owner', t => {
  const { store, parties, owner, invite } = fixture(t);
  const stale = invite();
  store.prepare('UPDATE parties SET created=0 WHERE id=?').run(stale.party);
  assert.deepEqual(overview(store, { expire() {} }, { online: true }).partyInvites, []);
  assert.equal(store.prepare('SELECT state FROM parties WHERE id=?').get(stale.party).state, 'expired');
  assert.equal(store.prepare('SELECT read FROM messages WHERE id=?').get(stale.id).read, 1);
  const pending = Array.from({ length: 5 }, () => invite());
  parties.revoke(owner.public.id);
  assert.equal(store.prepare("SELECT count(*) AS n FROM parties WHERE owner=? AND state='invited'").get(owner.public.id).n, 0);
  for (const payload of pending) assert.equal(store.prepare('SELECT read FROM messages WHERE id=?').get(payload.id).read, 1);
});

test('the global invitation cap still bounds pending invitations across different contacts', t => {
  const { store, invite } = fixture(t);
  for (let i = 0; i < 4; i++) {
    const owner = newIdentity(`Owner ${i}`); store.savePeer(owner.public, ADDRESS);
    for (let j = 0; j < 5; j++) invite(owner);
  }
  const next = newIdentity('Next owner'); store.savePeer(next.public, ADDRESS);
  assert.throws(() => invite(next), /Too many open party invitations/);
});
