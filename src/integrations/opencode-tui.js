import { localCall } from '../local.js';

// OpenCode 2 TUI plugin: metadata-only notices, with no model/session mutation.
export default function clankerToasts(ctx, connection) {
  let boundary = 0, polling = false, stopped = false;
  const dispose = () => { stopped = true; clearInterval(timer); };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const status = await localCall(connection.home, 'status', {}, connection);
      if (stopped) return;
      const { latest, unread, unreadFirst } = status;
      if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(unread) || !Number.isSafeInteger(unreadFirst) || unread < 0 || unreadFirst < 0) return;
      if (!unread) { boundary = 0; return; }
      if (unreadFirst <= boundary || latest <= boundary) return;
      ctx.ui.toast.show({ message: `Clanker Chat · ${unread} unread`, variant: 'info', duration: 10000 });
      boundary = latest;
    } catch (error) {
      if (error.message?.startsWith('This agent is not connected to Clanker Chat.')) dispose();
    } finally { polling = false; }
  };
  const timer = setInterval(poll, 2000);
  timer.unref?.();
  void poll();
  return dispose;
}
