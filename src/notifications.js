import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readAccess, readAccessAsync } from './access.js';
import { discussionNotice } from './discussions.js';
import { inboxNote } from './overview.js';
import { displayText } from './display.js';

const execute = promisify(execFile);
const registration = z.object({ session: z.string().uuid(), executable: z.string().startsWith('/').max(4096), agentHome: z.string().startsWith('/').max(4096),lease:z.string().uuid(),initial:z.boolean() }).strict();

// Routine inbox awareness rides on a normal user prompt, never a queued turn.
// Only already accepted discussion work may request a model turn.
export class Notifications {
  constructor(home, store, { run = execute, now = Date.now, discussions } = {}) { this.home = home; this.store = store; this.run = run; this.now = now; this.discussions=discussions; this.workKeys=new Map(); this.stopped = false; }
  register(value) {
    const input = registration.parse(value);
    if (!readAccess(this.home).clients.codex?.enabled) throw new Error('Connect Codex in clanker agents before enabling its alerts.');
    const current=this.store.prepare('SELECT lease,closed FROM notification_sessions WHERE session=?').get(input.session);
    if(!input.initial && (!current||current.lease!==input.lease||current.closed))return {registered:false};
    this.store.prepare(`INSERT INTO notification_sessions (session,executable,agentHome,lease,heartbeat) VALUES (?,?,?,?,?)
      ON CONFLICT(session) DO UPDATE SET executable=excluded.executable,agentHome=excluded.agentHome,lease=excluded.lease,heartbeat=excluded.heartbeat,closed=0`).run(input.session,input.executable,input.agentHome,input.lease,this.now());
    return { registered: input.session };
  }
  unregister(value) {
    const {client,session,lease}=z.object({client:z.enum(['codex','claude']),session:z.string().uuid(),lease:z.string().uuid().optional()}).strict().parse(value);
    const result=client==='codex' ? this.store.prepare(`UPDATE notification_sessions SET closed=1 WHERE session=?${lease?' AND lease=?':''}`).run(session,...(lease?[lease]:[])) : null;
    if(client==='claude' || result.changes || !lease)this.store.prepare('DELETE FROM notification_notices WHERE client=? AND session=?').run(client,session);
    return { disconnected: session };
  }
  notice(value) {
    const {client,session}=z.object({client:z.enum(['codex','claude']),session:z.string().uuid()}).strict().parse(value);
    const access = readAccess(this.home);
    if(this.stopped || !access.clients[client]?.enabled)return {};
    const {unread,latest}=this.store.status();
    if(!unread){this.store.prepare('DELETE FROM notification_notices').run();return {};}
    // Build context first: a formatter error must not consume the display claim.
    const additionalContext = access.agentNote ? inboxNote(this.store, latest) : undefined;
    // Independent of async SessionStart; unread boundaries also survive a clear
    // and a new arrival between ticks, without observing an intermediate zero.
    const claimed=this.store.prepare(`INSERT INTO notification_notices(client,session,boundary,shown) VALUES (?,?,?,?)
      ON CONFLICT(client,session) DO UPDATE SET boundary=excluded.boundary,shown=excluded.shown
      WHERE NOT EXISTS (SELECT 1 FROM messages WHERE direction='in' AND read=0 AND seq<=notification_notices.boundary)`).run(client,session,latest,this.now());
    if (!claimed.changes) return {};
    return { systemMessage: `Clanker Chat · ${unread} unread`, ...(additionalContext ? { additionalContext } : {}) };
  }
  context(value, client) {
    const { boundary } = z.object({ boundary: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(value);
    const access = readAccess(this.home);
    if (this.stopped || !access.agentNote || !access.clients[client]?.enabled) return {};
    const additionalContext = inboxNote(this.store, boundary);
    return additionalContext ? { additionalContext } : {};
  }
  status() { return this.store.prepare('SELECT session,heartbeat,latest,error FROM notification_sessions WHERE closed=0 AND heartbeat>?').all(this.now()-35_000); }
  async tick() {
    if (this.stopped || this.busy) return this.busy;
    this.busy = this.flush().finally(() => { this.busy = null; }); return this.busy;
  }
  async flush() {
    // Keep inactive leases for the hook's maximum lifetime. After sleep, the
    // daemon may tick before the hook's first heartbeat. Deleting that lease
    // immediately would permanently disconnect an otherwise open session.
    this.store.prepare('DELETE FROM notification_sessions WHERE heartbeat<?').run(this.now()-25*60*60*1000);
    const { latest, unread } = this.store.status();
    if (!unread) this.store.prepare('DELETE FROM notification_notices').run();
    if (!(await readAccessAsync(this.home)).clients.codex?.enabled || this.stopped) return;
    const work=this.discussions?.work('codex') || [], workKey=JSON.stringify(work);
    const targets=this.store.prepare('SELECT * FROM notification_sessions WHERE closed=0 AND heartbeat>?').all(this.now()-35_000);
    const sessions=new Set(targets.map(target=>target.session));
    for(const session of this.workKeys.keys())if(!sessions.has(session))this.workKeys.delete(session);
    let content;
    for (const target of targets) {
      if (!(await readAccessAsync(this.home)).clients.codex?.enabled || this.stopped) return;
      const targetWorkKey=`${target.lease}:${workKey}`;
      const newWork=work.length && this.workKeys.get(target.session)!==targetWorkKey;
      if(!work.length)this.workKeys.set(target.session,targetWorkKey);
      if (!newWork || target.retryAt > this.now()) continue;
      try {
        content ??= displayText(discussionNotice(work), { multiline: true });
        await this.run(target.executable, ['queue','--thread',target.session,'--message',content], { env: { ...process.env, CODEX_HOME:target.agentHome }, encoding:'utf8', timeout:10_000, maxBuffer:64*1024, signal:this.abort.signal });
        this.workKeys.set(target.session,targetWorkKey);
        this.store.prepare('UPDATE notification_sessions SET latest=?,error=NULL,retryAt=0 WHERE session=? AND lease=?').run(latest,target.session,target.lease);
      } catch {
        this.store.prepare('UPDATE notification_sessions SET error=?,retryAt=? WHERE session=? AND lease=?').run('Could not reach this Codex session.',this.now()+15_000,target.session,target.lease);
      }
    }
  }
  abort = new AbortController();
  async close() { this.stopped=true; this.abort.abort(); await this.busy; }
}
