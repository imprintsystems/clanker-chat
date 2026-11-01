import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Store } from './store.js';
import { endpoint, encodeInvite, decodeInvite, messageSchema, open, openPair, seal, post, text } from './protocol.js';
import { socketPath, readJSON, json } from './local.js';
import { authorizeClient } from './access.js';
import { VERSION } from './version.js';
import { CodexNotifications } from './notifications.js';
import { Discussions } from './discussions.js';
import { overview, fullMessage, summarize, peerNames } from './overview.js';
import { Updates } from './updates.js';

const sendSchema = z.object({ to: z.string().min(1), text, kind: z.enum(['message', 'session', 'task_request']).default('message'), thread: z.string().uuid().optional(), replyTo: z.string().uuid().optional() }).strict();
const listSchema = z.object({ unread: z.boolean().optional(), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(), direction: z.enum(['in', 'out']).optional(), preview: z.boolean().optional() }).strict();
const peerName = z.string().min(1).max(100);
const messageId = z.string().uuid();

export class ClankerChat extends EventEmitter {
  constructor(options) { super(); this.options = options; this.busy = null; this.stopping = false; this.endpointReady = false; }
  async start() {
    const { home, name, port = 0, local = false } = this.options;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (existsSync(socketPath(home))) {
      const live = await new Promise(resolve => {
        const client = net.connect(socketPath(home));
        client.once('connect', () => { client.destroy(); resolve(true); });
        client.once('error', error => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
      });
      if (live) throw new Error('Daemon already running (or socket inaccessible)');
      unlinkSync(socketPath(home));
    }
    this.admin = http.createServer((req, res) => this.adminRequest(req, res));
    await listen(this.admin, socketPath(home));
    chmodSync(socketPath(home), 0o600);
    try {
      this.store = new Store(home, name);
      this.discussions = new Discussions(home, this.store, this.options.discussions);
      this.notifications = new CodexNotifications(home, this.store, { ...this.options.notifications, discussions:this.discussions });
      this.updates = new Updates(this.store, { check: !!this.options.updateCheck, ...this.options.updates });
      this.upgraded = this.updates.start();
      this.remote = http.createServer((req, res) => this.remoteRequest(req, res));
      this.remote.requestTimeout = 15_000; this.remote.headersTimeout = 10_000; this.remote.maxConnections = 32;
      await listen(this.remote, { host: '127.0.0.1', port });
      this.port = this.remote.address().port;
      this.endpointReady = false;
      if (local) this.setEndpoint(`http://127.0.0.1:${this.port}`);
      else await this.startTunnel();
      if (this.stopping) throw new Error('Daemon stopped during startup');
      this.timer = setInterval(() => this.tick(), 2_000);
      this.notificationTimer = setInterval(() => { this.notifications.tick().catch(error => this.emit('warning', error.message)); this.updates.tick().catch(() => {}); }, 2_000);
      this.tick();
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  setEndpoint(value) { this.origin = endpoint(value, this.options.local); this.store.set('endpoint', this.origin); this.endpointReady = true; }
  async startTunnel() {
    await new Promise((resolve, reject) => {
      let logs = ''; let ready = false;
      const child = spawn(this.options.cloudflared || 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.tunnel = child;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Tunnel startup timed out')); }, 45_000);
      const consume = data => {
        logs = (logs + data.toString()).slice(-8192);
        this.tunnelLog = logs;
        const match = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !ready) { ready = true; clearTimeout(timeout); this.setEndpoint(match[0]); resolve(); }
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('cloudflared could not start. Install it with brew install cloudflared, or use start --local for local testing.')); });
      child.once('exit', () => {
        clearTimeout(timeout); this.endpointReady = false;
        if (!ready) reject(new Error('cloudflared exited before creating a tunnel. Check its configuration and network access.'));
        else if (!this.stopping) { this.emit('warning', 'Tunnel stopped. The background service will restart; foreground users can run start again.'); this.emit('tunnelStopped'); }
      });
    });
  }
  async remoteRequest(req, res) {
    try {
      if (req.method !== 'POST' || !['/v1/pair', '/v1/messages', '/v1/announce'].includes(req.url)) return json(res, 404, { error: 'Not found' });
      const now = Date.now();
      if (!this.rate || now - this.rate.at > 60_000) this.rate = { at: now, count: 0, pair: 0 };
      if (++this.rate.count > 120 || (req.url === '/v1/pair' && ++this.rate.pair > 10)) return json(res, 429, { error: 'Try later' });
      const envelope = await readJSON(req);
      if (req.url === '/v1/pair') {
        const { data, sender } = openPair(this.store.identity, envelope);
        const pair = z.object({ identity: z.unknown(), endpoint: z.string().max(256), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
        if (sender.id === this.store.identity.public.id) throw new Error('Cannot pair with yourself');
        this.store.acceptInvite(pair.token, sender, endpoint(pair.endpoint, this.options.local));
        this.emit('paired', sender);
        return json(res, 200, seal(this.store.identity, sender, 'receipt', { requestId: envelope.id, paired: true }));
      }
      const peer = this.store.peer(envelope.sender);
      if (peer.revoked) throw new Error('Peer revoked');
      if (req.url === '/v1/messages') {
        const message = messageSchema.parse(open(this.store.identity, envelope, peer.identity, 'message'));
        const inserted = message.kind === 'discussion' ? this.discussions.receive(peer.id,message) : this.store.insert(peer.id, 'in', message);
        if (inserted) this.emit('message', { peer: peer.identity.name, id: message.id });
        return json(res, 200, seal(this.store.identity, peer.identity, 'receipt', { requestId: envelope.id, messageId: message.id }));
      }
      const data = z.object({ endpoint: z.string().max(256) }).strict().parse(open(this.store.identity, envelope, peer.identity, 'announce'));
      const origin = endpoint(data.endpoint, this.options.local);
      if (envelope.at > peer.announced) this.store.db.prepare('UPDATE peers SET endpoint=?,announced=? WHERE id=?').run(origin, envelope.at, peer.id);
      return json(res, 200, seal(this.store.identity, peer.identity, 'receipt', { requestId: envelope.id, updated: true }));
    } catch { json(res, 400, { error: 'Request rejected' }); }
  }
  async adminRequest(req, res) {
    try {
      if (req.method !== 'POST' || req.url !== '/local') return json(res, 404, { error: 'Not found' });
      if (!this.store) return json(res, 503, { error: 'Daemon starting' });
      if (req.headers['x-clanker-origin'] === 'mcp') authorizeClient(this.options.home, req.headers['x-clanker-client'], req.headers['x-clanker-token']);
      const input = z.object({ command: z.string(), args: z.record(z.string(), z.unknown()) }).strict().parse(await readJSON(req));
      if(req.headers['x-clanker-origin']==='mcp' && ['notification_register','notification_unregister','notifications'].includes(input.command))throw new Error('Session alert registrations are managed by the local user, not MCP tools.');
      const actor = req.headers['x-clanker-origin'] === 'mcp' ? { client:req.headers['x-clanker-client'], worker:z.string().uuid().optional().parse(req.headers['x-clanker-worker']) } : undefined;
      const result = await this.command(input.command, input.args, actor);
      if (req.headers['x-clanker-origin'] === 'mcp') authorizeClient(this.options.home, req.headers['x-clanker-client'], req.headers['x-clanker-token']);
      json(res, 200, result);
    } catch (error) { json(res, 400, { error: error.message }); }
  }
  async command(command, args = {}, actor) {
    switch (command) {
      case 'discussion_start': { const result=this.discussions.propose(args,actor);this.tick();return result; }
      case 'discussion_get': return this.discussions.get(args.id,actor);
      case 'discussion_list': return this.discussions.list(actor);
      case 'discussion_accept': { const result=this.discussions.accept(args.id,args.client,actor);this.tick();this.emit('message');return result; }
      case 'discussion_stop': { const result=this.discussions.stop(args.id,args.reason,actor);this.tick();this.emit('message');return result; }
      case 'discussion_reply': { const result=this.discussions.reply(args,actor);this.tick();this.emit('message');return result; }
      case 'discussion_work': return this.discussions.work(actor?.client || z.string().parse(args.client),actor?.worker);
      case 'discussion_next': {
        const id=z.string().uuid().parse(args.id);const seconds=z.number().min(0).max(20).default(0).parse(args.seconds);
        let result=this.discussions.next(id,actor);
        if(seconds && result.action==='wait') {
          await new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.off('message',done);this.off('closing',done);resolve();};const timer=setTimeout(done,seconds*1000);this.once('message',done);this.once('closing',done);});
          result=this.discussions.next(id,actor);
        }
        return result;
      }
      case 'notification_register': return this.notifications.register(args);
      case 'notification_unregister': return this.notifications.unregister(args.session,args.lease);
      case 'notifications': return this.notifications.status();
      case 'status': return { ...this.store.status(), online: this.endpointReady, version: VERSION };
      case 'overview': return overview(this.store, this.discussions, { online: this.endpointReady, update: this.updates.notice(args.consume !== false) });
      case 'message': return fullMessage(this.store, messageId.parse(args.id));
      case 'peers': return this.store.peers();
      case 'invite': {
        if (!this.endpointReady) throw new Error('Tunnel is not running');
        const invite = this.store.invite();
        return { code: encodeInvite({ v: 1, identity: this.store.identity.public, endpoint: this.origin, ...invite }), expires: invite.expires };
      }
      case 'pair': {
        if (!this.endpointReady) throw new Error('Tunnel is not running');
        const invite = decodeInvite(z.string().parse(args.code), this.options.local);
        if (invite.identity.id === this.store.identity.public.id) throw new Error('Cannot pair with yourself');
        const existing = this.store.peers().find(p => p.id === invite.identity.id);
        if (existing?.revoked) throw new Error('Peer revoked locally');
        if (existing && existing.identity.boxKey !== invite.identity.boxKey) throw new Error('Peer encryption key changed');
        const envelope = seal(this.store.identity, invite.identity, 'pair', { identity: this.store.identity.public, endpoint: this.origin, token: invite.token });
        const response = open(this.store.identity, await post(invite.endpoint, '/v1/pair', envelope, this.options.local), invite.identity, 'receipt');
        if (response.requestId !== envelope.id || response.paired !== true) throw new Error('Invalid pairing receipt');
        this.store.savePeer(invite.identity, invite.endpoint);
        this.store.db.prepare("UPDATE messages SET retryAt=0 WHERE peer=? AND state='queued'").run(invite.identity.id);
        this.tick();
        return { paired: invite.identity };
      }
      case 'send': {
        const input = sendSchema.parse(args); const peer = this.store.peer(input.to);
        if (peer.revoked) throw new Error('Peer revoked');
        const payload = messageSchema.parse({ id: randomUUID(), kind: input.kind, text: input.text, thread: input.thread || randomUUID(), ...(input.replyTo ? { replyTo: input.replyTo } : {}), createdAt: Date.now() });
        this.store.insert(peer.id, 'out', payload); this.tick();
        return { id: payload.id, thread: payload.thread, state: 'queued' };
      }
      case 'inbox': { const { preview, ...query } = listSchema.parse(args); return this.list(query, preview); }
      case 'read': {
        const id = messageId.parse(args.id);
        const result = this.store.db.prepare("UPDATE messages SET read=1 WHERE id=? AND direction='in'").run(id);
        if (!result.changes) throw new Error('Message not found');
        return { read: id };
      }
      case 'wait': {
        const after = z.number().int().nonnegative().default(0).parse(args.after);
        const seconds = z.number().min(0).max(20).default(20).parse(args.seconds);
        const preview = z.boolean().optional().parse(args.preview);
        const rows = this.list({ after }, preview);
        if (rows.length) return rows;
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); this.off('message', done); this.off('closing', done); resolve(); };
          const timer = setTimeout(done, seconds * 1000); this.once('message', done); this.once('closing', done);
        });
        return this.list({ after }, preview);
      }
      case 'revoke': return this.store.revoke(peerName.parse(args.peer));
      case 'decide': {
        const id = messageId.parse(args.id); const decision = z.enum(['approved', 'declined']).parse(args.decision);
        const row = this.store.db.prepare("SELECT * FROM messages WHERE id=? AND direction='in'").get(id);
        if (!row || JSON.parse(row.payload).kind !== 'task_request' || row.decision !== 'pending') throw new Error('Pending task request not found');
        this.store.db.prepare('UPDATE messages SET decision=? WHERE id=?').run(decision, id);
        return { id, decision };
      }
      case 'complete': {
        const id = messageId.parse(args.id); const result = text.parse(args.text);
        const row = this.store.db.prepare("SELECT * FROM messages WHERE id=? AND direction='in'").get(id);
        if (!row || row.decision !== 'approved' || JSON.parse(row.payload).kind !== 'task_request') throw new Error('Task needs local approval before a result can be sent');
        const peer = this.store.peer(row.peer); if (peer.revoked) throw new Error('Peer revoked');
        const request = JSON.parse(row.payload);
        const payload = { id: randomUUID(), kind: 'task_result', text: result, thread: request.thread, replyTo: id, createdAt: Date.now() };
        this.store.db.exec('BEGIN IMMEDIATE');
        try { this.store.insert(peer.id, 'out', payload); this.store.db.prepare("UPDATE messages SET decision='completed' WHERE id=?").run(id); this.store.db.exec('COMMIT'); }
        catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
        this.tick(); return { id: payload.id, state: 'queued' };
      }
      case 'retry': this.store.db.prepare("UPDATE messages SET retryAt=0 WHERE state='queued'").run(); this.tick(); return { retrying: true };
      default: throw new Error('Unknown command');
    }
  }
  list(query, preview) {
    const rows = this.store.list(query);
    if (!preview) return rows;
    const names = peerNames(this.store);
    return rows.map(row => summarize(row, names));
  }
  tick() {
    if (this.busy || this.stopping || !this.endpointReady) return this.busy;
    this.busy = this.flush().catch(error => this.emit('warning', error.message)).finally(() => { this.busy = null; });
    return this.busy;
  }
  async flush() {
    this.discussions.expire();
    // Re-announce periodically so a friend that kept their endpoint can learn a
    // replacement address after our Quick Tunnel restarts.
    if (!this.lastAnnounce || Date.now() - this.lastAnnounce > 30_000) {
      this.lastAnnounce = Date.now();
      for (const peer of this.store.peers().filter(p => !p.revoked)) {
        if (this.stopping) return;
        try {
          const envelope = seal(this.store.identity, peer.identity, 'announce', { endpoint: this.origin });
          const receipt = open(this.store.identity, await post(peer.endpoint, '/v1/announce', envelope, this.options.local), peer.identity, 'receipt');
          if (receipt.requestId !== envelope.id || receipt.updated !== true) throw new Error('Invalid address receipt');
        } catch { /* An offline friend will be retried on the next announcement. */ }
      }
    }
    for (const row of this.store.queued()) {
      if (this.stopping) return;
      try {
        if (this.store.db.prepare('SELECT state FROM messages WHERE id=?').get(row.id)?.state !== 'queued') continue;
        // A prior control event must be delivered before a later discussion turn.
        if (row.payload.kind === 'discussion' && this.store.db.prepare("SELECT 1 FROM messages WHERE peer=? AND direction='out' AND state='queued' AND seq<? AND json_extract(payload,'$.thread')=? LIMIT 1").get(row.peer,row.seq,row.payload.thread)) continue;
        const peer = this.store.peer(row.peer); if (peer.revoked) continue;
        const envelope = seal(this.store.identity, peer.identity, 'message', row.payload);
        const receipt = open(this.store.identity, await post(peer.endpoint, '/v1/messages', envelope, this.options.local), peer.identity, 'receipt');
        if (receipt.requestId !== envelope.id || receipt.messageId !== row.id) throw new Error('Invalid delivery receipt');
        this.store.db.prepare("UPDATE messages SET state='delivered',error=NULL WHERE id=? AND state='queued'").run(row.id);
      } catch (error) {
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(row.attempts, 5));
        this.store.db.prepare("UPDATE messages SET attempts=attempts+1,retryAt=?,error=? WHERE id=?").run(Date.now() + delay, error.message.slice(0, 200), row.id);
      }
    }
  }
  close() {
    this.closing ||= this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    this.stopping = true; clearInterval(this.timer); this.emit('closing');
    clearInterval(this.notificationTimer); await this.notifications?.close();
    this.tunnel?.kill();
    const closes = [this.admin, this.remote].filter(Boolean).map(server => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
    await this.busy;
    await Promise.all(closes);
    this.store?.close();
  }
}
function listen(server, address) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); }); }
