import { VERSION } from './version.js';
import { NOTES } from './release-notes.js';

const FORMULA = 'https://raw.githubusercontent.com/imprintsystems/homebrew-tap/main/Formula/clanker.rb';
const DAY = 86_400_000, HOUR = 3_600_000;

export function newer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Tracks two pieces of news for the person: "you were just updated" and
// "a newer version exists". Each is handed out once, then marked shown.
export class Updates {
  constructor(store, { check = false, fetch = globalThis.fetch, now = Date.now } = {}) {
    this.store = store; this.check = check; this.fetch = fetch; this.now = now;
  }
  // Returns true after an upgrade. Inboxes from before 0.3.1 stored no version.
  start() {
    const previous = this.store.get('version') ?? (this.store.fresh ? null : 'older');
    if (previous === VERSION) return false;
    this.store.set('version', VERSION);
    if (!previous || !newer(VERSION, previous === 'older' ? '0.0.0' : previous)) return false;
    this.store.set('updated', { from: previous === 'older' ? null : previous, to: VERSION, shown: false });
    return true;
  }
  // Asks GitHub for the newest tap version at most once a day. Nothing about
  // the user is sent; a failure retries an hour later.
  async tick() {
    if (!this.check || this.busy || this.now() < this.nextCheck) return;
    const last = this.store.get('latest');
    if (last && this.now() - last.checkedAt < DAY) { this.nextCheck = last.checkedAt + DAY; return; }
    this.busy = true;
    try {
      const response = await this.fetch(FORMULA, { signal: AbortSignal.timeout(10_000) });
      const version = response.ok ? (await response.text()).match(/^\s*version "(\d+\.\d+\.\d+)"/m)?.[1] : undefined;
      if (!version) throw new Error('No version in formula');
      this.store.set('latest', { version, checkedAt: this.now(), shown: last?.version === version && !!last.shown });
    } catch {
      this.store.set('latest', { ...last, checkedAt: this.now() - DAY + HOUR });
    } finally { this.busy = false; }
  }
  // The pending notice, if any. consume marks it shown.
  notice(consume = false) {
    const updated = this.store.get('updated');
    if (updated && !updated.shown && updated.to === VERSION) {
      if (consume) this.store.set('updated', { ...updated, shown: true });
      return { updatedTo: VERSION, news: NOTES[VERSION] || [] };
    }
    const latest = this.store.get('latest');
    if (latest?.version && !latest.shown && newer(latest.version, VERSION)) {
      if (consume) this.store.set('latest', { ...latest, shown: true });
      return { available: latest.version, how: 'brew upgrade clanker' };
    }
    return null;
  }
}
