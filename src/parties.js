import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { messageSchema, validateIdentity, endpoint, partyName, text, MAX_PARTY, identityCard, verifyCard } from './protocol.js';
import { contactName } from './store.js';

const idSchema = z.string().uuid();
const live = ['joining', 'active'];
const MAX_OPEN = 10, MAX_INVITES = 20;
const sendSchema = z.object({ party: z.string().min(1).max(100), text, kind: z.enum(['message', 'session']).default('message') }).strict();
const STATUS = {
  invited: name => `You are invited to ${name} but have not joined yet.`,
  joining: name => `Waiting for the owner to confirm you joined ${name}.`,
  declined: name => `You declined the invitation to ${name}.`,
  left: name => `You left ${name}.`,
  removed: name => `You were removed from ${name}.`,
  closed: name => `${name} was closed.`
};
const status = row => STATUS[row.state]?.(row.name) || `${row.name} is ${row.state}.`;

// A party is a group conversation. Its owner decides who is in it and tells every
// member; each member then writes to every other member directly. Nothing is
// forwarded, so a message reaches someone only while both computers are online.
// People met only through a party become party-only contacts: they can write to
// you inside parties you share, never directly.
export class Parties {
  constructor(store, { local = false, origin = () => null, now = Date.now } = {}) {
    this.store = store; this.local = local; this.origin = origin; this.now = now;
  }
  get me() { return this.store.identity.public.id; }
  transaction(fn) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  parse(row) { return row && { ...row, members: JSON.parse(row.members), invited: JSON.parse(row.invited), cards: JSON.parse(row.cards) }; }
  row(id) {
    const row = this.parse(this.store.db.prepare('SELECT * FROM parties WHERE id=?').get(id));
    if (!row) throw new Error('Party not found');
    return row;
  }
  // By ID, or by name among parties you are invited to or in. "The Checkout
  // party" means Checkout.
  find(ref) {
    const key = String(ref ?? '').trim();
    if (idSchema.safeParse(key).success) return this.row(key);
    const open = this.store.db.prepare("SELECT * FROM parties WHERE state IN ('invited','joining','active')").all().map(row => this.parse(row));
    for (const name of new Set([key, key.replace(/^the\s+/i, '').replace(/\s+party$/i, '').trim()])) {
      const rows = open.filter(row => row.name.toLowerCase() === name.toLowerCase());
      if (rows.length > 1) throw new Error(`Several parties are called ${name}. Use the party ID from clanker party list.`);
      if (rows[0]) return rows[0];
    }
    const ended = this.store.db.prepare('SELECT name,state FROM parties ORDER BY created DESC').all().find(row => row.name.toLowerCase() === key.replace(/^the\s+/i, '').replace(/\s+party$/i, '').trim().toLowerCase());
    throw new Error(ended ? status(ended) : 'Unknown party. See clanker party list.');
  }
  save(id, fields) {
    const keys = Object.keys(fields);
    this.store.db.prepare(`UPDATE parties SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...keys.map(key => fields[key] !== null && typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]), id);
  }
  contact(id) {
    const row = this.store.db.prepare('SELECT * FROM peers WHERE id=?').get(id);
    return row && { ...row, identity: JSON.parse(row.identity) };
  }
  label(id, row) {
    if (id === this.me) return 'You';
    const peer = this.contact(id);
    return peer ? contactName(peer) : row?.members.find(member => member.id === id)?.name || `${id.slice(0, 12)}…`;
  }
  reachable(id) { const peer = this.contact(id); return !!peer && !peer.revoked; }
  view(row) {
    return {
      id: row.id, name: row.name, role: row.owner === this.me ? 'owner' : 'member', owner: this.label(row.owner, row), state: row.state, revision: row.revision,
      members: row.members.map(member => ({ id: member.id, name: this.label(member.id, row) })),
      ...(row.invited.length ? { invited: row.invited.map(invite => ({ id: invite.id, name: this.label(invite.id, row) })) } : {})
    };
  }
  list() { return this.store.db.prepare('SELECT * FROM parties ORDER BY created DESC LIMIT 50').all().map(row => this.view(this.parse(row))); }
  get(ref) { return this.view(this.find(ref)); }
  // True when you and this contact are both in a party that is running.
  shared(id) { return this.store.db.prepare("SELECT members FROM parties WHERE state='active'").all().some(row => JSON.parse(row.members).some(member => member.id === id)); }
  capacity() {
    if (this.store.db.prepare("SELECT count(*) AS n FROM parties WHERE state IN ('joining','active')").get().n >= MAX_OPEN) throw new Error(`You are in ${MAX_OPEN} parties already. Leave or close one first.`);
  }
  outgoing(peer, party, event, note) {
    this.store.insert(peer, 'out', messageSchema.parse({ id: randomUUID(), kind: 'party', text: note, thread: party, party, createdAt: this.now(), partyEvent: event }));
  }
  // Undelivered conversation for a party, optionally only to one person. Membership
  // events stay queued so leaving and removal still reach the others.
  cancel(party, peer) {
    this.store.db.prepare(`UPDATE messages SET state='cancelled',error='No longer in this party' WHERE direction='out' AND state='queued' AND json_extract(payload,'$.party')=? AND json_extract(payload,'$.kind')!='party' ${peer ? 'AND peer=?' : ''}`).run(...(peer ? [party, peer] : [party]));
  }
  // Ends an invitation. A still-queued copy is cancelled so it stops retrying,
  // but it may already have arrived (a lost receipt, a request in flight), so a
  // close always follows; a recipient that never stored it just acknowledges.
  withdraw(row, id, note) {
    this.store.db.prepare("UPDATE messages SET state='cancelled',error='Invitation withdrawn' WHERE direction='out' AND state='queued' AND peer=? AND json_extract(payload,'$.party')=? AND json_extract(payload,'$.partyEvent.type')='invite'").run(id, row.id);
    if (this.reachable(id)) this.outgoing(id, row.id, { type: 'close' }, note);
  }
  settleInvite(party) {
    this.store.db.prepare("UPDATE messages SET read=1 WHERE direction='in' AND json_extract(payload,'$.party')=? AND json_extract(payload,'$.partyEvent.type')='invite'").run(party);
  }
  owned(ref) {
    const row = this.find(ref);
    if (row.owner !== this.me) throw new Error(`Only ${this.label(row.owner, row)} can change who is in ${row.name}.`);
    if (row.state !== 'active') throw new Error(status(row));
    return row;
  }
  // A member or invitee of this party, by ID, nickname or name.
  pick(row, ref) {
    const key = String(ref ?? '').trim(), lower = key.toLowerCase();
    const ids = [...row.members.map(member => member.id), ...row.invited.map(invite => invite.id)];
    const matches = ids.filter(id => id === key || this.label(id, row).toLowerCase() === lower || row.members.find(member => member.id === id)?.name.toLowerCase() === lower);
    if (matches.length > 1) throw new Error(`Several people in ${row.name} are called ${key}. Use the full ID.`);
    if (!matches.length) throw new Error(`Nobody called ${key} is in ${row.name}.`);
    return matches[0];
  }
  // Tell every member, and anyone just removed, who is in the party now. Each
  // entry carries the member's own card, which the recipients check.
  publish(row, extra = []) {
    const origin = this.origin() || this.store.get('endpoint');
    if (!origin) throw new Error('Your inbox has not been online yet.');
    const members = row.members.map(identity => identity.id === this.me
      ? { identity, endpoint: origin, card: identityCard(this.store.identity) }
      : { identity, endpoint: this.contact(identity.id).endpoint, card: row.cards[identity.id] });
    const event = { type: 'members', name: row.name, revision: row.revision, members };
    const note = `Members of ${row.name}: ${row.members.map(member => member.name).join(', ')}.`;
    for (const id of [...row.members.map(member => member.id).filter(id => id !== this.me), ...extra]) if (this.reachable(id)) this.outgoing(id, row.id, event, note);
  }
  without(row, id) {
    const cards = { ...row.cards }; delete cards[id];
    return { ...row, members: row.members.filter(member => member.id !== id), cards, revision: row.revision + 1 };
  }

  create(args) {
    const name = partyName.parse(args.name);
    this.capacity();
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO parties (id,name,owner,state,revision,members,created) VALUES (?,?,?,'active',1,?,?)").run(id, name, this.me, JSON.stringify([this.store.identity.public]), this.now());
    return this.view(this.row(id));
  }
  add(args) {
    return this.transaction(() => {
      const row = this.owned(args.party), peer = this.store.direct(z.string().min(1).max(100).parse(args.contact));
      if (row.members.some(member => member.id === peer.id) || row.invited.some(invite => invite.id === peer.id)) throw new Error(`${contactName(peer)} is already in ${row.name} or invited.`);
      if (row.members.length + row.invited.length >= MAX_PARTY) throw new Error(`A party has at most ${MAX_PARTY} people, counting open invitations.`);
      // Every invitation has its own token, so a late answer to a withdrawn one
      // cannot accept a newer one.
      const invitation = randomUUID();
      this.outgoing(peer.id, row.id, { type: 'invite', name: row.name, invitation, members: row.members }, `${this.store.identity.public.name} invites you to the party ${row.name}. Members: ${row.members.map(member => member.name).join(', ')}.`);
      this.save(row.id, { invited: [...row.invited, { id: peer.id, invitation }] });
      return this.view(this.row(row.id));
    });
  }
  // An agent joins for the user only with the user's yes, from a dialog or the chat.
  join(ref, actor, consent) {
    if (actor && !['dialog', 'chat'].includes(consent)) throw new Error('Joining a party needs the user\'s yes. Ask them first, then use clanker_party join.');
    return this.transaction(() => {
      const row = this.find(ref);
      if (row.state !== 'invited') throw new Error(`There is no open invitation to ${row.name}.`);
      this.capacity();
      const owner = this.store.direct(row.owner);
      this.outgoing(owner.id, row.id, { type: 'accept', invitation: row.invitation, card: identityCard(this.store.identity) }, `Joined ${row.name}.`);
      this.settleInvite(row.id);
      this.save(row.id, { state: 'joining' });
      return this.view(this.row(row.id));
    });
  }
  decline(ref) {
    return this.transaction(() => {
      const row = this.find(ref);
      if (row.state !== 'invited') throw new Error(`There is no open invitation to ${row.name}.`);
      if (this.reachable(row.owner)) this.outgoing(row.owner, row.id, { type: 'decline', invitation: row.invitation }, `Declined ${row.name}.`);
      this.settleInvite(row.id);
      this.save(row.id, { state: 'declined' });
      return this.view(this.row(row.id));
    });
  }
  leave(ref) {
    const row = this.find(ref);
    if (row.owner === this.me) return this.close(row.id);
    if (row.state === 'invited') return this.decline(row.id);
    return this.transaction(() => {
      if (!live.includes(row.state)) throw new Error(status(row));
      this.cancel(row.id);
      if (this.reachable(row.owner)) this.outgoing(row.owner, row.id, { type: 'leave' }, `Left ${row.name}.`);
      this.save(row.id, { state: 'left' });
      return this.view(this.row(row.id));
    });
  }
  close(ref) {
    return this.transaction(() => {
      const row = this.owned(ref);
      this.cancel(row.id);
      for (const id of row.members.map(member => member.id).filter(id => id !== this.me)) if (this.reachable(id)) this.outgoing(id, row.id, { type: 'close' }, `${row.name} was closed.`);
      for (const invite of row.invited) this.withdraw(row, invite.id, `${row.name} was closed.`);
      this.save(row.id, { state: 'closed', invited: [] });
      return this.view(this.row(row.id));
    });
  }
  remove(args) {
    return this.transaction(() => {
      const row = this.owned(args.party), id = this.pick(row, args.member);
      if (id === this.me) throw new Error('Close the party instead of removing yourself.');
      if (row.invited.some(invite => invite.id === id)) {
        this.withdraw(row, id, `The invitation to ${row.name} was withdrawn.`);
        this.save(row.id, { invited: row.invited.filter(invite => invite.id !== id) });
        return this.view(this.row(row.id));
      }
      const next = this.without(row, id);
      this.cancel(row.id, id);
      this.publish(next, [id]);
      this.save(row.id, { members: next.members, cards: next.cards, revision: next.revision });
      return this.view(this.row(row.id));
    });
  }
  send(args) {
    const input = sendSchema.parse(args);
    return this.transaction(() => {
      const row = this.find(input.party);
      if (row.state !== 'active') throw new Error(status(row));
      const to = row.members.filter(member => member.id !== this.me && this.reachable(member.id));
      if (!to.length) throw new Error(`Nobody else is in ${row.name} yet.`);
      const ids = to.map(member => {
        const payload = messageSchema.parse({ id: randomUUID(), kind: input.kind, text: input.text, thread: row.id, party: row.id, createdAt: this.now() });
        this.store.insert(member.id, 'out', payload);
        return payload.id;
      });
      return { party: row.id, name: row.name, to: to.map(member => this.label(member.id, row)), ids, state: 'queued' };
    });
  }
  // Blocking a contact and its effect on parties commit together: their parties
  // end for you, and you remove them from yours.
  revoke(ref) {
    return this.transaction(() => {
      const result = this.store.revoke(ref), id = result.revoked;
      for (const row of this.store.db.prepare("SELECT * FROM parties WHERE owner=? AND state IN ('invited','joining','active')").all(id).map(row => this.parse(row))) {
        this.cancel(row.id); this.settleInvite(row.id); this.save(row.id, { state: 'left' });
      }
      for (const row of this.store.db.prepare("SELECT * FROM parties WHERE owner=? AND state='active'").all(this.me).map(row => this.parse(row))) {
        if (row.invited.some(invite => invite.id === id)) this.save(row.id, { invited: row.invited.filter(invite => invite.id !== id) });
        if (!row.members.some(member => member.id === id)) continue;
        const next = this.without(row, id);
        this.publish(next);
        this.save(row.id, { members: next.members, cards: next.cards, revision: next.revision });
      }
      return result;
    });
  }

  // Everything a contact sends about a party. Throwing rejects the delivery and
  // the sender retries; that covers a message that outruns a membership update.
  receive(peerId, payload) {
    return this.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(payload.id)) return this.store.insert(peerId, 'in', payload);
      const peer = this.contact(peerId), row = this.parse(this.store.db.prepare('SELECT * FROM parties WHERE id=?').get(payload.party));
      const member = id => row.members.some(other => other.id === id);
      if (payload.kind !== 'party') {
        if (!row || row.state !== 'active' || payload.thread !== row.id || !member(peer.id) || !member(this.me)) throw new Error('Not a member of this party');
        return this.store.insert(peer.id, 'in', payload);
      }
      if (peer.partyOnly) throw new Error('Only a paired contact can change a party');
      const event = payload.partyEvent, ack = () => this.store.insert(peer.id, 'in', payload);
      if (event.type === 'invite') {
        const members = event.members.map(validateIdentity);
        if (!members.some(other => other.id === peer.id) || members.some(other => other.id === this.me) || new Set(members.map(other => other.id)).size !== members.length) throw new Error('Invalid party invitation');
        if (row && row.owner !== peer.id) throw new Error('Party ID belongs to another owner');
        if (row && live.includes(row.state)) { ack(); this.settleInvite(row.id); return true; }
        if (!row || row.state !== 'invited') {
          if (this.store.db.prepare("SELECT count(*) AS n FROM parties WHERE state='invited'").get().n >= MAX_INVITES) throw new Error('Too many open party invitations');
          this.store.db.prepare("INSERT OR REPLACE INTO parties (id,name,owner,state,revision,members,invitation,created) VALUES (?,?,?,'invited',0,?,?,?)").run(payload.party, event.name, peer.id, JSON.stringify(members), event.invitation, this.now());
        } else this.save(row.id, { name: event.name, members, invitation: event.invitation });
        return ack();
      }
      // A close for an invitation that never arrived needs no state, only a receipt.
      if (!row) { if (event.type === 'close') return ack(); throw new Error('Unknown party'); }
      if (['accept', 'decline', 'leave'].includes(event.type)) {
        if (row.owner !== this.me) throw new Error('Not the owner of this party');
        if (row.state !== 'active') return ack();
        if (event.type === 'leave') {
          if (!member(peer.id)) return ack();
          const next = this.without(row, peer.id);
          this.cancel(row.id, peer.id); this.publish(next);
          this.save(row.id, { members: next.members, cards: next.cards, revision: next.revision });
          return ack();
        }
        // Only an answer to the invitation still open counts.
        if (!row.invited.some(invite => invite.id === peer.id && invite.invitation === event.invitation)) return ack();
        const invited = row.invited.filter(invite => invite.id !== peer.id);
        if (event.type === 'decline') { this.save(row.id, { invited }); return ack(); }
        if (!verifyCard(peer.identity, event.card)) throw new Error('Invalid member card');
        const next = { ...row, invited, members: [...row.members, peer.identity], cards: { ...row.cards, [peer.id]: event.card }, revision: row.revision + 1 };
        this.publish(next);
        this.save(row.id, { invited, members: next.members, cards: next.cards, revision: next.revision });
        return ack();
      }
      if (row.owner !== peer.id) throw new Error('Only the owner changes a party');
      if (event.type === 'close') {
        if (row.state === 'invited' || live.includes(row.state)) { this.cancel(row.id); this.settleInvite(row.id); this.save(row.id, { state: 'closed' }); }
        return ack();
      }
      // members
      if (!live.includes(row.state) || event.revision <= row.revision) return ack();
      const members = event.members.map(entry => ({ ...entry, identity: validateIdentity(entry.identity) }));
      if (!members.some(entry => entry.identity.id === peer.id) || new Set(members.map(entry => entry.identity.id)).size !== members.length) throw new Error('Invalid party membership');
      if (members.some(entry => !verifyCard(entry.identity, entry.card))) throw new Error('A member card does not match its identity');
      if (!members.some(entry => entry.identity.id === this.me)) {
        this.cancel(row.id);
        this.save(row.id, { state: 'removed', revision: event.revision, members: members.map(entry => entry.identity) });
        return ack();
      }
      for (const entry of members) if (entry.identity.id !== this.me && entry.identity.id !== peer.id) this.store.introduce(entry.identity, endpoint(entry.endpoint, this.local));
      for (const old of row.members) if (!members.some(entry => entry.identity.id === old.id)) this.cancel(row.id, old.id);
      this.save(row.id, { state: 'active', name: event.name, revision: event.revision, members: members.map(entry => entry.identity) });
      return ack();
    });
  }
}
