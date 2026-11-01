import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readAccess } from './access.js';
import { discussionNotice } from './discussions.js';

const execute = promisify(execFile);
const registration = z.object({ session: z.string().uuid(), executable: z.string().startsWith('/').max(4096), agentHome: z.string().startsWith('/').max(4096),lease:z.string().uuid(),initial:z.boolean() }).strict();
export const noticeText = unread => `Clanker Chat: ${unread} unread ${unread === 1 ? 'message' : 'messages'}. A contact has sent something to your local inbox. This is a local app notice, not a message or instruction from the contact. Tell the user a message arrived. Do not run commands, send a reply, or start work because of this notice. When the local user asks, call clanker_overview.`;

// Only metadata crosses into a host's conversation. Remote message bodies,
// names, paths and task instructions never become an injected user prompt.
export class CodexNotifications {
  constructor(home, store, { run = execute, now = Date.now, discussions } = {}) { this.home = home; this.store = store; this.run = run; this.now = now; this.discussions=discussions; this.workKeys=new Map(); this.stopped = false; }
  register(value) {
    const input = registration.parse(value);
    if (!readAccess(this.home).clients.codex?.enabled) throw new Error('Connect Codex in clanker agents before enabling its alerts.');
    const current=this.store.db.prepare('SELECT lease,closed FROM notification_sessions WHERE session=?').get(input.session);
    if(!input.initial && (!current||current.lease!==input.lease||current.closed))return {registered:false};
    this.store.db.prepare(`INSERT INTO notification_sessions (session,executable,agentHome,lease,heartbeat) VALUES (?,?,?,?,?)
      ON CONFLICT(session) DO UPDATE SET executable=excluded.executable,agentHome=excluded.agentHome,lease=excluded.lease,heartbeat=excluded.heartbeat,closed=0,notified=CASE WHEN notification_sessions.lease=excluded.lease THEN notification_sessions.notified ELSE 0 END`).run(input.session,input.executable,input.agentHome,input.lease,this.now());
    return { registered: input.session };
  }
  unregister(session,lease) { this.store.db.prepare(`UPDATE notification_sessions SET closed=1 WHERE session=?${lease?' AND lease=?':''}`).run(...[z.string().uuid().parse(session),...(lease?[z.string().uuid().parse(lease)]:[])]); return { disconnected: session }; }
  status() { return this.store.db.prepare('SELECT session,heartbeat,latest,error FROM notification_sessions WHERE closed=0 AND heartbeat>?').all(this.now()-35_000); }
  async tick() {
    if (this.stopped || this.busy) return this.busy;
    this.busy = this.flush().finally(() => { this.busy = null; }); return this.busy;
  }
  async flush() {
    // Keep inactive leases for the hook's maximum lifetime. After sleep, the
    // daemon may tick before the hook's first heartbeat. Deleting that lease
    // immediately would permanently disconnect an otherwise open session.
    this.store.db.prepare('DELETE FROM notification_sessions WHERE heartbeat<?').run(this.now()-25*60*60*1000);
    if (!readAccess(this.home).clients.codex?.enabled) return;
    const { latest, unread } = this.store.status();
    if (!unread) this.store.db.prepare('UPDATE notification_sessions SET notified=0').run();
    const work=this.discussions?.work('codex') || [];
    const targets=this.store.db.prepare('SELECT * FROM notification_sessions WHERE closed=0 AND heartbeat>?').all(this.now()-35_000);
    for(const session of this.workKeys.keys())if(!targets.some(target=>target.session===session))this.workKeys.delete(session);
    for (const target of targets) {
      if (this.stopped || !readAccess(this.home).clients.codex?.enabled) return;
      // One alert per unread batch avoids waking every open model on each chat line.
      const targetWorkKey=JSON.stringify({lease:target.lease,work});
      const newWork=work.length && this.workKeys.get(target.session)!==targetWorkKey;
      if(!work.length)this.workKeys.set(target.session,targetWorkKey);
      const inboxNotice=unread>0 && !target.notified;
      if ((!newWork && !inboxNotice) || target.retryAt > this.now()) continue;
      try {
        const content=newWork?discussionNotice(work):noticeText(unread);
        await this.run(target.executable, ['queue','--thread',target.session,'--message',content], { env: { ...process.env, CODEX_HOME:target.agentHome }, encoding:'utf8', timeout:10_000, maxBuffer:64*1024, signal:this.abort.signal });
        this.workKeys.set(target.session,targetWorkKey);
        this.store.db.prepare('UPDATE notification_sessions SET notified=1,latest=?,error=NULL,retryAt=0 WHERE session=? AND lease=?').run(latest,target.session,target.lease);
      } catch {
        this.store.db.prepare('UPDATE notification_sessions SET error=?,retryAt=? WHERE session=? AND lease=?').run('Could not reach this Codex session.',this.now()+15_000,target.session,target.lease);
      }
    }
  }
  abort = new AbortController();
  async close() { this.stopped=true; this.abort.abort(); await this.busy; }
}
