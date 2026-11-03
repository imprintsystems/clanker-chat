import { localCall } from '../local.js';
import { discussionNotice } from '../discussions.js';

// OpenCode 2 server plugin. Ordinary arrivals belong to the display-only TUI part.
export default async function clankerDiscussions(ctx, connection) {
  if (process.env.CLANKER_BRIDGE_RUN) return () => {};
  const bindings = new Map(), sessions = new Set(), busy = new Set(), delivered = new Map();
  const controller = new AbortController();
  let polling = false, stopped = false;
  const directory = ctx.location.directory;
  const valid = work => Array.isArray(work) && work.length <= 100 && work.every(item => item && /^[0-9a-f-]{36}$/i.test(item.id) && Number.isSafeInteger(item.revision) && item.revision > 0 && ['turn', 'result'].includes(item.kind));
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const work = await localCall(connection.home, 'discussion_work', {}, connection);
      if (!valid(work) || stopped) return;
      const pending = new Map();
      for (const item of work) {
        const sessionID = bindings.get(item.id), key = `${item.revision}:${item.kind}`;
        if (!sessionID || busy.has(sessionID) || delivered.get(item.id) === key) continue;
        if (!pending.has(sessionID)) pending.set(sessionID, []);
        pending.get(sessionID).push(item);
      }
      for (const [sessionID, items] of pending) {
        if (stopped || busy.has(sessionID)) continue;
        const session = await ctx.session.get({ sessionID });
        if (stopped || session.location.directory !== directory) continue;
        busy.add(sessionID);
        try {
          // Admission uses the session's current agent/model; never a recent chat.
          await ctx.session.prompt({ sessionID, text: discussionNotice(items), delivery: 'queue', resume: true,
            metadata: { source: 'clanker-chat' } }, { signal: controller.signal });
          for (const item of items) delivered.set(item.id, `${item.revision}:${item.kind}`);
        } catch (error) { busy.delete(sessionID); throw error; }
      }
    } catch (error) {
      if (error.message?.startsWith('This agent is not connected to Clanker Chat.')) dispose();
      // Offline inboxes can recover; revocation requires a fresh plugin instance.
    } finally { polling = false; }
  };
  const timer = setInterval(poll, 2000);
  timer.unref?.();
  const dispose = () => { stopped = true; clearInterval(timer); controller.abort(); bindings.clear(); sessions.clear(); busy.clear(); delivered.clear(); };
  await ctx.tool.hook('execute.after', async event => {
    if (stopped || event.status !== 'completed' || !['clanker_clanker_discussion_start', 'clanker_clanker_discussion_accept', 'clanker_clanker_discussion_next'].includes(event.tool)) return;
    try {
      const content = event.result.content;
      const text = typeof content === 'string' ? content : content?.length === 1 && content[0].type === 'text' ? content[0].text : '';
      const value = JSON.parse(text);
      if (event.tool === 'clanker_clanker_discussion_next' && value.action !== 'reply') return;
      if (!/^[0-9a-f-]{36}$/i.test(value.id || '') || value.client !== 'opencode' || !['active', 'proposed'].includes(value.state)) return;
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (stopped || session.location.directory !== directory) return;
      bindings.set(value.id, event.sessionID); sessions.add(event.sessionID); busy.add(event.sessionID);
    } catch { /* Failed/refused calls and another project's sessions cannot bind. */ }
  });
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal, types: ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted'] })) {
        const sessionID = event.data.sessionID;
        if (stopped || !sessions.has(sessionID) || (event.location && event.location.directory !== directory)) continue;
        if (event.type === 'session.execution.started') busy.add(sessionID);
        else if (event.type !== 'session.deleted') { busy.delete(sessionID); void poll(); }
        else if (event.type === 'session.deleted') {
          busy.delete(sessionID); sessions.delete(sessionID);
          for (const [discussion, session] of bindings) if (session === sessionID) { bindings.delete(discussion); delivered.delete(discussion); }
        }
      }
    } catch { /* The host closes the stream when the plugin unloads. */ }
  })();
  void poll();
  return dispose;
}
