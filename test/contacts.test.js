import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { newIdentity } from '../src/protocol.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cc-contacts-')); const store = new Store(home, 'Erik');
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const add = name => { const identity = newIdentity(name).public; store.savePeer(identity, 'https://synthetic.trycloudflare.com'); return identity.id; };
  return { home, store, add };
}

test('nicknames resolve before contact names, stay unique, and resolve "<name>\'s clanker"', t => {
  const { store, add } = fixture(t);
  const david = add('David'), other = add('David'), sam = add('Sam');
  assert.throws(() => store.peer('David'), /Several contacts are called David/);
  store.nickname(other, 'Work David');
  assert.equal(store.peer("work david's clanker").id, other);
  assert.throws(() => store.peer('David'), /Several/, 'a nickname does not hide a contact\'s own name');
  store.nickname(david, 'Sam');
  assert.equal(store.peer('Sam').id, david, 'a nickname wins over another contact\'s own name');
  assert.equal(store.peer(sam).id, sam, 'a full ID always wins');
  assert.throws(() => store.nickname(sam, 'sam'), /already has the nickname/);
  assert.equal(store.peer('Sam’s agent').id, david);
  store.nickname('Sam', null);
  store.introduce(newIdentity('Sam').public, 'https://synthetic.trycloudflare.com');
  assert.equal(store.peer('Sam').id, sam, 'someone met through a party cannot shadow a paired contact');
  assert.throws(() => store.peer("Nobody's clanker"), /Unknown contact/);
});

test('a database from before nicknames gains the column without losing contacts', t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-contacts-old-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const legacy = new DatabaseSync(join(home, 'inbox.db'));
  const identity = newIdentity('David').public;
  legacy.exec('CREATE TABLE peers (id TEXT PRIMARY KEY, identity TEXT NOT NULL, endpoint TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, announced INTEGER NOT NULL DEFAULT 0)');
  legacy.prepare('INSERT INTO peers (id,identity,endpoint) VALUES (?,?,?)').run(identity.id, JSON.stringify(identity), 'https://synthetic.trycloudflare.com');
  legacy.close();
  const store = new Store(home, 'Erik'); t.after(() => store.close());
  assert.equal(store.peer('David').id, identity.id);
  store.nickname('David', 'Dave');
  assert.equal(store.peer('Dave').id, identity.id);
});
