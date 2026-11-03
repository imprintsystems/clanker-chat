import { localCall } from '../local.js';
import { inboxNoteRpc, noteConnectionKey } from './opencode-note.js';

// OpenCode 2 TUI plugin: count-only notices. Only a displayed boundary crosses
// the location-scoped host RPC; previews are fetched by the server on owner work.
export default function clankerToasts(ctx, connection) {
  let boundary = 0, polling = false, stopped = false;
  const signalDisplay = async value => {
    try {
      await ctx.client.rpc(inboxNoteRpc).displayed({ boundary: value, connection: noteConnectionKey(connection) },
        { location: ctx.location ?? ctx.data.location.default(), signal: AbortSignal.timeout(500) });
    } catch { /* A missing/offline server never prevents native count notices. */ }
  };
  const dispose = () => { stopped = true; clearInterval(timer); };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const status = await localCall(connection.home, 'status', {}, connection);
      if (stopped) return;
      const { latest, unread, unreadFirst } = status;
      if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(unread) || !Number.isSafeInteger(unreadFirst) || unread < 0 || unreadFirst < 0) return;
      if (!unread) { if (boundary) await signalDisplay(0); boundary = 0; return; }
      if (unreadFirst <= boundary || latest <= boundary) return;
      ctx.ui.toast.show({ message: `Clanker Chat · ${unread} unread`, variant: 'info', duration: 10000 });
      boundary = latest;
      await signalDisplay(latest);
    } catch (error) {
      if (error.message?.startsWith('This agent is not connected to Clanker Chat.')) dispose();
    } finally { polling = false; }
  };
  const timer = setInterval(poll, 2000);
  timer.unref?.();
  void poll();
  return dispose;
}
